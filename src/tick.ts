import { isAllowedAuthor, ruleKey } from './config.ts'
import { advanceIncidents, attachIncident, recoveryAdmission, serveIncidentRequest } from './incidents.ts'
import { parseProposal } from './incident-contract.ts'
import { runTitle } from './launch.ts'
import { WAITING_TOOL_NAMES, findAgent, findTerminal, usablePane } from './orca.ts'
import { ownValue, setOwnValue } from './records.ts'
import { newRunId, processedKey } from './state.ts'
import type { AgentObservation, Config, Effect, Item, Observations, OrcaRef, Project, Request, ResultFile, Rule, Run, RunPhase, State, TerminalList, TerminalObservation } from './types.ts'

const MINUTE_MS = 60_000
const STARTING_STALL_MS = 90_000
const INVALID_RESULT_GRACE_MS = 60_000
const LAUNCH_RECOVERY_MS = 5 * MINUTE_MS
const MAX_CLOSE_ATTEMPTS = 3

type Running = Extract<RunPhase, { kind: 'running' }>
type Starting = Extract<RunPhase, { kind: 'starting' }>
type DoneResult = NonNullable<Running['result']>
type OrcaSeen = Extract<Observations['orca'], { ok: true }>
type RunRequest = Extract<Request, { type: 'run' }>
type Step = (draft: State, obs: Observations, effects: Effect[]) => void

interface PaneSighting { agent: AgentObservation | null; terminal: TerminalObservation | null; listComplete: boolean }

const EMPTY_LIST: TerminalList = { terminals: [], complete: false }

export function tick(state: State, obs: Observations): { state: State; effects: Effect[] } {
  const draft = structuredClone(state)
  const effects: Effect[] = []
  const steps: Step[] = [serve, detect, fire, advanceIncidents, schedule, recover, track, watchOrca]
  for (const step of steps) step(draft, obs, effects)
  return { state: draft, effects }
}

export function applyLaunch(state: State, runId: string, result: { ok: true; orca: OrcaRef } | { ok: false; error: string }, now: string): State {
  const draft = structuredClone(state)
  const run = draft.runs.find((r) => r.id === runId)
  if (run === undefined || run.phase.kind !== 'launching') return state
  if (result.ok) {
    run.orca = result.orca
    delete run.launchUncertain
    run.startedAt = now
    setPhase(run, { kind: 'starting', since: now }, now)
  } else {
    setPhase(run, { kind: 'failed', at: now, reason: `launch failed: ${result.error}`, tabClosed: false, launchFailed: true }, now)
    attachIncident(run, now)
  }
  return draft
}

export function applyClose(state: State, runId: string, result: { ok: true; ptyKilled: boolean | null } | { ok: false; code: string }, now: string): State {
  if (!result.ok || result.ptyKilled !== true) return state
  const draft = structuredClone(state)
  const run = draft.runs.find((r) => r.id === runId)
  if (run === undefined) return state
  if (run.phase.kind === 'running' && run.phase.result !== undefined) {
    setPhase(run, { kind: 'done', at: now, summary: run.phase.result.file.summary, tabClosed: true }, now)
  } else if (run.phase.kind === 'done' || run.phase.kind === 'failed') {
    run.phase.tabClosed = true
  } else {
    return state
  }
  return draft
}

function setPhase(run: Run, phase: RunPhase, now: string): void {
  if (phase.kind !== run.phase.kind) run.history.push({ kind: phase.kind, at: now })
  run.phase = phase
}

function serve(draft: State, obs: Observations, effects: Effect[]): void {
  const presentFiles = new Set(obs.requests.map((r) => r.file))
  const alreadyConsumed = new Set(draft.consumedRequests.filter((file) => presentFiles.has(file)))
  draft.consumedRequests = [...alreadyConsumed]
  for (const read of obs.requests) {
    if (!alreadyConsumed.has(read.file)) {
      if ('error' in read) effects.push({ type: 'log', level: 'warn', message: `cannot read request ${read.file}: ${read.error}` })
      else serveRequest(draft, read.file, read.request, obs, effects)
      draft.consumedRequests.push(read.file)
    }
    effects.push({ type: 'consumeRequest', file: read.file })
  }
}

function serveRequest(draft: State, file: string, request: Request, obs: Observations, effects: Effect[]): void {
  if (request.type === 'run') {
    serveRun(draft, file, request, obs, effects)
    return
  }
  const run = draft.runs.find((r) => r.id === request.runId)
  if (run === undefined) {
    effects.push({ type: 'log', level: 'warn', message: `request ${file}: ${request.type} target ${request.runId} not found` })
    return
  }
  if (request.type === 'stop') stopRun(run, obs, effects)
  else if (request.type === 'investigate' || request.type === 'approve') {
    const error = serveIncidentRequest(draft, run, request, obs.now)
    if (error !== null) effects.push({ type: 'log', level: 'warn', message: `request ${file}: ${error}` })
  } else if (run.recovery !== undefined) {
    effects.push({ type: 'log', level: 'warn', message: `request ${file}: a recovery child run cannot be rerun; check the original incident` })
  } else rerunRun(draft, file, run, obs.now)
}

function serveRun(draft: State, file: string, request: RunRequest, obs: Observations, effects: Effect[]): void {
  const resolved = resolveManualRun(obs.config, request)
  if (typeof resolved === 'string') {
    effects.push({ type: 'log', level: 'warn', message: `cannot process request ${file}: ${resolved}` })
    return
  }
  const { project, kindName, rule } = resolved
  draft.runs.push(createRun(draft, {
    seed: `${ruleKey(project.name, rule)}|${numbersOf([request.item])}|${file}`,
    project: project.name,
    target: { path: project.path, repo: project.repo, githubAccount: project.githubAccount },
    rule,
    kindName,
    items: [request.item],
    manual: true,
    bypassLimit: request.now,
  }, obs.now))
}

function resolveManualRun(config: Config, request: RunRequest): { project: Project; kindName: string; rule: Rule } | string {
  const project = config.projects.find((p) => p.name === request.project)
  if (project === undefined) return `project ${request.project} is not in the config`
  const kind = config.kinds.find((k) => k.id === request.kind)
  if (kind === undefined) return `kind ${request.kind} is not in the config`
  const ai = request.ai ?? project.rules.find((r) => r.enabled && r.kind === request.kind)?.ai
  if (ai === undefined) return `no enabled rule uses kind ${request.kind}, so the AI cannot be chosen`
  if (!config.prompts.has(`${request.kind}.${ai}`)) return `prompts/${request.kind}.${ai}.md is missing`
  const rule: Rule = { target: request.item.target, label: '', kind: request.kind, ai, batch: 'each', delayMinutes: 0, enabled: true, bootstrap: 'skip' }
  return { project, kindName: kind.name, rule }
}

function stopRun(run: Run, obs: Observations, effects: Effect[]): void {
  run.orca ??= ownValue(obs.panes, run.id) ?? null
  const handle = visibleHandle(run, obs)
  if (handle !== null) effects.push({ type: 'close', runId: run.id, handle })
  if (['queued', 'launching', 'starting', 'running'].includes(run.phase.kind)) {
    setPhase(run, { kind: 'aborted', at: obs.now, reason: 'orcapod stop' }, obs.now)
  } else if (run.phase.kind === 'failed' && handle === null && (run.orca === null || obs.orca.ok)) {
    run.phase.tabClosed = true
  }
}

function visibleHandle(run: Run, obs: Observations): string | null {
  const ref = run.orca
  if (ref === null || !obs.orca.ok) return null
  const sighting = sightPane(ref, run.target.path, obs.orca)
  if (sighting.terminal !== null) return sighting.terminal.handle
  return sighting.agent !== null ? ref.handle : null
}

function rerunRun(draft: State, file: string, original: Run, now: string): void {
  draft.runs.push(createRun(draft, {
    seed: `${ruleKey(original.project, original.rule)}|${numbersOf(original.items)}|${file}`,
    project: original.project,
    target: original.target,
    rule: original.rule,
    kindName: original.kindName,
    items: original.items,
    manual: true,
    bypassLimit: false,
  }, now))
}

interface NewRun { seed: string; project: string; target: Run['target']; rule: Rule; kindName: string; items: Item[]; manual: boolean; bypassLimit: boolean }

function createRun(draft: State, fields: NewRun, now: string): Run {
  const { seed, ...rest } = fields
  const id = newRunId(now, seed, new Set(draft.runs.map((r) => r.id)))
  return { id, ...rest, createdAt: now, startedAt: null, phase: { kind: 'queued', since: now }, history: [{ kind: 'queued', at: now }], orca: null, notified: [], lastMessage: null }
}

function detect(draft: State, obs: Observations, effects: Effect[]): void {
  for (const name of Object.keys(obs.github)) setOwnValue(draft.lastPolledAt, name, obs.now)
  const processedKeys = new Set(draft.processed.map((p) => p.key))
  for (const project of obs.config.projects) {
    const polled = ownValue(obs.github, project.name)
    if (!project.enabled || polled === undefined) continue
    if (!polled.ok) {
      const known = ownValue(draft.projectErrors, project.name)
      if (known === undefined) effects.push({ type: 'notify', key: `project-error:${project.name}`, title: 'orcapod: watch error', message: `${project.name}: ${polled.error}` })
      setOwnValue(draft.projectErrors, project.name, { since: known?.since ?? obs.now, message: polled.error })
      continue
    }
    if (hasProjectError(draft, project.name)) {
      delete draft.projectErrors[project.name]
      effects.push({ type: 'log', level: 'info', message: `watch error cleared: ${project.name}` })
    }
    refreshWaitingAuthors(draft, project.name, polled.items)
    const allowedItems = polled.items.filter((item) => isAllowedAuthor(project, item))
    for (const rule of project.rules) {
      if (rule.enabled) detectRule(draft, project, rule, allowedItems, processedKeys, obs.now, effects)
    }
  }
}

function hasProjectError(draft: State, project: string): boolean {
  return ownValue(draft.projectErrors, project) !== undefined
}

function refreshWaitingAuthors(draft: State, project: string, polledItems: Item[]): void {
  const latest = new Map(polledItems.map((item) => [itemIdentity(item), item.author]))
  const refresh = (items: Item[]): void => {
    for (const item of items) item.author = { ...(latest.get(itemIdentity(item)) ?? item.author) }
  }
  for (const pending of draft.pending) if (pending.project === project) refresh(pending.items)
  for (const run of draft.runs) if (run.project === project && run.phase.kind === 'queued' && !run.manual) refresh(run.items)
}

function itemIdentity(item: Item): string {
  return JSON.stringify([item.repo, item.target, item.number])
}

function detectRule(draft: State, project: Project, rule: Rule, items: Item[], processedKeys: Set<string>, now: string, effects: Effect[]): void {
  const key = ruleKey(project.name, rule)
  const label = rule.label.trim().toLowerCase()
  const unseen: Item[] = []
  for (const item of items) {
    if (item.target !== rule.target || (label !== '*' && !item.labels.includes(label))) continue
    if (!isAllowedAuthor(project, item, rule)) continue
    const itemKey = processedKey(item, label)
    if (processedKeys.has(itemKey)) continue
    processedKeys.add(itemKey)
    draft.processed.push({ key: itemKey, seenAt: now })
    unseen.push(item)
  }
  const ruleName = `${project.name} / ${rule.target} / ${label}`
  if (!draft.watchedRules.includes(key)) {
    draft.watchedRules.push(key)
    if (rule.bootstrap === 'skip') {
      effects.push({ type: 'log', level: 'info', message: `first watch of ${ruleName}: ${unseen.length} matched, marked as processed` })
      return
    }
  }
  if (unseen.length === 0) return
  const fireAt = plusMinutes(now, rule.delayMinutes)
  const pending = draft.pending.find((p) => p.ruleKey === key)
  if (pending === undefined) draft.pending.push({ ruleKey: key, project: project.name, items: unseen, fireAt })
  else {
    pending.items.push(...unseen)
    pending.fireAt = fireAt
  }
  effects.push({ type: 'log', level: 'info', message: `detected ${ruleName}: ${numbersOf(unseen)} → launches at ${fireAt}` })
}

function fire(draft: State, obs: Observations, effects: Effect[]): void {
  let sequence = 0
  draft.pending = draft.pending.filter((pending) => {
    if (Date.parse(pending.fireAt) > Date.parse(obs.now)) return true
    const project = obs.config.projects.find((p) => p.name === pending.project)
    const rule = project?.rules.find((r) => ruleKey(project.name, r) === pending.ruleKey)
    if (project === undefined || rule === undefined) {
      effects.push({ type: 'log', level: 'warn', message: `rule ${pending.ruleKey} is not in the config; dropped pending ${numbersOf(pending.items)}` })
      return false
    }
    if (!project.enabled || !rule.enabled || hasProjectError(draft, project.name)) return true
    const items = keepAllowedAuthors(project, rule, pending.items, `pending ${pending.ruleKey}`, effects)
    const groups = rule.batch === 'together' ? [items] : items.map((item) => [item])
    for (const group of groups.filter((g) => g.length > 0)) {
      draft.runs.push(createRun(draft, {
        seed: `${pending.ruleKey}|${numbersOf(group)}|${sequence++}`,
        project: project.name,
        target: { path: project.path, repo: project.repo, githubAccount: project.githubAccount },
        rule: { ...rule },
        kindName: obs.config.kinds.find((k) => k.id === rule.kind)?.name ?? rule.kind,
        items: group,
        manual: false,
        bypassLimit: false,
      }, obs.now))
    }
    return false
  })
}

function keepAllowedAuthors(project: Project, rule: Rule, items: Item[], owner: string, effects: Effect[]): Item[] {
  const allowed = items.filter((item) => isAllowedAuthor(project, item, rule))
  if (allowed.length < items.length) {
    const dropped = items.filter((item) => !allowed.includes(item))
    effects.push({ type: 'log', level: 'info', message: `${owner}: dropped ${numbersOf(dropped)} (author no longer allowed)` })
  }
  return allowed
}

function schedule(draft: State, obs: Observations, effects: Effect[]): void {
  releaseResolvedQueueStalls(draft, obs)
  if (!obs.orca.ok) return
  const { maxConcurrentPerProject, notify } = obs.config.settings
  const active = new Map<string, number>()
  for (const run of draft.runs) {
    if (isActive(run)) active.set(run.project, (active.get(run.project) ?? 0) + 1)
  }
  const queued = draft.runs.filter((run) => run.phase.kind === 'queued').sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  for (const run of queued) {
    const recovery = recoveryAdmission(draft, run, obs)
    if (recovery === 'wait') continue
    const admission = recovery === 'gone' ? { kind: 'gone' as const } : admissionOf(obs.config, run)
    if (admission.kind === 'gone') {
      setPhase(run, { kind: 'aborted', at: obs.now, reason: 'rule is not in the config' }, obs.now)
      effects.push({ type: 'log', level: 'warn', message: `run ${run.id}: rule ${ruleKey(run.project, run.rule)} is not in the config; aborted the queued run` })
      continue
    }
    if (admission.kind === 'disabled') continue
    const hasSlot = run.bypassLimit || (active.get(run.project) ?? 0) < maxConcurrentPerProject
    if (hasProjectError(draft, run.project) || !hasSlot) {
      noteQueueStall(run, notify.queuedMinutes, obs.now, effects)
      continue
    }
    if (admission.kind === 'enabled') {
      const allowed = keepAllowedAuthors(admission.project, admission.rule, run.items, `run ${run.id}`, effects)
      if (allowed.length === 0) {
        run.lastMessage = 'author no longer allowed'
        abort(run, 'author no longer allowed', obs.now, effects)
        continue
      }
      run.items = allowed
    }
    active.set(run.project, (active.get(run.project) ?? 0) + 1)
    clearNotified(run, 'queued')
    setPhase(run, { kind: 'launching', since: obs.now }, obs.now)
    effects.push({ type: 'launch', runId: run.id })
  }
}

type Admission = { kind: 'manual' } | { kind: 'enabled'; project: Project; rule: Rule } | { kind: 'disabled' } | { kind: 'gone' }

function admissionOf(config: Config, run: Run): Admission {
  if (run.manual) return { kind: 'manual' }
  const project = config.projects.find((p) => p.name === run.project)
  const key = ruleKey(run.project, run.rule)
  const rule = project?.rules.find((r) => ruleKey(project.name, r) === key)
  if (project === undefined || rule === undefined) return { kind: 'gone' }
  return project.enabled && rule.enabled ? { kind: 'enabled', project, rule } : { kind: 'disabled' }
}

function isActive(run: Run): boolean {
  return run.phase.kind === 'launching' || run.phase.kind === 'starting' || run.phase.kind === 'running'
}

function releaseResolvedQueueStalls(draft: State, obs: Observations): void {
  const { queuedMinutes } = obs.config.settings.notify
  for (const run of draft.runs) {
    if (run.phase.kind !== 'queued') continue
    const admission = admissionOf(obs.config, run).kind
    if (admission === 'gone') continue
    if (admission === 'disabled' || !isQueueStallDue(run.phase.since, queuedMinutes, obs.now)) clearNotified(run, 'queued')
  }
}

function isQueueStallDue(queuedSince: string, queuedMinutes: number, now: string): boolean {
  return elapsedMs(queuedSince, now) >= queuedMinutes * MINUTE_MS
}

function noteQueueStall(run: Run, queuedMinutes: number, now: string, effects: Effect[]): void {
  if (run.phase.kind !== 'queued' || !isQueueStallDue(run.phase.since, queuedMinutes, now)) return
  notifyOnce(run, 'queued', 'orcapod: queue stalled', `${runLabel(run)}: waiting in the queue for over ${queuedMinutes} minutes`, effects)
}

function recover(draft: State, obs: Observations, effects: Effect[]): void {
  for (const run of draft.runs) {
    if (run.launchUncertain && run.orca === null) {
      const latePane = ownValue(obs.panes, run.id)
      if (latePane !== undefined && usablePane(latePane)) { run.orca = latePane; run.paneRecoveredAt = obs.now; delete run.launchUncertain }
    }
    if (run.phase.kind !== 'launching') continue
    const pane = ownValue(obs.panes, run.id)
    if (pane !== undefined && usablePane(pane)) {
      run.orca = pane
      run.paneRecoveredAt = obs.now
      delete run.launchUncertain
      run.startedAt ??= obs.now
      setPhase(run, { kind: 'starting', since: obs.now }, obs.now)
      effects.push({ type: 'log', level: 'info', message: `run ${run.id}: recovered the pane from pane.json` })
    } else if (obs.orca.ok && elapsedMs(run.phase.since, obs.now) >= LAUNCH_RECOVERY_MS) {
      run.launchUncertain = true
      fail(run, 'launch result unknown; not relaunching to avoid a duplicate run', obs.now, effects, true)
    }
  }
}

function track(draft: State, obs: Observations, effects: Effect[]): void {
  for (const run of draft.runs) {
    if (run.orca === null || run.paneRecoveredAt === obs.now) continue
    if (run.phase.kind === 'failed' || (run.recovery !== undefined && run.phase.kind === 'done')) {
      if (obs.orca.ok && !run.phase.tabClosed && isVanished(sightPane(run.orca, run.target.path, obs.orca))) run.phase.tabClosed = true
      continue
    }
    if (run.phase.kind !== 'starting' && run.phase.kind !== 'running') continue
    const sighting = obs.orca.ok ? sightPane(run.orca, run.target.path, obs.orca) : null
    const message = sighting?.agent?.lastAssistantMessage
    if (message !== undefined && message !== null && message !== run.lastMessage) {
      run.lastMessage = message
      effects.push({ type: 'writeLastMessage', runId: run.id, text: message })
    }
    const result = trackResult(run, run.phase, obs, effects)
    if (result === 'failed' || sighting === null) continue
    if (sighting.terminal !== null && sighting.terminal.handle !== run.orca.handle) run.orca = { ...run.orca, handle: sighting.terminal.handle }
    if (sighting.agent === null && sighting.terminal === null && !sighting.listComplete) {
      effects.push({ type: 'log', level: 'warn', message: `run ${run.id}: terminal list is incomplete, so the pane is not judged as gone` })
    }
    if (result !== null && sighting.agent === null) {
      const tabClosed = isVanished(sighting)
      clearNotified(run, 'starting-stall')
      setPhase(run, { kind: 'done', at: obs.now, summary: result.file.summary, tabClosed }, obs.now)
      if (!tabClosed) notifyOnce(run, 'result-untracked', 'orcapod: result untracked', `${runLabel(run)}: received a done result but cannot track the agent. The tab remains open (close it with orcapod stop ${run.id})`, effects)
      continue
    }
    if (run.phase.kind === 'starting') trackStarting(run, run.phase, run.orca, sighting, obs, effects)
    if (run.phase.kind === 'running') trackRunning(run, run.phase, run.orca, sighting, obs, effects, result)
  }
}

function trackResult(run: Run, phase: Starting | Running, obs: Observations, effects: Effect[]): DoneResult | 'failed' | null {
  const observed = ownValue(obs.results, run.id)
  if (observed === undefined) return null
  const file = parseResultFile(observed.raw)
  if (file !== null && run.recovery !== undefined) {
    if (file.status === 'done' && ((run.recovery.stage === 'prepare' && file.proposal === undefined) || (run.recovery.stage === 'apply' && !file.verification?.length))) {
      fail(run, 'recovery result has no proposal or post-apply verification', obs.now, effects)
      return 'failed'
    }
    run.recoveryResult = file
  }
  if (file?.status === 'failed') {
    fail(run, `AI reported failed: ${file.summary}`, obs.now, effects)
    return 'failed'
  } else if (file?.status === 'done') {
    delete phase.invalidResultSince
    return { file, mtime: observed.mtime }
  } else {
    phase.invalidResultSince ??= obs.now
    if (elapsedMs(phase.invalidResultSince, obs.now) >= INVALID_RESULT_GRACE_MS) {
      fail(run, 'result.json is invalid', obs.now, effects)
      return 'failed'
    }
  }
  return null
}

function sightPane(ref: OrcaRef, path: string, orca: OrcaSeen): PaneSighting {
  const list = orca.terminals.get(path) ?? EMPTY_LIST
  return { agent: findAgent(orca.agents.get(path) ?? [], ref), terminal: findTerminal(list, ref), listComplete: list.complete }
}

function isVanished(sighting: PaneSighting): boolean {
  return sighting.listComplete && sighting.agent === null && sighting.terminal === null
}

function trackStarting(run: Run, phase: Starting, ref: OrcaRef, sighting: PaneSighting, obs: Observations, effects: Effect[]): void {
  const { now } = obs
  if (sighting.agent !== null) {
    clearNotified(run, 'starting-stall')
    setPhase(run, { kind: 'running', agent: sighting.agent.state, agentSince: now, closeAttempts: 0, ...(phase.invalidResultSince === undefined ? {} : { invalidResultSince: phase.invalidResultSince }) }, now)
    return
  }
  if (isVanished(sighting)) {
    abort(run, 'pane and tab disappeared', now, effects)
    return
  }
  if (elapsedMs(phase.since, now) < STARTING_STALL_MS) return
  const hooks = obs.orca.ok ? obs.orca.hooks : null
  const hooksDisabled = hooks !== null && (!hooks.enabled || hooks.agents[run.rule.ai] !== 'installed')
  const message = `${runLabel(run)}: no agent appeared 90 seconds after the tab opened (possibly a trust dialog)${hooksDisabled ? '. Orca hooks are disabled' : ''}`
  notifyOnce(run, 'starting-stall', 'orcapod: launch waiting', message, effects, ref.handle)
}

function trackRunning(run: Run, phase: Running, ref: OrcaRef, sighting: PaneSighting, obs: Observations, effects: Effect[], doneThisCycle: DoneResult | null): void {
  const { now } = obs
  const { notify } = obs.config.settings
  const { agent } = sighting
  if (agent !== null) {
    if (agent.state !== phase.agent) {
      phase.agent = agent.state
      phase.agentSince = now
    }
  }

  if (doneThisCycle !== null) phase.result = doneThisCycle

  if (isVanished(sighting)) {
    if (phase.closeAttempts > 0 && phase.result !== undefined) setPhase(run, { kind: 'done', at: now, summary: phase.result.file.summary, tabClosed: true }, now)
    else abort(run, 'pane and tab disappeared', now, effects)
    return
  }

  if (phase.closeAttempts >= MAX_CLOSE_ATTEMPTS) {
    notifyOnce(run, 'close-failed', 'orcapod: cannot close tab', `${runLabel(run)}: failed to close the tab ${MAX_CLOSE_ATTEMPTS} times. The tab remains open`, effects)
    setPhase(run, { kind: 'done', at: now, summary: phase.result?.file.summary ?? '', tabClosed: false }, now)
    return
  }

  if (doneThisCycle !== null && agent !== null && agent.state === 'done' && Date.parse(agent.stateSince) >= Date.parse(doneThisCycle.mtime)) {
    phase.closeAttempts += 1
    effects.push({ type: 'close', runId: run.id, handle: ref.handle })
  }

  const waiting = phase.agent === 'waiting' || phase.agent === 'blocked' || (agent !== null && agent.toolName !== null && WAITING_TOOL_NAMES.includes(agent.toolName))
  if (waiting) phase.waitingSince ??= now
  else {
    delete phase.waitingSince
    clearNotified(run, 'waiting')
  }
  if (phase.waitingSince !== undefined && elapsedMs(phase.waitingSince, now) >= notify.waitingMinutes * MINUTE_MS) {
    notifyOnce(run, 'waiting', 'orcapod: waiting for input', `${runLabel(run)}: waiting for input for ${notify.waitingMinutes} minutes`, effects)
  }

  if (phase.agent !== 'done') clearNotified(run, 'done-no-result')
  else if (doneThisCycle === null && elapsedMs(phase.agentSince, now) >= notify.waitingMinutes * MINUTE_MS) {
    notifyOnce(run, 'done-no-result', 'orcapod: no result', `${runLabel(run)}: the turn ended without a result (${notify.waitingMinutes} minutes)`, effects)
  }

  if (run.startedAt !== null && elapsedMs(run.startedAt, now) >= notify.maxRunMinutes * MINUTE_MS) {
    notifyOnce(run, 'long-run', 'orcapod: long run', `${runLabel(run)}: running for over ${notify.maxRunMinutes} minutes`, effects)
  }
}

function parseResultFile(raw: string): ResultFile | null {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null
  const { status, summary, links, proposal, verification } = json as Record<string, unknown>
  if (status !== 'done' && status !== 'failed') return null
  const parsedProposal = parseProposal(proposal)
  return {
    status,
    summary: typeof summary === 'string' ? summary : '',
    links: Array.isArray(links) ? links.filter((link): link is string => typeof link === 'string') : [],
    ...(parsedProposal === null ? {} : { proposal: parsedProposal }),
    ...(Array.isArray(verification) && verification.length <= 100 && verification.every((value) => typeof value === 'string' && value.trim() !== '') ? { verification } : {}),
  }
}

function watchOrca(draft: State, obs: Observations, effects: Effect[]): void {
  if (obs.orca.ok) {
    if (draft.orcaOutageSince === null) return
    draft.orcaOutageSince = null
    effects.push({ type: 'log', level: 'info', message: 'reconnected to Orca' })
    return
  }
  if (draft.orcaOutageSince !== null) return
  draft.orcaOutageSince = obs.now
  effects.push({ type: 'notify', key: 'orca-outage', title: 'orcapod: Orca unreachable', message: obs.orca.error })
}

function fail(run: Run, reason: string, now: string, effects: Effect[], launchFailed = false): void {
  setPhase(run, launchFailed ? { kind: 'failed', at: now, reason, tabClosed: false, launchFailed: true } : { kind: 'failed', at: now, reason, tabClosed: false }, now)
  attachIncident(run, now)
  effects.push({ type: 'notify', key: `failed:${run.id}`, title: 'orcapod: failed', message: `${runLabel(run)}: ${reason}` })
}

function abort(run: Run, reason: string, now: string, effects: Effect[]): void {
  setPhase(run, { kind: 'aborted', at: now, reason }, now)
  effects.push({ type: 'notify', key: `aborted:${run.id}`, title: 'orcapod: aborted', message: `${runLabel(run)}: ${reason}` })
}

function notifyOnce(run: Run, event: string, title: string, message: string, effects: Effect[], withScreenOf?: string): void {
  if (run.notified.includes(event)) return
  run.notified.push(event)
  const key = `${event}:${run.id}`
  effects.push(withScreenOf === undefined ? { type: 'notify', key, title, message } : { type: 'notify', key, title, message, withScreenOf })
}

function clearNotified(run: Run, event: string): void {
  run.notified = run.notified.filter((key) => key !== event)
}

function runLabel(run: Run): string {
  return `${run.id} "${runTitle(run)}"`
}

function numbersOf(items: Item[]): string {
  return items.map((item) => `#${item.number}`).join(',')
}

function elapsedMs(since: string, now: string): number {
  return Date.parse(now) - Date.parse(since)
}

function plusMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * MINUTE_MS).toISOString()
}
