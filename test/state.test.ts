import { existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openIncident, proposalRevision } from '../src/incident-contract.ts'
import { lockPath, requestsDir, stateDir, statePath } from '../src/paths.ts'
import { acquireDaemonLock, consumeRequest, liveDaemonPid, loadState, newRunId, processedKey, readRequests, readStateSnapshot, releaseDaemonLock, saveState, writeRequest } from '../src/state.ts'
import type { Item, Proposal, Run, State } from '../src/types.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, linkSync: vi.fn(actual.linkSync), openSync: vi.fn(actual.openSync) }
})

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')

const DEAD_PID = 99999999

const item: Item = {
  project: 'todos',
  repo: 'taylor/todos',
  target: 'issue',
  number: 123,
  title: 'Inventory list',
  url: 'https://github.com/taylor/todos/issues/123',
  labels: ['impl'],
  author: { login: 'taylor', bot: false, association: 'OWNER' },
}

const savedState: State = {
  version: 1,
  processed: [{ key: '["todos","issue",123,"impl"]', seenAt: '2026-10-23T00:12:00.000Z' }],
  pending: [{ ruleKey: '["todos","issue","impl"]', project: 'todos', items: [item], fireAt: '2026-10-23T00:17:00.000Z' }],
  runs: [],
  watchedRules: ['["todos","issue","impl"]'],
  lastPolledAt: { todos: '2026-10-23T00:12:00.000Z' },
  projectErrors: {},
  orcaOutageSince: null,
  consumedRequests: [],
  configStatus: null,
  daemonInfo: null,
}

const emptyState: State = {
  version: 1,
  processed: [],
  pending: [],
  runs: [],
  watchedRules: [],
  lastPolledAt: {},
  projectErrors: {},
  orcaOutageSince: null,
  consumedRequests: [],
  configStatus: null,
  daemonInfo: null,
}

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orcapod-state-'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.mocked(linkSync).mockImplementation(actualFs.linkSync)
  vi.mocked(openSync).mockImplementation(actualFs.openSync)
  rmSync(home, { recursive: true, force: true })
})

function writeStateFile(content: string): void {
  mkdirSync(stateDir(home), { recursive: true })
  writeFileSync(statePath(home), content)
}

describe('loadState', () => {
  it('an empty initial state when state.json is missing', () => {
    expect(loadState(home)).toEqual(emptyState)
  })

  it('loads exactly what saveState saved', () => {
    saveState(home, savedState)
    expect(loadState(home)).toEqual(savedState)
  })

  it('throws when the file is not valid JSON', () => {
    writeStateFile('{"version":1,')
    expect(() => loadState(home)).toThrow(`${statePath(home)} is corrupt: `)
  })

  it('throws when version is not 1', () => {
    writeStateFile(JSON.stringify({ ...emptyState, version: 2 }))
    expect(() => loadState(home)).toThrow(`${statePath(home)} is corrupt: version is not 1: 2`)
  })

  it('throws when an array field is missing', () => {
    writeStateFile(JSON.stringify({ ...emptyState, runs: undefined }))
    expect(() => loadState(home)).toThrow(`${statePath(home)} is corrupt: runs is not an array`)
  })

  it('throws when orcaOutageSince is neither a string nor null', () => {
    writeStateFile(JSON.stringify({ ...emptyState, orcaOutageSince: 0 }))
    expect(() => loadState(home)).toThrow(`${statePath(home)} is corrupt: orcaOutageSince is neither a string nor null`)
  })

  const run: Run = {
    id: '20261023-0017-3f9a1c',
    project: 'todos',
    target: { path: '/Users/taylor/git/todos', repo: 'taylor/todos', githubAccount: 'taylor' },
    rule: { target: 'issue', label: 'impl', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 5, enabled: true, bootstrap: 'skip' },
    kindName: 'Feature',
    items: [item],
    createdAt: '2026-10-23T00:17:00.000Z',
    startedAt: null,
    phase: { kind: 'queued', since: '2026-10-23T00:17:00.000Z' },
    history: [{ kind: 'queued', at: '2026-10-23T00:17:00.000Z' }],
    orca: null,
    notified: [],
    bypassLimit: false,
    manual: false,
    lastMessage: null,
  }

  const proposal: Proposal = { summary: 'fix the config', cause: 'the config is stale', evidence: ['a diff exists'], changes: [], validation: ['unit tests pass'], actions: ['apply the fix'], risks: [] }
  const snapshot = { revision: proposalRevision(proposal), body: proposal }
  const incident = { ...openIncident(run.createdAt), status: 'applying' as const, proposal: snapshot, approvedRevision: snapshot.revision }

  it.each([
    ['incident', { incident: { ...incident, proposal: { ...snapshot, revision: '0'.repeat(64) } } }],
    ['recovery', { recovery: { sourceRunId: run.id, stage: 'apply', evidence: [] } }],
    ['recoveryResult.proposal', { recoveryResult: { status: 'done', summary: 'investigated', links: [], proposal: { ...proposal, actions: [] } } }],
    ['recoveryResult.verification', { recoveryResult: { status: 'done', summary: 'applied', links: [], verification: 'passed' } }],
    ['paneRecoveredAt', { paneRecoveredAt: 123 }],
    ['launchUncertain', { launchUncertain: 'true' }],
  ])('G4: loadState and snapshot reject an invalid %s and keep the original JSON', (field, overrides) => {
    const original = JSON.stringify({ ...savedState, runs: [{ ...run, ...overrides }] })
    writeStateFile(original)
    const error = `${statePath(home)} is corrupt: runs[0].${field}`
    expect(() => loadState(home)).toThrow(error)
    expect(readStateSnapshot(home)).toMatchObject({ kind: 'error', message: expect.stringContaining(error) })
    expect(readFileSync(statePath(home), 'utf8')).toBe(original)
  })

  it('G4: restores a valid incident/recovery/recoveryResult and the recovery flags without loss or alteration', () => {
    const childId = '20261023-0017-bbbbbb'
    const full: State = {
      ...savedState,
      runs: [
        { ...run, phase: { kind: 'failed', at: run.createdAt, reason: 'config error', tabClosed: true }, incident: { ...incident, tasks: [childId] } },
        { ...run, id: childId, phase: { kind: 'done', at: run.createdAt, summary: 'applied', tabClosed: true },
          recovery: { sourceRunId: run.id, stage: 'apply', evidence: ['diff checked'], proposal: snapshot },
          recoveryResult: { status: 'done', summary: 'verified', links: ['https://example.com/result'], proposal, verification: ['tests pass'] },
          paneRecoveredAt: run.createdAt, launchUncertain: false },
      ],
    }
    saveState(home, full)
    const original = readFileSync(statePath(home), 'utf8')
    expect(loadState(home)).toEqual(full)
    expect(readStateSnapshot(home)).toEqual({ kind: 'ok', state: full, mtime: statSync(statePath(home)).mtime.toISOString() })
    expect(readFileSync(statePath(home), 'utf8')).toBe(original)
  })

  const configStatus = { loadedAt: '2026-10-23T00:10:00.000Z', sha256: 'f592d9dda76b68357b4dbab16c16d11f30483cd7294ae0a6329c8c28d40bfca1', error: null }

  it.each([{ authors: [] }, { authors: ['OWNER', 'MEMBER'] }] as const)('saves and restores the rule authors $authors', ({ authors }) => {
    const withAuthors = { ...run, rule: { ...run.rule, authors: [...authors] } }
    saveState(home, { ...savedState, runs: [withAuthors] })
    expect(loadState(home).runs).toEqual([withAuthors])
  })
  const daemonInfo = { pid: 4242, startedAt: '2026-10-23T00:00:00.000Z', lastCycleAt: '2026-10-23T00:20:00.000Z', lastCycleError: null, orcaVersion: '1.4.217', cycleSeconds: 20 }

  it('X1-11: loads a state.json containing a well-formed run', () => {
    saveState(home, { ...savedState, runs: [run] })
    expect(loadState(home).runs).toEqual([run])
  })

  it('loads as-is a state.json whose configStatus and daemonInfo have values and whose failed phase has tabClosed, with and without launchFailed', () => {
    const failed: Run = { ...run, phase: { kind: 'failed', at: '2026-10-23T00:20:00.000Z', reason: 'x', tabClosed: true } }
    const launchFailed: Run = { ...run, id: '20261023-0017-bbbbbb', phase: { kind: 'failed', at: '2026-10-23T00:20:00.000Z', reason: 'launch failed: x', tabClosed: false, launchFailed: true } }
    const full: State = {
      ...savedState,
      runs: [failed, launchFailed],
      configStatus: { ...configStatus, error: 'version: 1 is required (got: 2)' },
      daemonInfo: { ...daemonInfo, lastCycleError: { at: '2026-10-23T00:19:40.000Z', message: 'x' }, orcaVersion: null, cycleSeconds: 0.5 },
    }
    saveState(home, full)
    expect(loadState(home)).toEqual(full)
  })

  it('A49: fills a 001-shaped state.json (no configStatus or daemonInfo, no tabClosed on failed) with null and false, and does not rewrite the file', () => {
    const phase001 = { kind: 'failed', at: '2026-10-23T00:20:00.000Z', reason: 'launch failed: x' }
    const runs = [{ ...run, phase: phase001 }, { ...run, id: '20261023-0017-bbbbbb', phase: phase001, orca: { handle: 'term_a', tabId: 'tab-a', paneKey: 'tab-a:leaf-a', ptyId: 'pty-a' } }]
    const content = JSON.stringify({ version: 1, processed: [], pending: [], runs, watchedRules: [], lastPolledAt: {}, projectErrors: {}, orcaOutageSince: null, consumedRequests: [] })
    writeStateFile(content)
    const loaded = loadState(home)
    expect([loaded.configStatus, loaded.daemonInfo, loaded.runs.map((r) => r.phase)]).toEqual([null, null, [{ ...phase001, tabClosed: false }, { ...phase001, tabClosed: false }]])
    expect(readFileSync(statePath(home), 'utf8')).toBe(content)
  })

  it.each([
    ['6 digits', new Set<string>(), '20261023-0917-ae2ce7'],
    ['7 digits extended after a collision', new Set(['20261023-0917-ae2ce7']), '20261023-0917-ae2ce7b'],
    ['8 digits extended after a further collision', new Set(['20261023-0917-ae2ce7', '20261023-0917-ae2ce7b']), '20261023-0917-ae2ce7b7'],
  ])('an id made by newRunId (%s) passes the format check', (_name, existing, expected) => {
    const id = newRunId('2026-10-23T09:17:42.123Z', '["todos","issue","impl"]|123|0', existing)
    expect(id).toBe(expected)
    saveState(home, { ...savedState, runs: [{ ...run, id }] })
    expect(loadState(home).runs.map((r) => r.id)).toEqual([expected])
  })

  it('loads an id whose hash is the full 40-digit sha1', () => {
    const id = `20261023-0917-${'a'.repeat(40)}`
    saveState(home, { ...savedState, runs: [{ ...run, id }] })
    expect(loadState(home).runs.map((r) => r.id)).toEqual([id])
  })

  it.each([
    ['empty object as a runs element', { runs: [{}] }, 'runs[0].id is not a string'],
    ['A50: null as a runs element', { runs: [null] }, 'runs[0] is not an object'],
    ['A50: phase is null', { runs: [{ ...run, phase: null }] }, 'runs[0].phase is not an object'],
    ['failed tabClosed is not a boolean', { runs: [{ ...run, phase: { kind: 'failed', at: '2026-10-23T00:20:00.000Z', reason: 'x', tabClosed: 'yes' } }] }, 'runs[0].phase.tabClosed is not a boolean'],
    ['failed tabClosed is null', { runs: [{ ...run, phase: { kind: 'failed', at: '2026-10-23T00:20:00.000Z', reason: 'x', tabClosed: null } }] }, 'runs[0].phase.tabClosed is not a boolean'],
    ['failed launchFailed is false', { runs: [{ ...run, phase: { kind: 'failed', at: '2026-10-23T00:20:00.000Z', reason: 'x', tabClosed: true, launchFailed: false } }] }, 'runs[0].phase.launchFailed is not true'],
    ['failed launchFailed is a string', { runs: [{ ...run, phase: { kind: 'failed', at: '2026-10-23T00:20:00.000Z', reason: 'x', tabClosed: true, launchFailed: 'yes' } }] }, 'runs[0].phase.launchFailed is not true'],
    ['failed launchFailed is 1', { runs: [{ ...run, phase: { kind: 'failed', at: '2026-10-23T00:20:00.000Z', reason: 'x', tabClosed: true, launchFailed: 1 } }] }, 'runs[0].phase.launchFailed is not true'],
    ['failed launchFailed is null', { runs: [{ ...run, phase: { kind: 'failed', at: '2026-10-23T00:20:00.000Z', reason: 'x', tabClosed: true, launchFailed: null } }] }, 'runs[0].phase.launchFailed is not true'],
    ['configStatus is a number', { configStatus: 0 }, 'configStatus is neither null nor an object'],
    ['configStatus loadedAt is missing', { configStatus: { ...configStatus, loadedAt: undefined } }, 'configStatus.loadedAt is not a string'],
    ['configStatus sha256 is uppercase', { configStatus: { ...configStatus, sha256: configStatus.sha256.toUpperCase() } }, 'configStatus.sha256 is not 64 lowercase hex digits'],
    ['configStatus sha256 has 63 digits', { configStatus: { ...configStatus, sha256: configStatus.sha256.slice(1) } }, 'configStatus.sha256 is not 64 lowercase hex digits'],
    ['configStatus error is a number', { configStatus: { ...configStatus, error: 1 } }, 'configStatus.error is not a string or null'],
    ['daemonInfo is an array', { daemonInfo: [] }, 'daemonInfo is neither null nor an object'],
    ['daemonInfo pid is 0', { daemonInfo: { ...daemonInfo, pid: 0 } }, 'daemonInfo.pid is not a positive integer'],
    ['daemonInfo pid is fractional', { daemonInfo: { ...daemonInfo, pid: 1.5 } }, 'daemonInfo.pid is not a positive integer'],
    ['daemonInfo lastCycleAt is missing', { daemonInfo: { ...daemonInfo, lastCycleAt: undefined } }, 'daemonInfo.lastCycleAt is not a string'],
    ['daemonInfo lastCycleError has no message', { daemonInfo: { ...daemonInfo, lastCycleError: { at: '2026-10-23T00:20:00.000Z' } } }, 'daemonInfo.lastCycleError is not an at / message pair or null'],
    ['daemonInfo orcaVersion is a number', { daemonInfo: { ...daemonInfo, orcaVersion: 1 } }, 'daemonInfo.orcaVersion is not a string or null'],
    ['daemonInfo cycleSeconds is 0', { daemonInfo: { ...daemonInfo, cycleSeconds: 0 } }, 'daemonInfo.cycleSeconds is not a positive number'],
    ['id is a relative path escaping runs/', { runs: [{ ...run, id: '../../outside' }] }, 'runs[0].id is not a valid run ID'],
    ['id is a relative path pointing at src/', { runs: [{ ...run, id: '../src' }] }, 'runs[0].id is not a valid run ID'],
    ['id is a name not shaped like a run ID', { runs: [{ ...run, id: 'run-a' }] }, 'runs[0].id is not a valid run ID'],
    ['id is an empty string', { runs: [{ ...run, id: '' }] }, 'runs[0].id is not a valid run ID'],
    ['id hash has 5 digits', { runs: [{ ...run, id: '20261023-0017-3f9a1' }] }, 'runs[0].id is not a valid run ID'],
    ['id hash has 41 digits', { runs: [{ ...run, id: `20261023-0017-${'a'.repeat(41)}` }] }, 'runs[0].id is not a valid run ID'],
    ['id hash is uppercase', { runs: [{ ...run, id: '20261023-0017-3F9A1C' }] }, 'runs[0].id is not a valid run ID'],
    ['id is followed by a path', { runs: [{ ...run, id: '20261023-0017-3f9a1c/../../src' }] }, 'runs[0].id is not a valid run ID'],
    ['only the second id is broken', { runs: [run, { ...run, id: '../src' }] }, 'runs[1].id is not a valid run ID'],
    ['a runs element is not an object', { runs: [run, 'run-b'] }, 'runs[1] is not an object'],
    ['phase.kind is unknown', { runs: [{ ...run, phase: { kind: 'x' } }] }, 'runs[0].phase.kind is not one of queued / launching / starting / running / done / failed / aborted: "x"'],
    ['phase is missing', { runs: [{ ...run, phase: undefined }] }, 'runs[0].phase is not an object'],
    ['orca fields are incomplete', { runs: [{ ...run, orca: { handle: 'term_a' } }] }, 'runs[0].orca is not a pane reference or null'],
    ['rule ai is unknown', { runs: [{ ...run, rule: { ...run.rule, ai: 'gpt' } }] }, 'runs[0].rule is not a valid rule'],
    ['rule authors is a string', { runs: [{ ...run, rule: { ...run.rule, authors: 'OWNER' } }] }, 'runs[0].rule is not a valid rule'],
    ['rule authors contains an unknown value', { runs: [{ ...run, rule: { ...run.rule, authors: ['UNKNOWN'] } }] }, 'runs[0].rule is not a valid rule'],
    ['an items element is not an item', { runs: [{ ...run, items: [{ number: 1 }] }] }, 'runs[0].items is not an array of items'],
    ['pending items is not an array', { pending: [{ ...savedState.pending[0], items: null }] }, 'pending[0].items is not an array of items'],
    ['processed key is a number', { processed: [{ key: 1, seenAt: '2026-10-23T00:12:00.000Z' }] }, 'processed[0].key is not a string'],
    ['watchedRules contains a number', { watchedRules: [1] }, 'watchedRules is not an array of strings'],
    ['lastPolledAt value is a number', { lastPolledAt: { todos: 0 } }, 'lastPolledAt has a value that is not a string'],
    ['projectErrors value has no message', { projectErrors: { todos: { since: '2026-10-23T00:12:00.000Z' } } }, 'projectErrors has a value that is not a since / message pair'],
  ])('X1-11: throws when the content shape is broken (%s)', (_name, overrides, error) => {
    writeStateFile(JSON.stringify({ ...savedState, ...overrides }))
    expect(() => loadState(home)).toThrow(`${statePath(home)} is corrupt: ${error}`)
  })
})

describe('readStateSnapshot', () => {
  it('returns missing without creating state/ when state.json is absent', () => {
    expect(readStateSnapshot(home)).toEqual({ kind: 'missing' })
    expect(existsSync(stateDir(home))).toBe(false)
  })

  it('A48: returns what saveState saved paired with the file mtime', () => {
    saveState(home, savedState)
    expect(readStateSnapshot(home)).toEqual({ kind: 'ok', state: savedState, mtime: statSync(statePath(home)).mtime.toISOString() })
  })

  it('a 001-shaped state.json is filled in and returned, as loadState does', () => {
    writeStateFile(JSON.stringify({ version: 1, processed: [], pending: [], runs: [], watchedRules: [], lastPolledAt: {}, projectErrors: {}, orcaOutageSince: null, consumedRequests: [] }))
    expect(readStateSnapshot(home)).toEqual({ kind: 'ok', state: emptyState, mtime: statSync(statePath(home)).mtime.toISOString() })
  })

  it('L34: when the state.json location is a directory, loadState throws the corrupt-file message and readStateSnapshot does not throw but returns an error with the same message', () => {
    mkdirSync(statePath(home), { recursive: true })
    const snapshot = readStateSnapshot(home)
    let thrown = ''
    try {
      loadState(home)
    } catch (error) {
      thrown = (error as Error).message
    }
    expect(thrown).toBe(`${statePath(home)} is corrupt: EISDIR: illegal operation on a directory, read`)
    expect(snapshot).toEqual({ kind: 'error', message: thrown })
  })

  it('the error for an unopenable state.json (EACCES) also uses the "<path> is corrupt: …" message', () => {
    writeStateFile(JSON.stringify(savedState))
    vi.mocked(openSync).mockImplementationOnce(() => {
      throw Object.assign(new Error(`EACCES: permission denied, open '${statePath(home)}'`), { code: 'EACCES' })
    })
    expect(readStateSnapshot(home)).toEqual({ kind: 'error', message: `${statePath(home)} is corrupt: EACCES: permission denied, open '${statePath(home)}'` })
  })

  it.each([
    ['a broken shape', JSON.stringify({ ...savedState, runs: [{}] }), 'is corrupt: runs[0].id is not a string'],
    ['broken JSON', '{"version":1,', 'is corrupt: '],
  ])('state.json with %s is an error, and its message equals the one loadState throws', (_name, content, fragment) => {
    writeStateFile(content)
    const snapshot = readStateSnapshot(home)
    let thrown = ''
    try {
      loadState(home)
    } catch (error) {
      thrown = (error as Error).message
    }
    expect(snapshot).toEqual({ kind: 'error', message: thrown })
    expect(thrown).toContain(`${statePath(home)} ${fragment}`)
  })
})

describe('saveState', () => {
  it('creates state/ and writes on a first run without it, leaving no .tmp', () => {
    saveState(home, savedState)
    expect(readdirSync(stateDir(home))).toEqual(['state.json'])
    expect(JSON.parse(readFileSync(statePath(home), 'utf8'))).toEqual(savedState)
  })

  it('saves by overwriting a .tmp left by a previous save', () => {
    mkdirSync(stateDir(home), { recursive: true })
    writeFileSync(`${statePath(home)}.tmp`, '{"version":1,"proc')
    saveState(home, savedState)
    expect(readdirSync(stateDir(home))).toEqual(['state.json'])
    expect(loadState(home)).toEqual(savedState)
  })

  it('C28: the original state.json stays intact even when writing the temporary file fails', () => {
    saveState(home, savedState)
    mkdirSync(`${statePath(home)}.tmp`)
    expect(() => saveState(home, { ...savedState, runs: [], pending: [] })).toThrow()
    expect(loadState(home)).toEqual(savedState)
  })
})

describe('request files', () => {
  it('empty when requests/ is missing', () => {
    expect(readRequests(home)).toEqual([])
  })

  it('writeRequest returns a name of the form <ISO time>-<4 hex>.json, and readRequests returns that request', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T00:17:00.000Z'))
    const file = writeRequest(home, { type: 'stop', runId: '20261023-0017-3f9a1c' })
    expect(file).toMatch(/^2026-10-23T00:17:00\.000Z-[0-9a-f]{4}\.json$/)
    expect(readRequests(home)).toEqual([{ file, request: { type: 'stop', runId: '20261023-0017-3f9a1c' } }])
    expect(readdirSync(requestsDir(home))).toEqual([file])
  })

  it('a run request reads back with ai present or absent exactly as written', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T00:17:00.000Z'))
    const withAi = writeRequest(home, { type: 'run', project: 'todos', item, kind: 'feature', ai: 'codex', now: true })
    vi.setSystemTime(new Date('2026-10-23T00:18:00.000Z'))
    const withoutAi = writeRequest(home, { type: 'run', project: 'todos', item, kind: 'feature', now: false })
    expect(readRequests(home)).toEqual([
      { file: withAi, request: { type: 'run', project: 'todos', item, kind: 'feature', ai: 'codex', now: true } },
      { file: withoutAi, request: { type: 'run', project: 'todos', item, kind: 'feature', now: false } },
    ])
  })

  it('returns requests in file name (time) order, not write order', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T00:20:00.000Z'))
    const later = writeRequest(home, { type: 'rerun', runId: 'b' })
    vi.setSystemTime(new Date('2026-10-23T00:19:00.000Z'))
    const earlier = writeRequest(home, { type: 'stop', runId: 'a' })
    expect(readRequests(home).map((r) => r.file)).toEqual([earlier, later])
  })

  it('does not read a half-written .tmp', () => {
    mkdirSync(requestsDir(home), { recursive: true })
    writeFileSync(join(requestsDir(home), '2026-10-23T00:17:00.000Z-abcd.json.tmp'), '{"type":"st')
    expect(readRequests(home)).toEqual([])
  })

  it('returns a file unreadable as JSON as an error and still reads the other requests', () => {
    mkdirSync(requestsDir(home), { recursive: true })
    writeFileSync(join(requestsDir(home), '2026-10-23T00:17:00.000Z-aaaa.json'), '{"type":"st')
    writeFileSync(join(requestsDir(home), '2026-10-23T00:18:00.000Z-bbbb.json'), '{"type":"stop","runId":"x"}')
    expect(readRequests(home)).toEqual([
      { file: '2026-10-23T00:17:00.000Z-aaaa.json', error: expect.stringMatching(/^not valid JSON: /) },
      { file: '2026-10-23T00:18:00.000Z-bbbb.json', request: { type: 'stop', runId: 'x' } },
    ])
  })

  it.each([
    ['unknown type', { type: 'pause', runId: 'x' }, 'type is not run / stop / rerun: "pause"'],
    ['array', [], 'request is not an object'],
    ['stop without runId', { type: 'stop' }, 'runId is not a string'],
    ['run without project', { type: 'run', item, kind: 'feature', now: false }, 'project is not a string'],
    ['run item missing author', { type: 'run', project: 'todos', item: { ...item, author: undefined }, kind: 'feature', now: false }, 'item is malformed'],
    ['run item association outside the enumeration', { type: 'run', project: 'todos', item: { ...item, author: { login: 'x', bot: false, association: 'owner' } }, kind: 'feature', now: false }, 'item is malformed'],
    ['run ai outside the enumeration', { type: 'run', project: 'todos', item, kind: 'feature', ai: 'gpt', now: false }, 'ai is not claude / codex: "gpt"'],
    ['run now is not a boolean', { type: 'run', project: 'todos', item, kind: 'feature', now: 'yes' }, 'now is not a boolean'],
  ])('returns a malformed request (%s) as an error', (_name, content, error) => {
    mkdirSync(requestsDir(home), { recursive: true })
    writeFileSync(join(requestsDir(home), '2026-10-23T00:17:00.000Z-aaaa.json'), JSON.stringify(content))
    expect(readRequests(home)).toEqual([{ file: '2026-10-23T00:17:00.000Z-aaaa.json', error }])
  })

  it('consumeRequest deletes the request and does not throw for a missing file', () => {
    const file = writeRequest(home, { type: 'stop', runId: 'x' })
    consumeRequest(home, file)
    expect(readRequests(home)).toEqual([])
    expect(() => consumeRequest(home, file)).not.toThrow()
  })
})

describe('acquireDaemonLock', () => {
  function writeLock(content: string): void {
    mkdirSync(stateDir(home), { recursive: true })
    writeFileSync(lockPath(home), content)
  }

  it('acquires the lock when absent and writes its own pid', () => {
    expect(acquireDaemonLock(home, 4242)).toEqual({ ok: true })
    expect(readFileSync(lockPath(home), 'utf8')).toBe('4242\n')
  })

  it('C31: cannot acquire when a live pid holds it, and the lock is left untouched', () => {
    writeLock(`${process.pid}\n`)
    expect(acquireDaemonLock(home, 4242)).toEqual({ ok: false, holder: process.pid })
    expect(readFileSync(lockPath(home), 'utf8')).toBe(`${process.pid}\n`)
  })

  it('C31: cannot acquire when a live process of another user (kill returns EPERM) holds it', () => {
    const holder = 12345678
    writeLock(`${holder}\n`)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
    })
    try {
      expect(acquireDaemonLock(home, 4242)).toEqual({ ok: false, holder })
      expect(kill).toHaveBeenCalledWith(holder, 0)
      expect(readFileSync(lockPath(home), 'utf8')).toBe(`${holder}\n`)
    } finally {
      kill.mockRestore()
    }
  })

  it('C31: a second acquisition returns the holder of the first', () => {
    expect(acquireDaemonLock(home, process.pid)).toEqual({ ok: true })
    expect(acquireDaemonLock(home, 4242)).toEqual({ ok: false, holder: process.pid })
  })

  it('C31: takes over a lock held by a dead pid', () => {
    writeLock(`${DEAD_PID}\n`)
    expect(acquireDaemonLock(home, 4242)).toEqual({ ok: true })
    expect(readFileSync(lockPath(home), 'utf8')).toBe('4242\n')
  })

  it.each([
    ['not a number', 'abc'],
    ['empty', ''],
    ['0', '0'],
    ['pid beyond int32', '2147483648'],
  ])('takes over a lock with broken content (%s)', (_name, content) => {
    writeLock(content)
    expect(acquireDaemonLock(home, 4242)).toEqual({ ok: true })
    expect(readFileSync(lockPath(home), 'utf8')).toBe('4242\n')
  })

  it('X1-1: when another daemon tries right after the lock appears, it sees the lock with content so only one can acquire it, and no temporary file remains', () => {
    const path = lockPath(home)
    let contending = false
    let contender: ReturnType<typeof acquireDaemonLock> | null = null
    const contendOnce = (target: unknown): void => {
      if (target !== path || contending) return
      contending = true
      contender = acquireDaemonLock(home, 4242)
    }
    vi.mocked(linkSync).mockImplementation((existing, target) => {
      actualFs.linkSync(existing, target)
      contendOnce(target)
    })
    vi.mocked(openSync).mockImplementation((file, flags, mode) => {
      const fd = actualFs.openSync(file, flags, mode)
      contendOnce(file)
      return fd
    })
    const first = acquireDaemonLock(home, process.pid)
    expect([first, contender]).toEqual([{ ok: true }, { ok: false, holder: process.pid }])
    expect(readFileSync(path, 'utf8')).toBe(`${process.pid}\n`)
    expect(readdirSync(stateDir(home))).toEqual(['daemon.lock'])
  })

  it('X1-1: no temporary file remains when taking over a lock held by a dead pid', () => {
    writeLock(`${DEAD_PID}\n`)
    expect(acquireDaemonLock(home, 4242)).toEqual({ ok: true })
    expect(readdirSync(stateDir(home))).toEqual(['daemon.lock'])
  })

  it('releaseDaemonLock deletes only a lock with its own pid', () => {
    writeLock('4242\n')
    releaseDaemonLock(home, 4343)
    expect(existsSync(lockPath(home))).toBe(true)
    releaseDaemonLock(home, 4242)
    expect(existsSync(lockPath(home))).toBe(false)
  })

  it('releaseDaemonLock does not throw when there is no lock', () => {
    expect(() => releaseDaemonLock(home, 4242)).not.toThrow()
  })

  it('liveDaemonPid returns null when the lock is missing, broken, or held by a dead pid, and the pid when it is alive', () => {
    expect(liveDaemonPid(home)).toBeNull()
    writeLock('garbage\n')
    expect(liveDaemonPid(home)).toBeNull()
    writeLock(`${DEAD_PID}\n`)
    expect(liveDaemonPid(home)).toBeNull()
    writeLock('1\n')
    expect(liveDaemonPid(home)).toBe(1)
    writeLock(`${process.pid}\n`)
    expect(liveDaemonPid(home)).toBe(process.pid)
  })
})

describe('processedKey', () => {
  it('serializes to a JSON array string', () => {
    expect(processedKey(item, 'impl')).toBe('["todos","issue",123,"impl"]')
  })

  it('different pairs yield different keys even when names or labels contain / or "', () => {
    const slashProject = processedKey({ ...item, project: 'a/issue' }, 'b')
    const slashLabel = processedKey({ ...item, project: 'a' }, 'issue/b')
    expect(slashProject).toBe('["a/issue","issue",123,"b"]')
    expect(slashLabel).toBe('["a","issue",123,"issue/b"]')
    expect(processedKey({ ...item, target: 'pr', number: 7 }, 'say "hi"')).toBe('["todos","pr",7,"say \\"hi\\""]')
  })
})

describe('newRunId', () => {
  const seed = '["todos","issue","impl"]|123|0'

  it('UTC YYYYMMDD-HHmm- followed by the first 6 digits of sha1(seed)', () => {
    expect(newRunId('2026-10-23T09:17:42.123Z', seed, new Set())).toBe('20261023-0917-ae2ce7')
  })

  it('converts an ISO string with a time zone offset to UTC as well', () => {
    expect(newRunId('2026-10-23T18:17:42+09:00', seed, new Set())).toBe('20261023-0917-ae2ce7')
  })

  it('the same input gives the same ID', () => {
    const existing = new Set(['20261023-0917-aaaaaa'])
    expect(newRunId('2026-10-23T09:17:42.123Z', seed, existing)).toBe('20261023-0917-ae2ce7')
    expect(newRunId('2026-10-23T09:17:42.123Z', seed, existing)).toBe('20261023-0917-ae2ce7')
    expect(existing).toEqual(new Set(['20261023-0917-aaaaaa']))
  })

  it('C32: extends to 7 digits on a collision with an existing ID, and to 8 digits on a further collision', () => {
    expect(newRunId('2026-10-23T09:17:42.123Z', seed, new Set(['20261023-0917-ae2ce7']))).toBe('20261023-0917-ae2ce7b')
    expect(newRunId('2026-10-23T09:17:42.123Z', seed, new Set(['20261023-0917-ae2ce7', '20261023-0917-ae2ce7b']))).toBe('20261023-0917-ae2ce7b7')
  })

  it('C32: a different seed in the same minute (two each runs in the same cycle) gives a different ID', () => {
    expect(newRunId('2026-10-23T09:17:42.123Z', '["todos","issue","impl"]|124|1', new Set())).toBe('20261023-0917-f676bd')
  })
})

describe('incident recovery save contract', () => {
  it('loads an existing state without adding an incident and keeps investigation and approval requests', () => {
    saveState(home, emptyState)
    expect(loadState(home)).toEqual(emptyState)
    writeRequest(home, { type: 'investigate', runId: '20261023-0917-3f9a1c', evidence: 'a new fact' })
    writeRequest(home, { type: 'approve', runId: '20261023-0917-3f9a1c', revision: 'a'.repeat(64) })
    expect(readRequests(home).map((read) => 'request' in read ? read.request.type : 'invalid').sort()).toEqual(['approve', 'investigate'])
  })

  it('rejects an approval request with a tampered revision', () => {
    mkdirSync(requestsDir(home), { recursive: true })
    writeFileSync(join(requestsDir(home), 'bad.json'), JSON.stringify({ type: 'approve', runId: '20261023-0917-3f9a1c', revision: 'not-a-revision' }))
    expect(readRequests(home)[0]).toMatchObject({ file: 'bad.json', error: expect.stringContaining('revision') })
  })
})
