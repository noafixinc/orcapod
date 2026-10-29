import { describe, expect, it } from 'vitest'
import { formatIncident, incidentLabel, openIncident, parseProposal, proposalRevision, validIncident, validRecovery } from '../src/incident-contract.ts'
import type { Incident, Proposal, Run } from '../src/types.ts'

const NOW = '2026-10-24T03:00:00.000Z'
const proposal: Proposal = {
  summary: 'fix the config', cause: 'the config is stale', evidence: ['checked the diff'],
  changes: [{ path: '/repo/todos', head: 'a1'.repeat(20), summary: 'update the config' }],
  validation: ['tests pass'], actions: ['apply the fix'], risks: ['needs a restart'],
}
const snapshot = { revision: proposalRevision(proposal), body: proposal }

describe('G3: input boundary of parseProposal', () => {
  const textFields: [string, (text: string) => Proposal][] = [
    ['summary', (text) => ({ ...proposal, summary: text })],
    ['cause', (text) => ({ ...proposal, cause: text })],
    ...(['evidence', 'validation', 'actions', 'risks'] as const).map((field): [string, (text: string) => Proposal] => [field, (text) => ({ ...proposal, [field]: [text] })]),
    ['changes.path', (text) => ({ ...proposal, changes: [{ ...proposal.changes[0], path: text }] })],
    ['changes.summary', (text) => ({ ...proposal, changes: [{ ...proposal.changes[0], summary: text }] })],
  ]

  it.each(textFields)('%s accepts 16000 characters and rejects 16001 characters and whitespace-only text', (field, withText) => {
    const text = field === 'changes.path' ? `/${'x'.repeat(15_999)}` : 'x'.repeat(16_000)
    expect(parseProposal(withText(text))).toEqual(withText(text))
    expect(parseProposal(withText(`${text}x`))).toBeNull()
    expect(parseProposal(withText(' \t\n '))).toBeNull()
  })

  it.each(['evidence', 'validation', 'actions', 'risks'] as const)('%s accepts 100 entries and rejects 101 entries', (field) => {
    const accepted = { ...proposal, [field]: Array<string>(100).fill('evidence / action') }
    expect(parseProposal(accepted)).toEqual(accepted)
    expect(parseProposal({ ...accepted, [field]: Array<string>(101).fill('evidence / action') })).toBeNull()
  })

  it('changes accepts 20 entries and rejects 21, and empty arrays for risks and changes are also accepted', () => {
    const accepted = { ...proposal, changes: Array.from({ length: 20 }, (_, i) => ({ ...proposal.changes[0], path: `/repo/project-${i}` })) }
    expect(parseProposal(accepted)).toEqual(accepted)
    expect(parseProposal({ ...accepted, changes: [...accepted.changes, proposal.changes[0]] })).toBeNull()
    expect(parseProposal({ ...proposal, changes: [], risks: [] })).toEqual({ ...proposal, changes: [], risks: [] })
  })

  it.each([40, 64])('changes.head accepts lowercase hex of %d digits', (length) => {
    const accepted = { ...proposal, changes: [{ ...proposal.changes[0], head: 'a1'.repeat(length / 2) }] }
    expect(parseProposal(accepted)).toEqual(accepted)
  })

  it.each([39, 41, 63, 65].map((length) => 'a'.repeat(length)).concat(['A'.repeat(40), 'A'.repeat(64), 'g'.repeat(40), 'g'.repeat(64)]))('changes.head rejects invalid digit counts, uppercase and non-hex: %s', (head) => {
    expect(parseProposal({ ...proposal, changes: [{ ...proposal.changes[0], head }] })).toBeNull()
  })
})

describe('G3: approval snapshot of incident and recovery', () => {
  it('awaiting_approval requires a valid proposal', () => {
    expect(validIncident({ ...openIncident(NOW), status: 'awaiting_approval' })).toBe(false)
    expect(validIncident({ ...openIncident(NOW), status: 'awaiting_approval', proposal: snapshot })).toBe(true)
  })

  it('applying requires an approvedRevision matching the snapshot', () => {
    const incident = { ...openIncident(NOW), status: 'applying', proposal: snapshot }
    expect(validIncident(incident)).toBe(false)
    expect(validIncident({ ...incident, approvedRevision: '0'.repeat(64) })).toBe(false)
    expect(validIncident({ ...incident, approvedRevision: snapshot.revision })).toBe(true)
  })

  it('prepare accepts no proposal and rejects a proposal', () => {
    const recovery = { sourceRunId: '20261024-0300-aaaaaa', stage: 'prepare', evidence: [] }
    expect(validRecovery(recovery)).toBe(true)
    expect(validRecovery({ ...recovery, proposal: snapshot })).toBe(false)
  })

  it('apply accepts a matching snapshot and rejects a missing one, a tampered revision and a tampered body', () => {
    const recovery = { sourceRunId: '20261024-0300-aaaaaa', stage: 'apply', evidence: ['investigated'] }
    expect(validRecovery({ ...recovery, proposal: snapshot })).toBe(true)
    expect(validRecovery(recovery)).toBe(false)
    expect(validRecovery({ ...recovery, proposal: { ...snapshot, revision: '0'.repeat(64) } })).toBe(false)
    expect(validRecovery({ ...recovery, proposal: { ...snapshot, body: { ...proposal, actions: ['another action'] } } })).toBe(false)
  })
})

describe('incidentLabel', () => {
  it.each([
    [undefined, 'not investigated'],
    ['pending', 'pending investigation'],
    ['investigating', 'investigating'],
    ['awaiting_approval', 'awaiting approval'],
    ['applying', 'approved, applying'],
    ['blocked', 'needs attention'],
    ['resolved', 'resolved'],
  ] as const)('status %s is shown as "%s"', (status, label) => {
    expect(incidentLabel(status === undefined ? undefined : { ...openIncident(NOW), status })).toBe(label)
  })
})

describe('SPEC-ENGLISH-OUTPUT-001 conditions: formatIncident names the next command only where there is one', () => {
  const failedRun: Run = {
    id: '20261024-0300-aaaaaa', project: 'todos', target: { path: '/repo/todos', repo: 'owner/todos', githubAccount: 'me' },
    rule: { target: 'pr', label: 'dependencies', kind: 'deps', ai: 'codex', batch: 'together', delayMinutes: 0, enabled: true, bootstrap: 'skip' },
    kindName: 'Dependabot', items: [], createdAt: NOW, startedAt: NOW, phase: { kind: 'failed', at: NOW, reason: 'tests failed', tabClosed: true },
    history: [], orca: null, notified: [], lastMessage: null, manual: false, bypassLimit: false,
  }
  const withIncident = (incident: Incident | undefined): Run => ({ ...failedRun, ...(incident === undefined ? {} : { incident }) })

  it('A8-1: a failed run with no incident shows orcapod investigate <id> and no approve command', () => {
    const output = formatIncident(withIncident(undefined))
    expect(output).toContain(`orcapod investigate ${failedRun.id}`)
    expect(output).not.toContain('orcapod approve')
  })

  it('A8-2: an incident awaiting approval shows orcapod approve <id> <revision> with the revision of the stored proposal, and no investigate command', () => {
    const incident: Incident = { ...openIncident(NOW), status: 'awaiting_approval', proposal: snapshot }
    const output = formatIncident(withIncident(incident))
    expect(output).toContain(`orcapod approve ${failedRun.id} ${incident.proposal!.revision}`)
    expect(incident.proposal!.revision).toBe(proposalRevision(proposal))
    expect(output).not.toContain('orcapod investigate')
  })

  it.each(['resolved', 'blocked', 'pending', 'investigating'] as const)('A8-3: a %s incident with empty tasks, evidence and revisions names neither command', (status) => {
    const output = formatIncident(withIncident({ ...openIncident(NOW), status }))
    expect(output).not.toContain('orcapod approve')
    expect(output).not.toContain('orcapod investigate')
  })

  it('A8-3 (added): an applying incident that still holds its approved proposal names neither command', () => {
    const output = formatIncident(withIncident({ ...openIncident(NOW), status: 'applying', proposal: snapshot, approvedRevision: snapshot.revision }))
    expect(output).not.toContain('orcapod approve')
    expect(output).not.toContain('orcapod investigate')
  })
})
