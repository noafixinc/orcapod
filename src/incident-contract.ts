import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Incident, Proposal, Run } from './types.ts'

export const MAX_INVESTIGATIONS = 3
const HASH = /^[a-f0-9]{64}$/
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const STATUSES = ['pending', 'investigating', 'awaiting_approval', 'applying', 'blocked', 'resolved']

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 16_000
}

function strings(value: unknown, nonempty = true): value is string[] {
  return Array.isArray(value) && (!nonempty || value.length > 0) && value.length <= 100 && value.every(text)
}

export function parseProposal(value: unknown): Proposal | null {
  if (!record(value) || !text(value.summary) || !text(value.cause)) return null
  if (!strings(value.evidence) || !strings(value.validation) || !strings(value.actions) || !strings(value.risks, false)) return null
  if (!Array.isArray(value.changes) || value.changes.length > 20) return null
  const changes: Proposal['changes'] = []
  for (const change of value.changes) {
    if (!record(change) || !text(change.path) || !isAbsolute(change.path) || !text(change.head) || !COMMIT.test(change.head) || !text(change.summary)) return null
    changes.push({ path: change.path, head: change.head, summary: change.summary })
  }
  return { summary: value.summary, cause: value.cause, evidence: value.evidence, changes, validation: value.validation, actions: value.actions, risks: value.risks }
}

export function proposalRevision(proposal: Proposal): string {
  return createHash('sha256').update(JSON.stringify(proposal)).digest('hex')
}

export function isProposalSnapshot(value: unknown): boolean {
  if (!record(value) || typeof value.revision !== 'string' || !HASH.test(value.revision)) return false
  const proposal = parseProposal(value.body)
  return proposal !== null && proposalRevision(proposal) === value.revision
}

export function validIncident(value: unknown): boolean {
  if (!record(value) || !STATUSES.includes(String(value.status)) || !text(value.reason) || !text(value.updatedAt)) return false
  if (!strings(value.tasks, false) || !strings(value.evidence, false) || !strings(value.revisions, false)) return false
  if (value.proposal !== undefined && !isProposalSnapshot(value.proposal)) return false
  if (value.approvedRevision !== undefined && (typeof value.approvedRevision !== 'string' || !HASH.test(value.approvedRevision))) return false
  if (value.status === 'awaiting_approval' && value.proposal === undefined) return false
  if (value.status === 'applying' && (!record(value.proposal) || value.approvedRevision !== value.proposal.revision)) return false
  return true
}

export function validRecovery(value: unknown): boolean {
  if (!record(value) || !text(value.sourceRunId) || !['prepare', 'apply'].includes(String(value.stage)) || !strings(value.evidence, false)) return false
  return value.stage === 'prepare' ? value.proposal === undefined : isProposalSnapshot(value.proposal)
}

export function openIncident(now: string): Incident {
  return { status: 'pending', reason: 'waiting to investigate the failure path', updatedAt: now, tasks: [], evidence: [], revisions: [] }
}

export function unresolved(run: Run): boolean {
  return run.recovery === undefined && run.phase.kind === 'failed' && run.incident?.status !== 'resolved'
}

export function incidentLabel(incident: Incident | undefined): string {
  if (incident === undefined) return 'not investigated'
  return { pending: 'pending investigation', investigating: 'investigating', awaiting_approval: 'awaiting approval', applying: 'approved, applying', blocked: 'needs attention', resolved: 'resolved' }[incident.status]
}

export function formatIncident(run: Run): string {
  const incident = run.incident
  const lines = [`${run.id} ${run.project}: ${incidentLabel(incident)}`, `original result: ${run.phase.kind === 'failed' ? run.phase.reason : run.phase.kind}`]
  if (incident === undefined) return [...lines, `investigate: orcapod investigate ${run.id}`].join('\n')
  lines.push(`reason: ${incident.reason}`, `investigation runs: ${incident.tasks.join(', ') || 'none'}`, ...incident.evidence.map((value) => `added evidence: ${value}`))
  if (incident.proposal !== undefined) {
    const { revision, body } = incident.proposal
    lines.push(`proposal: ${body.summary}`, `cause: ${body.cause}`, ...body.evidence.map((value) => `evidence: ${value}`), ...body.changes.map((change) => `change: ${change.path} @ ${change.head}\n  ${change.summary}`), ...body.validation.map((value) => `validation: ${value}`), ...body.actions.map((value) => `after approval: ${value}`), ...body.risks.map((value) => `remaining risk: ${value}`), `revision: ${revision}`)
    if (incident.status === 'awaiting_approval') lines.push(`approve: orcapod approve ${run.id} ${revision}`)
  }
  return lines.join('\n')
}
