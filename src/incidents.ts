import { createHash } from 'node:crypto'
import { MAX_INVESTIGATIONS, openIncident, proposalRevision } from './incident-contract.ts'
import { findAgent, findTerminal } from './orca.ts'
import { newRunId } from './state.ts'
import type { Effect, Incident, Observations, Proposal, Request, Run, State } from './types.ts'

export function attachIncident(run: Run, now: string): void {
  if (run.recovery === undefined) run.incident ??= openIncident(now)
}

function update(incident: Incident, status: Incident['status'], reason: string, now: string): void {
  incident.status = status
  incident.reason = reason.slice(0, 8000)
  incident.updatedAt = now
}

function fingerprint(proposal: Proposal): string {
  return createHash('sha256').update(JSON.stringify({ changes: proposal.changes.map(({ path, head }) => ({ path, head })).sort((a, b) => a.path.localeCompare(b.path)), actions: proposal.actions.map((action) => action.trim()).sort() })).digest('hex')
}

export function serveIncidentRequest(state: State, source: Run, request: Extract<Request, { type: 'investigate' | 'approve' }>, now: string): string | null {
  if (source.recovery !== undefined || source.phase.kind !== 'failed') return 'give the original failed run'
  source.incident ??= { ...openIncident(now), status: 'blocked', reason: 'existing failure, not investigated yet' }
  const incident = source.incident
  if (request.type === 'approve') {
    if (incident.status !== 'awaiting_approval' || incident.proposal?.revision !== request.revision) return 'does not match the revision awaiting approval'
    incident.approvedRevision = request.revision
    update(incident, 'applying', 'the specified proposal is approved, waiting to be applied', now)
    state.runs.push(recoveryRun(state, source, 'apply', now))
    return null
  }
  if (!['blocked', 'awaiting_approval'].includes(incident.status)) return 'cannot start an investigation for an incident that is under investigation, being applied or resolved'
  if (investigations(state, incident) >= MAX_INVESTIGATIONS) return `investigation limit of ${MAX_INVESTIGATIONS} reached`
  if (state.runs.some((run) => (run.id === source.id || run.recovery?.sourceRunId === source.id) && run.launchUncertain)) return 'launch or exit of an earlier run is unconfirmed; not re-investigating until its pane is recovered'
  const evidence = request.evidence.trim()
  if (incident.tasks.length > 0 && (evidence === '' || incident.evidence.includes(evidence))) return 'a new investigation needs added evidence different from the previous one'
  if (evidence !== '') incident.evidence.push(evidence)
  delete incident.proposal
  delete incident.approvedRevision
  update(incident, 'pending', 'waiting to investigate with the added evidence', now)
  return null
}

function recoveryRun(state: State, source: Run, stage: 'prepare' | 'apply', now: string): Run {
  const incident = source.incident!
  const id = newRunId(now, `recovery|${source.id}|${stage}|${incident.tasks.join('|')}|${incident.proposal?.revision ?? ''}|${state.runs.length}`, new Set(state.runs.map((run) => run.id)))
  const child: Run = {
    id, project: source.project, target: { ...source.target }, rule: { ...source.rule }, kindName: stage === 'prepare' ? 'Incident investigation' : 'Approved fix', items: structuredClone(source.items),
    createdAt: now, startedAt: null, phase: { kind: 'queued', since: now }, history: [{ kind: 'queued', at: now }], orca: null, notified: [], lastMessage: null, manual: true, bypassLimit: false,
    recovery: { sourceRunId: source.id, stage, evidence: [source.phase.kind === 'failed' ? source.phase.reason.slice(0, 8000) : source.phase.kind, ...incident.evidence], ...(stage === 'apply' ? { proposal: structuredClone(incident.proposal!) } : {}) },
  }
  incident.tasks.push(id)
  return child
}

function investigations(state: State, incident: Incident): number {
  return incident.tasks.filter((id) => state.runs.some((run) => run.id === id && run.recovery?.stage === 'prepare')).length
}

export function advanceIncidents(state: State, obs: Observations, effects: Effect[]): void {
  for (const source of [...state.runs]) {
    if (source.recovery !== undefined || source.phase.kind !== 'failed') continue
    if (source.incident === undefined) {
      source.incident = { ...openIncident(obs.now), status: 'blocked', reason: 'existing failure, not started automatically; orcapod investigate starts an investigation only' }
      continue
    }
    const incident = source.incident
    const latest = state.runs.find((run) => run.id === incident.tasks.at(-1))
    if (['investigating', 'applying'].includes(incident.status) && latest !== undefined) finishTask(state, source, latest, obs.now, effects)
    if (incident.status !== 'pending') continue
    if (source.launchUncertain) {
      update(incident, 'blocked', 'launch or exit of the original run is unconfirmed; not starting an investigation until its pane is recovered', obs.now)
      continue
    }
    if (investigations(state, incident) >= MAX_INVESTIGATIONS) {
      update(incident, 'blocked', `investigation limit of ${MAX_INVESTIGATIONS} reached; review the evidence and proposals`, obs.now)
      continue
    }
    state.runs.push(recoveryRun(state, source, 'prepare', obs.now))
    update(incident, 'investigating', 'investigating the failure path without rerunning the original work', obs.now)
  }
}

function finishTask(state: State, source: Run, task: Run, now: string, effects: Effect[]): void {
  const incident = source.incident!
  const phase = task.phase
  if (phase.kind !== 'done' && phase.kind !== 'failed' && phase.kind !== 'aborted') return
  if (phase.kind === 'done' && task.recovery?.stage === 'prepare' && task.recoveryResult?.proposal !== undefined) {
    const body = task.recoveryResult.proposal
    const key = fingerprint(body)
    if (incident.revisions.includes(key)) {
      update(incident, 'blocked', 'same fix or operation as an earlier proposal; not repeating it', now)
    } else {
      incident.revisions.push(key)
      incident.proposal = { revision: proposalRevision(body), body: structuredClone(body) }
      update(incident, 'awaiting_approval', 'review the cause, change, validation and post-approval operations', now)
    }
  } else if (phase.kind === 'done' && task.recovery?.stage === 'apply' && task.recoveryResult?.verification?.length && task.recovery.proposal?.revision === incident.approvedRevision) {
    update(incident, 'resolved', `applied and verified: ${task.recoveryResult.summary}`, now)
  } else {
    const reason = phase.kind === 'done' ? 'the required proposal or verification result is missing' : phase.reason
    const evidence = `${task.recovery?.stage}: ${reason.slice(0, 8000)}`
    const fresh = !incident.evidence.includes(evidence)
    if (fresh) incident.evidence.push(evidence)
    delete incident.approvedRevision
    delete incident.proposal
    const retry = task.recovery?.stage === 'apply' && phase.kind === 'failed' && phase.launchFailed !== true && fresh && investigations(state, incident) < MAX_INVESTIGATIONS
    update(incident, retry ? 'pending' : 'blocked', `recovery stopped: ${reason}`, now)
  }
  if (incident.status !== 'pending') effects.push({ type: 'notify', key: `incident:${source.id}:${task.id}`, title: `orcapod: ${incident.status === 'awaiting_approval' ? 'approval needed' : incident.status === 'resolved' ? 'incident resolved' : 'incident on hold'}`, message: `${source.id}: ${incident.reason} (orcapod incident ${source.id})` })
}

export function recoveryAdmission(state: State, run: Run, obs: Observations): 'ready' | 'wait' | 'gone' {
  const recovery = run.recovery
  if (recovery === undefined) return 'ready'
  const source = state.runs.find((candidate) => candidate.id === recovery.sourceRunId)
  const incident = source?.incident
  if (source === undefined || incident === undefined || !incident.tasks.includes(run.id)) return 'gone'
  const project = obs.config.projects.find((candidate) => candidate.name === run.project)
  if (project === undefined || project.path !== run.target.path || project.repo !== run.target.repo || project.githubAccount !== run.target.githubAccount) return 'gone'
  if (!project.enabled || !obs.orca.ok) return 'wait'
  if (recovery.stage === 'apply' && (incident.status !== 'applying' || incident.approvedRevision !== recovery.proposal?.revision)) return 'gone'
  if (recovery.stage === 'prepare' && incident.status !== 'investigating') return 'gone'
  for (const peer of state.runs) {
    if (peer.id === run.id || (peer.id !== source.id && peer.recovery?.sourceRunId !== source.id)) continue
    if (peer.launchUncertain || peer.paneRecoveredAt === obs.now) return 'wait'
    if (['launching', 'starting', 'running'].includes(peer.phase.kind)) return 'wait'
    if (peer.orca === null) continue
    const list = obs.orca.terminals.get(peer.target.path)
    const agent = findAgent(obs.orca.agents.get(peer.target.path) ?? [], peer.orca)
    if (agent?.state === 'done') continue
    if (agent !== null) return 'wait'
    if ('tabClosed' in peer.phase && peer.phase.tabClosed) continue
    if (list === undefined || !list.complete || findTerminal(list, peer.orca) !== null) return 'wait'
  }
  return 'ready'
}
