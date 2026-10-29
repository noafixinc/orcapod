import { describe, expect, it } from 'vitest'
import { openIncident, parseProposal, proposalRevision, validIncident } from '../src/incident-contract.ts'
import { advanceIncidents, serveIncidentRequest } from '../src/incidents.ts'
import { buildMonitorModel } from '../src/monitor-model.ts'
import { applyLaunch, tick } from '../src/tick.ts'
import type { Config, Effect, Incident, Observations, Proposal, Run, State } from '../src/types.ts'

const NOW = '2026-10-24T03:00:00.000Z'
const ROOT = '20261024-0300-aaaaaa'
const proposal: Proposal = { summary: 'align the permitted scope with the tests', cause: 'the DB name in the operating doc is stale', evidence: ['the code is pinned to a test-only DB'], changes: [], validation: ['unit tests passed, no DB operation done'], actions: ['apply the doc and code alignment fix and verify it'], risks: ['DB operations need approval'] }
const config: Config = {
  settings: { maxConcurrentPerProject: 1, launch: { codex: 'codex', claude: 'claude' }, notify: { desktop: false, waitingMinutes: 10, maxRunMinutes: 120, queuedMinutes: 30 } },
  kinds: [], prompts: new Map(), projects: [{ name: 'todos', path: '/repo/todos', repo: 'owner/todos', githubAccount: 'me', enabled: true, authors: [], bots: [], rules: [] }],
}

function root(incident?: Incident): Run {
  return { id: ROOT, project: 'todos', target: { path: '/repo/todos', repo: 'owner/todos', githubAccount: 'me' }, rule: { target: 'pr', label: 'dependencies', kind: 'deps', ai: 'codex', batch: 'together', delayMinutes: 0, enabled: true, bootstrap: 'skip' }, kindName: 'Dependabot', items: [], createdAt: NOW, startedAt: NOW, phase: { kind: 'failed', at: NOW, reason: 'DB permission scope mismatch', tabClosed: true }, history: [], orca: null, notified: [], lastMessage: null, manual: false, bypassLimit: false, ...(incident === undefined ? {} : { incident }) }
}

function state(run = root(openIncident(NOW))): State {
  return { version: 1, processed: [{ key: '["todos","pr",1017,"dependencies"]', seenAt: NOW }], pending: [], runs: [run], watchedRules: [], lastPolledAt: {}, projectErrors: {}, orcaOutageSince: null, consumedRequests: [], configStatus: null, daemonInfo: null }
}

function observations(overrides: Partial<Observations> = {}): Observations {
  return { now: NOW, config, github: {}, results: {}, panes: {}, requests: [], orca: { ok: true, agents: new Map(), terminals: new Map(), hooks: null }, ...overrides }
}

function prepared(body: Proposal = proposal) {
  const s = state()
  advanceIncidents(s, observations(), [])
  const child = s.runs[1]
  child.phase = { kind: 'done', at: NOW, summary: 'investigation done', tabClosed: true }
  child.recoveryResult = { status: 'done', summary: 'prepared', links: [], proposal: structuredClone(body) }
  advanceIncidents(s, observations(), [])
  return s
}

function approved(body: Proposal = proposal) {
  const s = prepared(body)
  const revision = s.runs[0].incident!.proposal!.revision
  expect(serveIncidentRequest(s, s.runs[0], { type: 'approve', runId: ROOT, revision }, NOW)).toBeNull()
  return s
}

describe('incident recovery on the failure path', () => {
  it('a new failure creates only one investigation and does not change the original items or processed', () => {
    const s = state()
    const before = structuredClone(s.processed)
    advanceIncidents(s, observations(), [])
    advanceIncidents(s, observations(), [])
    expect(s.runs).toHaveLength(2)
    expect(s.runs[1]).toMatchObject({ kindName: 'Incident investigation', recovery: { sourceRunId: ROOT, stage: 'prepare', evidence: ['DB permission scope mismatch'] }, phase: { kind: 'queued' } })
    expect(s.processed).toEqual(before)
    expect(s.runs[0].phase.kind).toBe('failed')
  })

  it('an existing failure does not start automatically, and the case with a closed tab remains displayed', () => {
    const s = state(root())
    const next = tick(s, observations())
    expect(next.state.runs).toHaveLength(1)
    expect(next.effects).toEqual([])
    expect(next.state.runs[0].incident?.status).toBe('blocked')
    const model = buildMonitorModel({ home: '/tmp', state: next.state, stateError: null, stateMtime: NOW, daemonPid: 1, lockError: null, config: { kind: 'unknown', disk: config, diskError: null }, now: NOW })
    expect(model.sections.find((section) => section.id === 'attention')?.rows[0].hint).toContain('orcapod incident')
  })

  it('a new launch failure also gets an incident, distinguished from old failures', () => {
    const s = state(root())
    s.runs[0].phase = { kind: 'launching', since: NOW }
    const next = applyLaunch(s, ROOT, { ok: false, error: 'executable not found' }, NOW)
    expect(next.runs[0].incident?.status).toBe('pending')
    expect(tick(next, observations()).state.runs).toHaveLength(2)
  })

  it('a completed proposal stops at awaiting approval, and is not applied however many times it is observed', () => {
    const s = prepared()
    expect(s.runs[0].incident).toMatchObject({ status: 'awaiting_approval', proposal: { revision: proposalRevision(proposal), body: proposal } })
    advanceIncidents(s, observations(), [])
    expect(s.runs).toHaveLength(2)
    expect(s.runs[1].recovery?.stage).toBe('prepare')
  })

  it('a stale or duplicate approval does not launch; only one valid approval creates an apply', () => {
    const s = prepared()
    expect(serveIncidentRequest(s, s.runs[0], { type: 'approve', runId: ROOT, revision: '0'.repeat(64) }, NOW)).toContain('does not match')
    const request = { type: 'approve' as const, runId: ROOT, revision: s.runs[0].incident!.proposal!.revision }
    expect(serveIncidentRequest(s, s.runs[0], request, NOW)).toBeNull()
    expect(serveIncidentRequest(s, s.runs[0], request, NOW)).toContain('does not match')
    expect(s.runs).toHaveLength(3)
    expect(s.runs[2].recovery?.proposal?.body).toEqual(proposal)
  })

  it('resolves only after the approved apply and concrete verification results are in place, and does not launch the original handling', () => {
    const s = approved()
    s.runs[2].phase = { kind: 'done', at: NOW, summary: 'applied', tabClosed: true }
    s.runs[2].recoveryResult = { status: 'done', summary: 'verified', links: [], verification: ['typecheck / lint / all tests passed'] }
    advanceIncidents(s, observations(), [])
    expect(s.runs[0].incident?.status).toBe('resolved')
    expect(s.runs).toHaveLength(3)
    expect(s.runs[0].phase.kind).toBe('failed')
  })

  it.each(['failed', 'aborted'] as const)('a preparation AI %s goes to waiting for confirmation and creates no grandchild or duplicate investigation', (kind) => {
    const s = state()
    advanceIncidents(s, observations(), [])
    s.runs[1].phase = kind === 'failed' ? { kind, at: NOW, reason: 'cannot prepare', tabClosed: true } : { kind, at: NOW, reason: 'stopped' }
    for (let i = 0; i < 5; i++) advanceIncidents(s, observations(), [])
    expect(s.runs).toHaveLength(2)
    expect(s.runs[0].incident?.status).toBe('blocked')
    expect(s.runs[1].incident).toBeUndefined()
  })

  it('re-investigates only with new evidence from an apply failure, and stops without re-applying for the same proposal', () => {
    const s = approved()
    s.runs[2].phase = { kind: 'failed', at: NOW, reason: 'verification failed', tabClosed: true }
    advanceIncidents(s, observations(), [])
    expect(s.runs).toHaveLength(4)
    expect(s.runs[0].incident?.status).toBe('investigating')
    s.runs[3].phase = { kind: 'done', at: NOW, summary: 'investigation', tabClosed: true }
    s.runs[3].recoveryResult = { status: 'done', summary: 'same fix', links: [], proposal: { ...proposal, summary: 'wording changed only' } }
    advanceIncidents(s, observations(), [])
    expect(s.runs[0].incident?.status).toBe('blocked')
    expect(s.runs).toHaveLength(4)
  })

  it('investigations are limited to 3, and a re-investigation without additional evidence is rejected', () => {
    const s = state()
    for (let i = 0; i < 3; i++) {
      advanceIncidents(s, observations(), [])
      s.runs.at(-1)!.phase = { kind: 'failed', at: NOW, reason: `stopped ${i}`, tabClosed: true }
      advanceIncidents(s, observations(), [])
      if (i < 2) {
        expect(serveIncidentRequest(s, s.runs[0], { type: 'investigate', runId: ROOT, evidence: '' }, NOW)).toContain('added evidence')
        expect(serveIncidentRequest(s, s.runs[0], { type: 'investigate', runId: ROOT, evidence: `new evidence ${i}` }, NOW)).toBeNull()
      } else expect(serveIncidentRequest(s, s.runs[0], { type: 'investigate', runId: ROOT, evidence: 'new evidence' }, NOW)).toContain('limit')
    }
    advanceIncidents(s, observations(), [])
    expect(s.runs).toHaveLength(4)
    expect(s.runs[0].incident?.status).toBe('blocked')
  })

  it('also rejects rerun of a recovery child on the daemon side', () => {
    const s = prepared()
    const next = tick(s, observations({ requests: [{ file: 'rerun.json', request: { type: 'rerun', runId: s.runs[1].id } }] }))
    expect(next.state.runs).toHaveLength(2)
    expect(next.effects.some((effect) => effect.type === 'log' && effect.message.includes('cannot be rerun'))).toBe(true)
  })

  it('does not launch recovery when disabled, when the target changed, or when Orca is unreachable', () => {
    for (const project of [{ ...config.projects[0], enabled: false }, { ...config.projects[0], path: '/other' }]) {
      const s = state()
      const next = tick(s, observations({ config: { ...config, projects: [project] } }))
      expect(next.effects.filter((effect) => effect.type === 'launch')).toEqual([])
    }
    const s = state()
    expect(tick(s, observations({ orca: { ok: false, error: 'offline' } })).effects.some((effect) => effect.type === 'launch')).toBe(false)
  })

  it.each(['working', 'waiting', 'blocked'] as const)('when the failed source agent is %s, does not launch the investigation, and launches exactly one after the exit is confirmed', (agentState) => {
    const run = root(openIncident(NOW))
    run.orca = { handle: 'term', tabId: 'tab', paneKey: 'tab:pane', ptyId: 'pty' }
    run.phase = { kind: 'failed', at: NOW, reason: 'stopped', tabClosed: false }
    const s = state(run)
    const orca: Observations['orca'] = { ok: true, agents: new Map([['/repo/todos', [{ paneKey: 'tab:pane', state: agentState, stateSince: NOW, agentType: 'codex', toolName: null, lastAssistantMessage: null }]]]), terminals: new Map(), hooks: null }
    const first = tick(s, observations({ orca }))
    expect(first.effects.some((effect) => effect.type === 'launch')).toBe(false)
    orca.agents.get('/repo/todos')![0].state = 'done'
    expect(tick(first.state, observations({ orca })).effects.filter((effect) => effect.type === 'launch')).toHaveLength(1)
  })

  it('an uncertain launch of recovery stops after 5 minutes and does not repeat the normal launch recovery', () => {
    const s = state()
    advanceIncidents(s, observations(), [])
    s.runs[1].phase = { kind: 'launching', since: '2026-10-24T02:50:00.000Z' }
    const next = tick(s, observations())
    expect(next.effects.some((effect) => effect.type === 'launch')).toBe(false)
    expect(next.state.runs[1].phase).toMatchObject({ kind: 'failed', reason: expect.stringContaining('duplicate') })
    const after = tick(next.state, observations())
    expect(after.state.runs).toHaveLength(2)
    expect(after.state.runs[0].incident?.status).toBe('blocked')
  })

  it('an apply done without verification results is not treated as success', () => {
    const s = approved()
    const child = s.runs[2]
    child.phase = { kind: 'running', agent: 'working', agentSince: NOW, closeAttempts: 0 }
    child.orca = { handle: 'term', tabId: 'tab', paneKey: 'tab:pane', ptyId: 'pty' }
    const next = tick(s, observations({ results: { [child.id]: { raw: JSON.stringify({ status: 'done', summary: 'finished', links: [] }), mtime: NOW } } }))
    expect(next.state.runs[2].phase.kind).toBe('failed')
    expect(next.state.runs[0].incident?.status).not.toBe('resolved')
  })

  it('rejects an invalid proposal, a relative path, empty actions and a tampered revision', () => {
    expect(parseProposal({ ...proposal, actions: [] })).toBeNull()
    expect(parseProposal({ ...proposal, changes: [{ path: '../todos', head: 'a'.repeat(40), summary: 'fix' }] })).toBeNull()
    expect(validIncident({ ...openIncident(NOW), status: 'awaiting_approval', proposal: { revision: '0'.repeat(64), body: proposal } })).toBe(false)
    const effects: Effect[] = []
    const s = prepared()
    advanceIncidents(s, observations(), effects)
    expect(effects).toEqual([])
  })
})

describe('G5: normalization of re-proposals and launch permission', () => {
  const original: Proposal = {
    ...proposal,
    changes: [
      { path: '/repo/a', head: 'a'.repeat(40), summary: 'config fix' },
      { path: '/repo/b', head: 'b'.repeat(40), summary: 'doc fix' },
    ],
    actions: ['apply the fix', 'run the tests'],
  }

  function reproposed(body: Proposal): State {
    const s = approved(original)
    s.runs[2].phase = { kind: 'failed', at: NOW, reason: 'new verification error after applying', tabClosed: true }
    advanceIncidents(s, observations(), [])
    expect(s.runs).toHaveLength(4)
    const task = s.runs[3]
    expect(task.recovery?.stage).toBe('prepare')
    task.phase = { kind: 'done', at: NOW, summary: 're-investigation', tabClosed: true }
    task.recoveryResult = { status: 'done', summary: 're-proposal', links: [], proposal: body }
    advanceIncidents(s, observations(), [])
    return s
  }

  it.each([
    ['changes order with different paths', { ...original, changes: [...original.changes].reverse() }],
    ['actions order', { ...original, actions: [...original.actions].reverse() }],
    ['whitespace around actions', { ...original, actions: original.actions.map((action) => ` \t${action}\n `) }],
    ['descriptions only', { ...original, summary: 'different description', cause: 'cause in detail', evidence: ['added description'], validation: ['validation in detail'], risks: ['risks in detail'], changes: original.changes.map((change) => ({ ...change, summary: 'description in detail' })) }],
    ['combination of order and whitespace', { ...original, changes: [...original.changes].reverse(), actions: [...original.actions].reverse().map((action) => ` ${action} `) }],
  ])('a re-proposal changing only %s is blocked and adds no apply', (_name, body) => {
    const s = reproposed(body)
    expect(s.runs[0].incident?.status).toBe('blocked')
    expect(s.runs[0].incident?.proposal).toBeUndefined()
    const next = tick(s, observations())
    expect(next.effects.filter((effect) => effect.type === 'launch')).toEqual([])
    expect(next.state.runs).toHaveLength(4)
    expect(next.state.runs.filter((run) => run.recovery?.stage === 'apply')).toHaveLength(1)
  })

  it.each([
    ['changes.head', { ...original, changes: [{ ...original.changes[0], head: 'c'.repeat(40) }, original.changes[1]] }],
    ['action content', { ...original, actions: ['apply a new fix', original.actions[1]] }],
  ])('a re-proposal changing %s puts the new revision into awaiting approval', (_name, body) => {
    const s = reproposed(body)
    expect(s.runs[0].incident).toMatchObject({ status: 'awaiting_approval', proposal: { body, revision: proposalRevision(body) } })
    expect(s.runs[0].incident?.proposal?.revision).not.toBe(proposalRevision(original))
    expect(s.runs.filter((run) => run.recovery?.stage === 'apply')).toHaveLength(1)
    expect(tick(s, observations()).effects.filter((effect) => effect.type === 'launch')).toEqual([])
  })

  it.each(['prepare', 'apply'] as const)('a queued %s is cancelled without launching when the configured repo/account changes', (stage) => {
    for (const changed of [{ repo: 'other/todos' }, { githubAccount: 'other-user' }]) {
      const s = stage === 'apply' ? approved() : state()
      if (stage === 'prepare') advanceIncidents(s, observations(), [])
      const child = s.runs.at(-1)!
      expect(child.phase.kind).toBe('queued')
      const next = tick(s, observations({ config: { ...config, projects: [{ ...config.projects[0], ...changed }] } }))
      expect(next.effects.filter((effect) => effect.type === 'launch')).toEqual([])
      expect(next.state.runs.find((run) => run.id === child.id)?.phase.kind).toBe('aborted')
      expect(next.state.runs).toHaveLength(s.runs.length)
    }
  })

  it.each([undefined, '0'.repeat(64)])('a queued apply is cancelled without launching when its approved revision has expired: %s', (revision) => {
    const s = approved()
    s.runs[0].incident!.approvedRevision = revision
    const next = tick(s, observations())
    expect(next.effects.filter((effect) => effect.type === 'launch')).toEqual([])
    expect(next.state.runs[2].phase.kind).toBe('aborted')
    expect(next.state.runs).toHaveLength(3)
  })

  it.each(['source', 'prepare'] as const)('even when the preceding %s has no agent, waits on an incomplete listing or a remaining tab, and launches exactly one after the disappearance is confirmed on a complete listing', (peerKind) => {
    const s = approved()
    const peer = s.runs[peerKind === 'source' ? 0 : 1]
    const ref = { handle: 'term', tabId: 'tab', paneKey: 'tab:pane', ptyId: 'pty' }
    peer.orca = ref
    peer.phase = { kind: 'failed', at: NOW, reason: 'already stopped', tabClosed: false }
    const orca: Extract<Observations['orca'], { ok: true }> = { ok: true, agents: new Map(), terminals: new Map(), hooks: null }
    orca.terminals.set(peer.target.path, { terminals: [], complete: false })
    const incomplete = tick(s, observations({ orca }))
    expect(incomplete.state.runs[2].phase.kind).toBe('queued')
    expect(incomplete.effects.filter((effect) => effect.type === 'launch')).toEqual([])
    orca.terminals.set(peer.target.path, { complete: true, terminals: [{ handle: ref.handle, tabId: ref.tabId, leafId: 'pane', ptyId: ref.ptyId, orphaned: false, title: null }] })
    const present = tick(incomplete.state, observations({ orca }))
    expect(present.state.runs[2].phase.kind).toBe('queued')
    expect(present.effects.filter((effect) => effect.type === 'launch')).toEqual([])
    orca.terminals.set(peer.target.path, { terminals: [], complete: true })
    const gone = tick(present.state, observations({ orca }))
    expect(gone.effects.filter((effect) => effect.type === 'launch')).toEqual([{ type: 'launch', runId: s.runs[2].id }])
    expect(gone.state.runs[2].phase.kind).toBe('launching')
    expect(gone.state.runs).toHaveLength(3)
    expect(tick(gone.state, observations({ orca })).effects.filter((effect) => effect.type === 'launch')).toEqual([])
  })
})

describe('handling of an uncertain preceding launch', () => {
  it('additional evidence alone does not ignore an uncertain launch; confirms the exit after the pane is obtained late', () => {
    const s = state()
    advanceIncidents(s, observations(), [])
    const child = s.runs[1]
    child.phase = { kind: 'failed', at: NOW, reason: 'launch result unknown; not relaunching to avoid a duplicate run', tabClosed: false, launchFailed: true }
    child.launchUncertain = true
    advanceIncidents(s, observations(), [])
    expect(serveIncidentRequest(s, s.runs[0], { type: 'investigate', runId: ROOT, evidence: 'evidence added' }, NOW)).toContain('unconfirmed')
    expect(s.runs).toHaveLength(2)
    const ref = { handle: 'late', tabId: 'tab-late', paneKey: 'tab-late:pane', ptyId: 'pty-late' }
    const after = tick(s, observations({ panes: { [child.id]: ref }, orca: { ok: true, agents: new Map(), terminals: new Map([['/repo/todos', { terminals: [], complete: true }]]), hooks: null } }))
    expect(after.state.runs[1].launchUncertain).toBeUndefined()
    expect(after.state.runs[1].phase).toMatchObject({ tabClosed: false })
    expect(serveIncidentRequest(after.state, after.state.runs[0], { type: 'investigate', runId: ROOT, evidence: 'exit confirmed' }, NOW)).toBeNull()
  })
})

describe('late pane and observation order', () => {
  it('does not treat an empty listing before the pane is obtained as exited, and waits after seeing working in the next cycle', () => {
    const s = state()
    advanceIncidents(s, observations(), [])
    const child = s.runs[1]
    child.phase = { kind: 'failed', at: NOW, reason: 'launch result unknown; not relaunching to avoid a duplicate run', tabClosed: false, launchFailed: true }
    child.launchUncertain = true
    advanceIncidents(s, observations(), [])
    const ref = { handle: 'late', tabId: 'tab-late', paneKey: 'tab-late:pane', ptyId: 'pty-late' }
    const empty: Observations['orca'] = { ok: true, agents: new Map(), terminals: new Map([['/repo/todos', { terminals: [], complete: true }]]), hooks: null }
    const recovered = tick(s, observations({ panes: { [child.id]: ref }, orca: empty }))
    expect(recovered.state.runs[1].phase).toMatchObject({ tabClosed: false })
    expect(serveIncidentRequest(recovered.state, recovered.state.runs[0], { type: 'investigate', runId: ROOT, evidence: 'recovered the reference' }, NOW)).toBeNull()
    const running: Observations['orca'] = { ...empty, agents: new Map([['/repo/todos', [{ paneKey: ref.paneKey, state: 'working', stateSince: NOW, agentType: 'codex', toolName: null, lastAssistantMessage: null }]]]) }
    const later = tick(recovered.state, observations({ now: '2026-10-24T03:00:20.000Z', orca: running }))
    expect(later.effects.some((effect) => effect.type === 'launch')).toBe(false)
    expect(later.state.runs[1].phase).toMatchObject({ tabClosed: false })
    const stopped = tick(later.state, observations({ now: '2026-10-24T03:00:40.000Z', orca: empty }))
    expect(stopped.state.runs[1].phase).toMatchObject({ tabClosed: true })
    expect(stopped.effects.filter((effect) => effect.type === 'launch')).toHaveLength(1)
  })

  it('an empty pane reference does not clear the uncertain launch marker', () => {
    const s = state()
    advanceIncidents(s, observations(), [])
    s.runs[1].phase = { kind: 'failed', at: NOW, reason: 'launch result unknown; not relaunching to avoid a duplicate run', tabClosed: false, launchFailed: true }
    s.runs[1].launchUncertain = true
    const after = tick(s, observations({ panes: { [s.runs[1].id]: { handle: '', tabId: '', paneKey: '', ptyId: '' } } }))
    expect(after.state.runs[1].launchUncertain).toBe(true)
    expect(after.state.runs[1].orca).toBeNull()
  })
})

describe('an apply failure returns to investigation by launchFailed, not by the wording of the reason', () => {
  const launchingSince = '2026-10-24T02:50:00.000Z'

  it.each([
    ['applyLaunch reports a launch failure', (s: State) => applyLaunch(s, s.runs[2].id, { ok: false, error: 'no_pane_key' }, NOW)],
    ['no pane appears within LAUNCH_RECOVERY_MS', (s: State) => tick(s, observations()).state],
  ])('%s: the apply child is marked launchFailed and the incident stays blocked without a new investigation', (_name, failLaunch) => {
    const s = approved()
    s.runs[2].phase = { kind: 'launching', since: launchingSince }
    const failed = failLaunch(s)
    expect(failed.runs[2].phase).toMatchObject({ kind: 'failed', at: NOW, tabClosed: false, launchFailed: true })
    const next = tick(failed, observations())
    expect(next.state.runs).toHaveLength(3)
    expect(next.state.runs[0].incident?.status).toBe('blocked')
    expect(next.effects.filter((effect) => effect.type === 'launch')).toEqual([])
  })

  it.each([
    ['launchFailed with any reason', { kind: 'failed', at: NOW, reason: 'anything else', tabClosed: true, launchFailed: true }, 'blocked', 3],
    ['no launchFailed with a reason that reads like a launch failure', { kind: 'failed', at: NOW, reason: 'launch failed: x', tabClosed: true }, 'investigating', 4],
  ] as const)('%s', (_name, phase, status, runs) => {
    const s = approved()
    s.runs[2].phase = { ...phase }
    advanceIncidents(s, observations(), [])
    expect(s.runs[0].incident?.status).toBe(status)
    expect(s.runs).toHaveLength(runs)
  })

  it('truncates the reason itself to 8000 characters, so the stage prefix does not move the cut', () => {
    const s = approved()
    const reason = `${'x'.repeat(7999)}ab`
    s.runs[2].phase = { kind: 'failed', at: NOW, reason, tabClosed: true }
    advanceIncidents(s, observations(), [])
    expect(s.runs[0].incident?.evidence.at(-1)).toBe(`apply: ${'x'.repeat(7999)}a`)
  })
})

describe('SPEC-ENGLISH-OUTPUT-001 conditions: the retry decision depends on launchFailed only', () => {
  const failedPhase = (reason: string, launchFailed?: true): Run['phase'] => ({ kind: 'failed', at: NOW, reason, tabClosed: false, ...(launchFailed === undefined ? {} : { launchFailed }) })

  it('A2-1 / A7-1: an approved apply child that failed to launch (launchFailed, approved revision, no verification) leaves the incident blocked with no new investigation', () => {
    const s = approved()
    const incident = s.runs[0].incident!
    expect(incident.approvedRevision).toBe(incident.proposal!.revision)
    const tasksBefore = [...incident.tasks]
    s.runs[2].phase = failedPhase('launch failed: x', true)
    const effects: Effect[] = []
    advanceIncidents(s, observations(), effects)
    expect(incident.status).toBe('blocked')
    expect(s.runs).toHaveLength(3)
    expect(incident.tasks).toEqual(tasksBefore)
    expect(incident.approvedRevision).toBeUndefined()
    expect(incident.evidence).toEqual(['apply: launch failed: x'])
    expect(effects.map((effect) => (effect.type === 'notify' ? effect.title : effect.type))).toEqual(['orcapod: incident on hold'])
  })

  it('A2-2: launchFailed with a reason that reads like an ordinary failure still blocks', () => {
    const s = approved()
    s.runs[2].phase = failedPhase('anything else', true)
    advanceIncidents(s, observations(), [])
    expect(s.runs[0].incident?.status).toBe('blocked')
    expect(s.runs).toHaveLength(3)
  })

  it('A2-3: a launch-sounding reason without launchFailed goes pending and starts an investigation within the same call (runs 3 to 4)', () => {
    const s = approved()
    expect(s.runs).toHaveLength(3)
    s.runs[2].phase = failedPhase('launch failed: x')
    advanceIncidents(s, observations(), [])
    expect(s.runs[0].incident?.status).toBe('investigating')
    expect(s.runs).toHaveLength(4)
    expect(s.runs[3].recovery).toMatchObject({ stage: 'prepare', evidence: ['DB permission scope mismatch', 'apply: launch failed: x'] })
  })

  it.each([
    ['launchFailed set', failedPhase('launch failed: x', true)],
    ['launchFailed not set and a reason that is not about launching', failedPhase('verification failed')],
    ['launchFailed not set and a reason that reads like a launch failure', failedPhase('launch failed: x')],
  ])('A2-5: a failing prepare child never re-enters investigation by itself (%s), the stage condition applies first', (_name, phase) => {
    const s = state()
    advanceIncidents(s, observations(), [])
    s.runs[1].phase = phase
    for (let i = 0; i < 3; i++) advanceIncidents(s, observations(), [])
    expect(s.runs[0].incident?.status).toBe('blocked')
    expect(s.runs).toHaveLength(2)
  })

  it('A2-5: a parent run whose launch failed gets an incident opened and is investigated, because the decision is never applied to it', () => {
    const parent: Run = { ...root(), phase: { kind: 'launching', since: NOW } }
    const launched = applyLaunch(state(parent), ROOT, { ok: false, error: 'no_pane_key' }, NOW)
    expect(launched.runs[0].phase).toEqual({ kind: 'failed', at: NOW, reason: 'launch failed: no_pane_key', tabClosed: false, launchFailed: true })
    expect(launched.runs[0].incident).toMatchObject({ status: 'pending' })
    advanceIncidents(launched, observations(), [])
    expect(launched.runs[0].incident?.status).toBe('investigating')
    expect(launched.runs).toHaveLength(2)
    expect(launched.runs[1].recovery).toMatchObject({ stage: 'prepare', evidence: ['launch failed: no_pane_key'] })
  })

  it('A7-2: an apply child that failed verification without launchFailed returns to investigation in the same call (runs +1)', () => {
    const s = approved()
    s.runs[2].phase = failedPhase('verification failed')
    advanceIncidents(s, observations(), [])
    expect(s.runs[0].incident?.status).toBe('investigating')
    expect(s.runs).toHaveLength(4)
  })

  it('A7-3: at the investigation limit an ordinary apply failure still blocks and starts nothing', () => {
    const s = approved()
    const incident = s.runs[0].incident!
    const spares = [1, 2].map((n): Run => ({ ...structuredClone(s.runs[1]), id: `20261024-0300-spare${n}` }))
    s.runs.push(...spares)
    incident.tasks.unshift(...spares.map((spare) => spare.id))
    expect(incident.tasks.filter((id) => s.runs.some((run) => run.id === id && run.recovery?.stage === 'prepare'))).toHaveLength(3)
    s.runs[2].phase = failedPhase('verification failed')
    advanceIncidents(s, observations(), [])
    expect(incident.status).toBe('blocked')
    expect(s.runs).toHaveLength(5)
  })

  describe('A7-4 (I12): the evidence identity does not depend on the length of the stage prefix', () => {
    const PREFIX = 'AI reported failed: '

    function secondApplyFailure(summaryA: string, summaryB: string) {
      const s = approved()
      const reasonA = `${PREFIX}${summaryA}`
      const reasonB = `${PREFIX}${summaryB}`
      s.runs[2].phase = failedPhase(reasonA)
      advanceIncidents(s, observations(), [])
      expect(s.runs[0].incident?.status).toBe('investigating')
      s.runs[3].phase = { kind: 'done', at: NOW, summary: 'investigation', tabClosed: true }
      s.runs[3].recoveryResult = { status: 'done', summary: 'second proposal', links: [], proposal: { ...proposal, actions: ['a different operation that was approved the second time'] } }
      advanceIncidents(s, observations(), [])
      expect(s.runs[0].incident?.status).toBe('awaiting_approval')
      const revision = s.runs[0].incident!.proposal!.revision
      expect(serveIncidentRequest(s, s.runs[0], { type: 'approve', runId: ROOT, revision }, NOW)).toBeNull()
      expect(s.runs).toHaveLength(5)
      s.runs[4].phase = failedPhase(reasonB)
      advanceIncidents(s, observations(), [])
      return { s, reasonA, reasonB }
    }

    it('summaries differing only at reason index 7995 (inside the window an 8000-character cut of "apply: " + reason would lose) are different evidence: investigating again', () => {
      const { s, reasonA, reasonB } = secondApplyFailure(`${'x'.repeat(7975)}a`, `${'x'.repeat(7975)}b`)
      expect(reasonA.indexOf('a', 7900)).toBe(7995)
      expect(`apply: ${reasonA}`.slice(0, 8000)).toBe(`apply: ${reasonB}`.slice(0, 8000))
      expect(s.runs[0].incident?.status).toBe('investigating')
      expect(s.runs).toHaveLength(6)
      expect(s.runs[0].incident?.evidence).toHaveLength(2)
    })

    it('summaries identical for the first 8000 characters of the reason are the same evidence (existing rule, R7): blocked', () => {
      const { s } = secondApplyFailure(`${'x'.repeat(8000)}a`, `${'x'.repeat(8000)}b`)
      expect(s.runs[0].incident?.status).toBe('blocked')
      expect(s.runs).toHaveLength(5)
    })

    it('the input from the plan (7990 characters then a / b) differs only beyond the 8000-character cut of the reason, so it is the same evidence (added: shows why the plan value does not reach the I12 window)', () => {
      const { s, reasonA } = secondApplyFailure(`${'x'.repeat(7990)}a`, `${'x'.repeat(7990)}b`)
      expect(reasonA.indexOf('a', 7900)).toBe(8010)
      expect(s.runs[0].incident?.status).toBe('blocked')
    })
  })
})
