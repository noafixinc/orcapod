import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { runCycle, start } from '../src/daemon.ts'
import type { CycleMemory } from '../src/daemon.ts'
import type { ExecFile } from '../src/orca.ts'
import { OrcaError, createOrcaClient } from '../src/orca.ts'
import { lockPath, logPath, requestsDir, statePath } from '../src/paths.ts'
import { acquireDaemonLock, loadState, saveState, writeRequest } from '../src/state.ts'
import type { AgentObservation, CycleDeps, GithubSource, Item, OrcaClient, OrcaRef, OrcaSnapshot, Run, State } from '../src/types.ts'

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => undefined) }))

const NOW = '2026-10-23T00:17:00.000Z'
const RUN_ID = '20261023-0017-ddc8e4'
const RUN_A = '20261023-0007-aaaaaa'
const RUN_B = '20261023-0007-bbbbbb'
const GH_ACCOUNTS = ['taylor']
const IMPL_KEY = '["todos","issue","impl"]'
const REF: OrcaRef = { handle: 'term_a', tabId: 'tab-a', paneKey: 'tab-a:leaf-a', ptyId: 'pty-a' }

let home: string
let projectPath: string
let notices: { title: string; message: string }[]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orcapod-daemon-'))
  projectPath = join(home, 'git', 'todos')
  mkdirSync(projectPath, { recursive: true })
  notices = []
  vi.mocked(sleep).mockClear()
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

function secondsBefore(seconds: number): string {
  return new Date(Date.parse(NOW) - seconds * 1000).toISOString()
}

function writeConfig(options: { desktop?: boolean; projects?: { name: string; path: string; repo: string }[] } = {}): void {
  const projects = options.projects ?? [{ name: 'todos', path: projectPath, repo: 'alice/todos' }]
  writeFileSync(join(home, 'config.yaml'), stringify({
    version: 1,
    settings: { notify: { desktop: options.desktop ?? true } },
    kinds: [{ id: 'feature', name: 'Feature' }],
    projects: projects.map((p) => ({ ...p, githubAccount: 'taylor', rules: [{ target: 'issue', label: 'impl', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 5 }] })),
  }))
  mkdirSync(join(home, 'prompts'), { recursive: true })
  writeFileSync(join(home, 'prompts', 'feature.claude.md'), '{{items}}\n')
}

function configSha(): string {
  return createHash('sha256').update(readFileSync(join(home, 'config.yaml'))).digest('hex')
}

function logText(): string {
  return existsSync(logPath(home)) ? readFileSync(logPath(home), 'utf8') : ''
}

function issue(number: number): Item {
  return { project: 'todos', repo: 'alice/todos', target: 'issue', number, title: `Title ${number}`, url: `https://github.com/alice/todos/issues/${number}`, labels: ['impl'], author: { login: 'alice', bot: false, association: 'OWNER' } }
}

function stateWith(overrides: Partial<State> = {}): State {
  return { version: 1, processed: [], pending: [], runs: [], watchedRules: [IMPL_KEY], lastPolledAt: { todos: NOW }, projectErrors: {}, orcaOutageSince: null, consumedRequests: [], configStatus: null, daemonInfo: null, ...overrides }
}

function runWith(overrides: Partial<Run> = {}): Run {
  return {
    id: RUN_A,
    project: 'todos',
    target: { path: projectPath, repo: 'alice/todos', githubAccount: 'taylor' },
    rule: { target: 'issue', label: 'impl', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 5, enabled: true, bootstrap: 'skip' },
    kindName: 'Feature',
    items: [issue(7)],
    createdAt: secondsBefore(600),
    startedAt: secondsBefore(300),
    phase: { kind: 'running', agent: 'working', agentSince: secondsBefore(300), closeAttempts: 0 },
    history: [],
    orca: REF,
    notified: [],
    bypassLimit: false,
    manual: false,
    lastMessage: null,
    ...overrides,
  }
}

const expiredPending = { ruleKey: IMPL_KEY, project: 'todos', items: [issue(7)], fireAt: secondsBefore(60) }

function agent(state: AgentObservation['state'], stateSince: string, extra: Partial<AgentObservation> = {}): AgentObservation {
  return { paneKey: 'tab-a:leaf-a', state, stateSince, agentType: 'claude', toolName: null, lastAssistantMessage: null, ...extra }
}

function snapshot(agents: AgentObservation[] = [], terminals = [{ handle: 'term_a', tabId: 'tab-a', leafId: 'leaf-a', ptyId: 'pty-a', orphaned: false, title: null }]): OrcaSnapshot {
  return { agents: new Map([[projectPath, agents]]), terminals: new Map([[projectPath, { terminals, complete: true }]]), hooks: null }
}

function orcaWith(overrides: Partial<OrcaClient>): OrcaClient {
  const unused = async (): Promise<never> => {
    throw new Error('not called in this test')
  }
  return {
    status: unused,
    createTerminal: unused,
    listTerminals: unused,
    closeTerminal: unused,
    worktreePs: unused,
    readScreen: unused,
    hooksStatus: unused,
    waitExit: unused,
    registeredPaths: unused,
    observe: async () => ({ agents: new Map(), terminals: new Map(), hooks: null }),
    ...overrides,
  }
}

function depsWith(orca: OrcaClient, github: GithubSource = async () => [], overrides: Partial<CycleDeps> = {}): CycleDeps {
  return { home, orca, github, ghAccounts: async () => GH_ACCOUNTS, notify: async (title, message) => { notices.push({ title, message }) }, now: () => new Date(NOW), ...overrides }
}

const DAEMON = { pid: 4242, startedAt: '2026-10-23T00:00:00.000Z', orcaVersion: null, cycleSeconds: 20 }
const fresh: CycleMemory = { config: null, configBroken: false, ghAccounts: GH_ACCOUNTS, accountsMissingAfterRefresh: [], configStatus: null, daemon: DAEMON, lastCycleError: null }

describe('runCycle', () => {
  it('C38 / C40: when an expired pending set exists with no run, the same cycle reaches createTerminal and launching is saved in state.json at that point', async () => {
    writeConfig()
    saveState(home, stateWith({ processed: [{ key: '["todos","issue",7,"impl"]', seenAt: secondsBefore(360) }], pending: [expiredPending] }))
    const observed: unknown[] = []
    const savedPhases: string[][] = []
    const created: unknown[] = []
    const orca = orcaWith({
      observe: async (input) => {
        observed.push(input)
        return { agents: new Map(), terminals: new Map(), hooks: null }
      },
      createTerminal: async (input) => {
        savedPhases.push(loadState(home).runs.map((r) => r.phase.kind))
        created.push(input)
        return { ref: REF, warning: null }
      },
    })
    await runCycle(depsWith(orca), fresh)

    expect(observed).toEqual([{ paths: [], hooks: false }])
    expect(savedPhases).toEqual([['launching']])
    expect(created).toEqual([{ worktreePath: projectPath, title: '#7 Feature', command: `bash '${home}/runs/${RUN_ID}/launch.sh'` }])
    const state = loadState(home)
    expect(state.runs.map((r) => [r.id, r.phase, r.orca, r.startedAt])).toEqual([[RUN_ID, { kind: 'starting', since: NOW }, REF, NOW]])
    expect([state.pending, state.orcaOutageSince, notices]).toEqual([[], null, []])
    expect(JSON.parse(readFileSync(join(home, 'runs', RUN_ID, 'meta.json'), 'utf8')).phase).toEqual({ kind: 'starting', since: NOW })
  })

  it('the request file is deleted after state.json is saved: at launch time the file still exists and is in consumedRequests, and it is deleted after the cycle', async () => {
    writeConfig()
    saveState(home, stateWith())
    const file = writeRequest(home, { type: 'run', project: 'todos', item: issue(9), kind: 'feature', ai: 'claude', now: true })
    const duringLaunch: unknown[] = []
    const orca = orcaWith({
      createTerminal: async () => {
        duringLaunch.push([existsSync(join(requestsDir(home), file)), loadState(home).consumedRequests])
        return { ref: REF, warning: null }
      },
    })
    await runCycle(depsWith(orca), fresh)
    expect(duringLaunch).toEqual([[true, [file]]])
    expect(existsSync(join(requestsDir(home), file))).toBe(false)
    expect(loadState(home).consumedRequests).toEqual([file])
    await runCycle(depsWith(orca), fresh)
    expect(loadState(home).consumedRequests).toEqual([])
  })

  it('C27: when the second loadConfig fails, keeps running with the previous Config and notifies only once for the first breakage; one more notification if it is fixed and breaks again', async () => {
    writeConfig()
    saveState(home, stateWith())
    const orca = orcaWith({ createTerminal: async () => ({ ref: REF, warning: null }) })
    const first = await runCycle(depsWith(orca), fresh)
    expect(first.configBroken).toBe(false)

    writeFileSync(join(home, 'config.yaml'), 'version: [')
    writeRequest(home, { type: 'run', project: 'todos', item: issue(9), kind: 'feature', now: false })
    const second = await runCycle(depsWith(orca), first)
    expect(second.config).toBe(first.config)
    expect(second.configBroken).toBe(true)
    expect(loadState(home).runs.map((r) => r.items[0].number)).toEqual([9])
    const third = await runCycle(depsWith(orca), second)
    expect(notices.map((n) => n.title)).toEqual(['orcapod: config broken'])

    writeConfig()
    const fixed = await runCycle(depsWith(orca), third)
    writeFileSync(join(home, 'config.yaml'), 'version: [')
    await runCycle(depsWith(orca), fixed)
    expect(notices.map((n) => n.title)).toEqual(['orcapod: config broken', 'orcapod: config broken'])
  })

  it('C43: an invalid response after creation is kept as an uncertain launch, and the investigation is not launched twice', async () => {
    writeConfig()
    saveState(home, stateWith({ processed: [{ key: '["todos","issue",7,"impl"]', seenAt: secondsBefore(360) }], pending: [expiredPending] }))
    let calls = 0
    const orca = orcaWith({
      createTerminal: async () => {
        calls += 1
        throw new OrcaError('no_pane_key', 'terminal create response has no paneKey')
      },
    })
    await runCycle(depsWith(orca), fresh)
    expect(loadState(home).runs.map((r) => r.phase)).toEqual([{ kind: 'failed', at: NOW, reason: 'launch failed: terminal create response has no paneKey', tabClosed: false, launchFailed: true }])
    expect(notices).toEqual([{ title: 'orcapod: launch failed', message: `${RUN_ID} "#7 Feature": terminal create response has no paneKey` }])
    await runCycle(depsWith(orca), fresh)
    expect(calls).toBe(1)
    await runCycle(depsWith(orca), fresh)
    expect(calls).toBe(1)
    expect(loadState(home).runs[0].incident?.status).toBe('blocked')
    expect(loadState(home).runs[0].launchUncertain).toBe(true)
  })

  it('when runs/<id>/pane.json exists in launching, moves to starting, copies it to orca, and does not call createTerminal', async () => {
    writeConfig()
    const launching = runWith({ startedAt: null, orca: null, phase: { kind: 'launching', since: secondsBefore(30) } })
    saveState(home, stateWith({ runs: [launching] }))
    mkdirSync(join(home, 'runs', RUN_A), { recursive: true })
    writeFileSync(join(home, 'runs', RUN_A,'pane.json'), '{"handle":"term_p","tabId":"tab-a","paneKey":"tab-a:leaf-a"}\n')
    await runCycle(depsWith(orcaWith({ observe: async () => snapshot([], [{ handle: 'term_p', tabId: 'tab-a', leafId: 'leaf-a', ptyId: 'pty-a', orphaned: false, title: null }]) })), fresh)
    expect(loadState(home).runs.map((r) => [r.phase, r.orca])).toEqual([[{ kind: 'starting', since: NOW }, { handle: 'term_p', tabId: 'tab-a', paneKey: 'tab-a:leaf-a', ptyId: '' }]])
  })

  it('C41: when terminal list fails for one path, runs of the other paths are still tracked and it does not become an Orca outage', async () => {
    const otherPath = join(home, 'git', 'other')
    mkdirSync(otherPath, { recursive: true })
    writeConfig({ projects: [{ name: 'todos', path: projectPath, repo: 'alice/todos' }, { name: 'other', path: otherPath, repo: 'alice/other' }] })
    const startingA = runWith({ phase: { kind: 'starting', since: secondsBefore(30) } })
    const startingB = runWith({ id: RUN_B,project: 'other', target: { path: otherPath, repo: 'alice/other', githubAccount: 'taylor' }, phase: { kind: 'starting', since: secondsBefore(30) }, orca: { handle: 'term_b', tabId: 'tab-b', paneKey: 'tab-b:leaf-b', ptyId: 'pty-b' } })
    saveState(home, stateWith({ runs: [startingA, startingB], lastPolledAt: { todos: NOW, other: NOW } }))
    const envelope = (result: unknown): string => JSON.stringify({ id: 'cli-1', ok: true, result, _meta: {} })
    const exec: ExecFile = async (_file, args) => {
      if (args[0] === 'worktree') {
        const worktrees = [
          { path: projectPath, agents: [{ paneKey: 'tab-a:leaf-a', state: 'working', stateStartedAt: Date.parse(secondsBefore(10)), agentType: 'claude', toolName: null, lastAssistantMessage: null }] },
          { path: otherPath, agents: [] },
        ]
        return { stdout: envelope({ worktrees }), stderr: '' }
      }
      if (args.includes(`path:${projectPath}`)) {
        return { stdout: envelope({ terminals: [{ handle: 'term_a', tabId: 'tab-a', leafId: 'leaf-a', ptyId: 'pty-a', title: null }], truncated: false }), stderr: '' }
      }
      throw Object.assign(new Error('Command failed: orca'), { stdout: '', stderr: 'socket hang up' })
    }
    await runCycle(depsWith(createOrcaClient('orca', exec)), fresh)
    const state = loadState(home)
    expect(state.runs.map((r) => [r.id, r.phase])).toEqual([
      [RUN_A, { kind: 'running', agent: 'working', agentSince: NOW, closeAttempts: 0 }],
      [RUN_B, { kind: 'starting', since: '2026-10-23T00:16:30.000Z' }],
    ])
    expect(state.orcaOutageSince).toBeNull()
    expect(readFileSync(logPath(home), 'utf8')).toContain(`warn run ${RUN_B}: terminal list is incomplete, so the pane is not judged as gone`)
  })

  it('C51: reads GitHub only for projects 60 seconds past lastPolledAt, and lastPolledAt in state.json becomes the value tick returned', async () => {
    writeConfig()
    const polled: string[] = []
    const github: GithubSource = async (project) => {
      polled.push(project.name)
      return []
    }
    saveState(home, stateWith({ lastPolledAt: { todos: secondsBefore(30) } }))
    await runCycle(depsWith(orcaWith({}), github), fresh)
    expect([polled, loadState(home).lastPolledAt]).toEqual([[], { todos: '2026-10-23T00:16:30.000Z' }])
    saveState(home, stateWith({ lastPolledAt: { todos: secondsBefore(60) } }))
    await runCycle(depsWith(orcaWith({}), github), fresh)
    expect([polled, loadState(home).lastPolledAt]).toEqual([['todos'], { todos: NOW }])
  })

  it('a project whose folder is missing becomes a monitoring error without calling gh, and is notified once', async () => {
    const missing = join(home, 'git', 'missing')
    writeConfig({ projects: [{ name: 'todos', path: missing, repo: 'alice/todos' }] })
    saveState(home, stateWith({ lastPolledAt: {} }))
    const polled: string[] = []
    await runCycle(depsWith(orcaWith({}), async (project) => {
      polled.push(project.name)
      return []
    }), fresh)
    expect(polled).toEqual([])
    expect(loadState(home).projectErrors).toEqual({ todos: { since: NOW, message: `folder not found: ${missing}` } })
    expect(notices).toEqual([{ title: 'orcapod: watch error', message: `todos: folder not found: ${missing}` }])
  })

  it('with notify.desktop: false, no notification is shown and it is only logged', async () => {
    const missing = join(home, 'git', 'missing')
    writeConfig({ desktop: false, projects: [{ name: 'todos', path: missing, repo: 'alice/todos' }] })
    saveState(home, stateWith({ lastPolledAt: {} }))
    await runCycle(depsWith(orcaWith({})), fresh)
    expect(notices).toEqual([])
    expect(readFileSync(logPath(home), 'utf8')).toContain(`info notify orcapod: watch error: todos: folder not found: ${missing}\n`)
  })

  it('the close effect calls closeTerminal, and with ptyKilled: true moves to done and writes meta.json and last-message.md', async () => {
    writeConfig()
    saveState(home, stateWith({ runs: [runWith()] }))
    const dir = join(home, 'runs', RUN_A)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'result.json'), '{"status":"done","summary":"Created PR #130","links":[]}')
    utimesSync(join(dir, 'result.json'), new Date(secondsBefore(60)), new Date(secondsBefore(60)))
    const closed: string[] = []
    const orca = orcaWith({
      observe: async () => snapshot([agent('done', secondsBefore(30), { lastAssistantMessage: 'I created the PR' })]),
      closeTerminal: async (handle) => {
        closed.push(handle)
        return { ptyKilled: true }
      },
    })
    await runCycle(depsWith(orca), fresh)
    expect(closed).toEqual(['term_a'])
    expect(loadState(home).runs.map((r) => r.phase)).toEqual([{ kind: 'done', at: NOW, summary: 'Created PR #130', tabClosed: true }])
    expect(readFileSync(join(dir, 'last-message.md'), 'utf8')).toBe('I created the PR')
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).phase).toEqual({ kind: 'done', at: NOW, summary: 'Created PR #130', tabClosed: true })
  })

  it.each(['done', 'failed'])('a saved %s result for a starting run after restart is reflected in state and meta even without a hook', async (status) => {
    writeConfig()
    saveState(home, stateWith({ runs: [runWith({ phase: { kind: 'starting', since: secondsBefore(300) }, notified: ['starting-stall'] })] }))
    const dir = join(home, 'runs', RUN_A)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ status, summary: 'saved result', links: [] }))
    const closeTerminal = vi.fn(async () => ({ ptyKilled: true }))
    const deps = depsWith(orcaWith({ observe: async () => snapshot(), closeTerminal }))
    const memory = await runCycle(deps, fresh)
    const phase = status === 'done'
      ? { kind: 'done', at: NOW, summary: 'saved result', tabClosed: false }
      : { kind: 'failed', at: NOW, reason: 'AI reported failed: saved result', tabClosed: false }
    expect(loadState(home).runs[0].phase).toEqual(phase)
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).phase).toEqual(phase)
    await runCycle(deps, memory)
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(notices).toHaveLength(1)
  })

  it('terminal_handle_stale from closeTerminal leaves the run running and defers to the next cycle', async () => {
    writeConfig()
    saveState(home, stateWith({ runs: [runWith()] }))
    const dir = join(home, 'runs', RUN_A)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'result.json'), '{"status":"done","summary":"s","links":[]}')
    utimesSync(join(dir, 'result.json'), new Date(secondsBefore(60)), new Date(secondsBefore(60)))
    const orca = orcaWith({
      observe: async () => snapshot([agent('done', secondsBefore(30))]),
      closeTerminal: async () => {
        throw new OrcaError('terminal_handle_stale', 'handle is stale')
      },
    })
    await runCycle(depsWith(orca), fresh)
    expect(loadState(home).runs[0].phase).toMatchObject({ kind: 'running', closeAttempts: 1 })
    expect(readFileSync(logPath(home), 'utf8')).toContain(`warn run ${RUN_A}: the handle was stale; fetching it again and retrying the close next cycle`)
  })

  it.each([
    { rendered: true, message: `${RUN_A} "#7 Feature": no agent appeared 90 seconds after the tab opened (possibly a trust dialog)\nDo you trust the files in this folder?\n❯ 1. Yes, I trust this folder` },
    { rendered: false, message: `${RUN_A} "#7 Feature": no agent appeared 90 seconds after the tab opened (possibly a trust dialog)` },
  ])('attaches the screen tail to the launch-wait notification only when rendered: $rendered', async ({ rendered, message }) => {
    writeConfig()
    saveState(home, stateWith({ runs: [runWith({ phase: { kind: 'starting', since: secondsBefore(91) } })] }))
    const screens: [string, number][] = []
    const orca = orcaWith({
      observe: async () => snapshot(),
      readScreen: async (handle, lines) => {
        screens.push([handle, lines])
        return { lines: ['Do you trust the files in this folder?', '❯ 1. Yes, I trust this folder'], rendered }
      },
    })
    await runCycle(depsWith(orca), fresh)
    expect(screens).toEqual([['term_a', 6]])
    expect(notices).toEqual([{ title: 'orcapod: launch waiting', message }])
  })
})

describe('runCycle: reproduction of review finding X1', () => {
  const later = (seconds: number) => () => new Date(Date.parse(NOW) + seconds * 1000)
  const launchingRun = () => runWith({ startedAt: null, orca: null, phase: { kind: 'launching', since: secondsBefore(30) } })
  const writePaneFile = () => {
    mkdirSync(join(home, 'runs', RUN_A), { recursive: true })
    writeFileSync(join(home, 'runs', RUN_A,'pane.json'), '{"handle":"term_p","tabId":"tab-a","paneKey":"tab-a:leaf-a"}\n')
  }
  const paneFromFile: OrcaRef = { handle: 'term_p', tabId: 'tab-a', paneKey: 'tab-a:leaf-a', ptyId: '' }

  it('X1-9: on exec_failed from createTerminal, waits for the pane, and after 5 minutes stops without recreating', async () => {
    writeConfig()
    saveState(home, stateWith({ processed: [{ key: '["todos","issue",7,"impl"]', seenAt: secondsBefore(360) }], pending: [expiredPending] }))
    const created: string[] = []
    const orca = orcaWith({
      createTerminal: async (input) => {
        created.push(input.command)
        if (created.length === 1) throw new OrcaError('exec_failed', 'terminal create: Command failed: orca')
        return { ref: REF, warning: null }
      },
    })
    await runCycle(depsWith(orca), fresh)
    expect(loadState(home).runs.map((r) => r.phase)).toEqual([{ kind: 'launching', since: NOW }])
    expect(notices).toEqual([])
    expect(readFileSync(logPath(home), 'utf8')).toContain(`warn run ${RUN_ID}: terminal create outcome unknown (terminal create: Command failed: orca). Staying in launching and waiting for pane.json; stops as unconfirmed if it does not appear within 5 minutes`)

    await runCycle(depsWith(orca, undefined, { now: later(360) }), fresh)
    const command = `bash '${home}/runs/${RUN_ID}/launch.sh'`
    expect(created).toEqual([command])
    expect(loadState(home).runs[0].phase).toMatchObject({ kind: 'failed', reason: expect.stringContaining('duplicate') })
    expect(loadState(home).runs[0].launchUncertain).toBe(true)
    expect(notices).toHaveLength(1)
  })

  it('X1-9 / I15: when runs/<id>/ for a newly created run already exists, moves to failed without calling createTerminal', async () => {
    writeConfig()
    saveState(home, stateWith({ processed: [{ key: '["todos","issue",7,"impl"]', seenAt: secondsBefore(360) }], pending: [expiredPending] }))
    mkdirSync(join(home, 'runs', RUN_ID), { recursive: true })
    let calls = 0
    const orca = orcaWith({
      createTerminal: async () => {
        calls += 1
        return { ref: REF, warning: null }
      },
    })
    await runCycle(depsWith(orca), fresh)
    expect(calls).toBe(0)
    expect(loadState(home).runs.map((r) => r.phase)).toMatchObject([{ kind: 'failed', at: NOW, reason: expect.stringContaining('launch failed: EEXIST') }])
  })

  it('X1-7: stopping a launching run during an Orca outage saves the pane from pane.json, and a stop after recovery closes that tab', async () => {
    writeConfig()
    saveState(home, stateWith({ runs: [launchingRun()] }))
    writePaneFile()
    writeRequest(home, { type: 'stop', runId: RUN_A })
    await runCycle(depsWith(orcaWith({ observe: async () => { throw new OrcaError('exec_failed', 'socket hang up') } })), fresh)
    expect(loadState(home).runs.map((r) => [r.phase, r.orca])).toEqual([[{ kind: 'aborted', at: NOW, reason: 'orcapod stop' }, paneFromFile]])

    writeRequest(home, { type: 'stop', runId: RUN_A })
    const observed: unknown[] = []
    const closed: string[] = []
    const orca = orcaWith({
      observe: async (input) => {
        observed.push(input)
        return snapshot()
      },
      closeTerminal: async (handle) => {
        closed.push(handle)
        return { ptyKilled: true }
      },
    })
    await runCycle(depsWith(orca, undefined, { now: later(20) }), fresh)
    expect([observed, closed]).toEqual([[{ paths: [projectPath], hooks: false }], ['term_a']])
    expect(loadState(home).runs.map((r) => r.phase)).toEqual([{ kind: 'aborted', at: NOW, reason: 'orcapod stop' }])
  })

  it('X1-7: a run that became aborted with orca still null also has its tab closed by reading pane.json when there is a stop request', async () => {
    writeConfig()
    saveState(home, stateWith({ runs: [runWith({ orca: null, phase: { kind: 'aborted', at: secondsBefore(60), reason: 'orcapod stop' } })] }))
    writePaneFile()
    writeRequest(home, { type: 'stop', runId: RUN_A })
    const observed: unknown[] = []
    const closed: string[] = []
    const orca = orcaWith({
      observe: async (input) => { observed.push(input); return snapshot() },
      closeTerminal: async (handle) => {
        closed.push(handle)
        return { ptyKilled: true }
      },
    })
    await runCycle(depsWith(orca), fresh)
    expect(observed).toEqual([{ paths: [projectPath], hooks: false }])
    expect(closed).toEqual(['term_a'])
    expect(loadState(home).runs.map((r) => r.orca)).toEqual([paneFromFile])
  })

  it('X1-8: the notification is delivered before the intermediate save (state.json is still running at notification time)', async () => {
    writeConfig()
    saveState(home, stateWith({ runs: [runWith()] }))
    mkdirSync(join(home, 'runs', RUN_A), { recursive: true })
    writeFileSync(join(home, 'runs', RUN_A,'result.json'), '{"status":"failed","summary":"tests fail","links":[]}')
    const savedAtNotice: string[] = []
    const deps = depsWith(orcaWith({ observe: async () => snapshot([agent('working', secondsBefore(10))]) }), undefined, {
      notify: async (title, message) => {
        savedAtNotice.push(loadState(home).runs[0].phase.kind)
        notices.push({ title, message })
      },
    })
    await runCycle(deps, fresh)
    expect(savedAtNotice).toEqual(['running'])
    expect(notices).toEqual([{ title: 'orcapod: failed', message: `${RUN_A} "#7 Feature": AI reported failed: tests fail` }])
    expect(loadState(home).runs[0].phase).toEqual({ kind: 'failed', at: NOW, reason: 'AI reported failed: tests fail', tabClosed: false })
  })

  it('X1-10: even when the project name is constructor / toString / __proto__, reads gh in the first cycle and does not reread until 60 seconds pass', async () => {
    const names = ['constructor', 'toString', '__proto__']
    for (const name of names) mkdirSync(join(home, 'git', name), { recursive: true })
    writeConfig({ projects: names.map((name) => ({ name, path: join(home, 'git', name), repo: `alice/${name}` })) })
    saveState(home, stateWith({ lastPolledAt: {}, watchedRules: [] }))
    const polled: string[] = []
    const github: GithubSource = async (project) => {
      polled.push(project.name)
      return []
    }
    await runCycle(depsWith(orcaWith({}), github), fresh)
    await runCycle(depsWith(orcaWith({}), github, { now: later(20) }), fresh)
    expect(polled).toEqual(names)
    expect(Object.entries(loadState(home).lastPolledAt)).toEqual(names.map((name) => [name, NOW]))
  })

  it('X1-4: when rewritten to a YAML with circular references, does not throw, keeps running with the previous Config, and notifies once', async () => {
    writeConfig()
    saveState(home, stateWith())
    const first = await runCycle(depsWith(orcaWith({})), fresh)
    writeFileSync(join(home, 'config.yaml'), 'version: &v [*v]\n')
    const second = await runCycle(depsWith(orcaWith({})), first)
    const third = await runCycle(depsWith(orcaWith({})), second)
    expect([second.config, third.config, third.configBroken]).toEqual([first.config, first.config, true])
    expect(notices).toEqual([{ title: 'orcapod: config broken', message: expect.stringContaining('Keeps running with the previous config.') }])
    expect(readFileSync(logPath(home), 'utf8')).toContain('warn config broken: version: 1 is required (got: unprintable value (circular reference?))')
  })

  it('X1-11: when the content shape of state.json is broken, runCycle throws and does not rewrite state.json', async () => {
    writeConfig()
    const broken = JSON.stringify({ ...stateWith(), runs: [{}] })
    mkdirSync(join(home, 'state'), { recursive: true })
    writeFileSync(statePath(home), broken)
    await expect(runCycle(depsWith(orcaWith({})), fresh)).rejects.toThrow(`${statePath(home)} is corrupt: runs[0].id is not a string`)
    expect(readFileSync(statePath(home), 'utf8')).toBe(broken)
  })

  it('A46: in a cycle where loadState throws, state.json is not updated, and neither the mtime nor the directory contents change', async () => {
    writeConfig()
    mkdirSync(join(home, 'state'), { recursive: true })
    writeFileSync(statePath(home), JSON.stringify({ ...stateWith(), runs: [{}] }))
    const past = new Date(Date.parse(NOW) - 3600_000)
    utimesSync(statePath(home), past, past)
    const before = statSync(statePath(home)).mtimeMs
    await expect(runCycle(depsWith(orcaWith({})), fresh)).rejects.toThrow('runs[0].id is not a string')
    expect(statSync(statePath(home)).mtimeMs).toBe(before)
    expect(before).toBe(past.getTime())
    expect(readdirSync(join(home, 'state'))).toEqual(['state.json'])
  })
})

describe('runCycle: rereads the gh accounts on a githubAccount mismatch', () => {
  const stale: CycleMemory = { ...fresh, ghAccounts: ['someone-else'] }

  it('when the configured githubAccount is not among the known accounts, rereads the gh accounts once, and accepts the configuration if it is found there', async () => {
    writeConfig()
    saveState(home, stateWith())
    let calls = 0
    const memory = await runCycle(depsWith(orcaWith({}), undefined, { ghAccounts: async () => { calls += 1; return ['someone-else', 'taylor'] } }), stale)
    expect([calls, memory.configBroken, memory.ghAccounts, memory.accountsMissingAfterRefresh, notices]).toEqual([1, false, ['someone-else', 'taylor'], [], []])
    expect(memory.config?.projects.map((p) => p.githubAccount)).toEqual(['taylor'])
    expect(readFileSync(logPath(home), 'utf8')).toContain('info githubAccount in the config (taylor) is not a known account, so the gh accounts were reloaded: someone-else, taylor')
  })

  it('if it is still missing after rereading, notifies once that the configuration is broken, and does not reread gh while the same unknown account remains', async () => {
    writeConfig()
    saveState(home, stateWith())
    let calls = 0
    const deps = depsWith(orcaWith({}), undefined, { ghAccounts: async () => { calls += 1; return ['someone-else'] } })
    const first = await runCycle(deps, stale)
    const second = await runCycle(deps, first)
    expect([calls, first.configBroken, first.accountsMissingAfterRefresh, second.configBroken]).toEqual([1, true, ['taylor'], true])
    expect(notices.map((n) => n.title)).toEqual(['orcapod: config broken'])
  })

  it('if rereading fails, logs a warn and treats the configuration as broken, and does not reread in the next cycle', async () => {
    writeConfig()
    saveState(home, stateWith())
    let calls = 0
    const deps = depsWith(orcaWith({}), undefined, { ghAccounts: async () => { calls += 1; throw new Error('cannot run gh auth status: stopped after 60 seconds') } })
    const first = await runCycle(deps, stale)
    await runCycle(deps, first)
    expect([calls, first.configBroken, first.ghAccounts]).toEqual([1, true, ['someone-else']])
    expect(readFileSync(logPath(home), 'utf8')).toContain('warn cannot reload the gh accounts: cannot run gh auth status: stopped after 60 seconds')
  })
})

describe('characterization tests (refactor #14)', () => {
  async function observedFor(runs: Run[]): Promise<Parameters<OrcaClient['observe']>[0][]> {
    writeConfig()
    saveState(home, stateWith({ runs }))
    const observed: Parameters<OrcaClient['observe']>[0][] = []
    await runCycle(depsWith(orcaWith({
      observe: async (input) => {
        observed.push(input)
        return { agents: new Map(), terminals: new Map(), hooks: null }
      },
    })), fresh)
    return observed
  }

  function incident(): NonNullable<Run['incident']> {
    return { status: 'blocked', reason: 'waiting for review', updatedAt: NOW, tasks: [], evidence: [], revisions: [] }
  }

  function recoverySource(): Run {
    return runWith({
      id: RUN_B,
      orca: null,
      phase: { kind: 'failed', at: NOW, reason: 'original failure', tabClosed: true },
      incident: { ...incident(), tasks: [RUN_A] },
    })
  }

  it.each(['launching', 'starting'] as const)('a %s run is observed', async (kind) => {
    const observed = await observedFor([runWith({ phase: { kind, since: NOW }, orca: null })])
    expect(observed).toEqual([{ paths: [projectPath], hooks: false }])
  })

  it.each([
    { launchUncertain: true, label: 'a failed run with uncertain launch is observed even without an Orca reference', selected: true },
    { launchUncertain: false, label: 'a failed run without uncertain launch is not selected without an Orca reference', selected: false },
  ])('$label', async ({ launchUncertain, selected }) => {
    const observed = await observedFor([runWith({
      orca: null,
      launchUncertain,
      phase: { kind: 'failed', at: NOW, reason: 'launch result', tabClosed: false },
    })])
    expect(observed).toEqual([{ paths: selected ? [projectPath] : [], hooks: false }])
  })

  describe.each(['incident', 'recovery'] as const)('terminal run with %s', (metadata) => {
    function trackedRun(overrides: Partial<Run>): Run[] {
      const tracking: Partial<Run> = metadata === 'incident'
        ? { incident: incident() }
        : { recovery: { sourceRunId: RUN_B, stage: 'prepare', evidence: ['original failure'] } }
      const run = runWith({ ...tracking, ...overrides })
      return metadata === 'recovery' ? [run, recoverySource()] : [run]
    }

    it.each([
      { label: 'a done run with an open tab and a reference is observed', tabClosed: false, hasRef: true, selected: true },
      { label: 'a done run with a closed tab is not selected even with a reference', tabClosed: true, hasRef: true, selected: false },
      { label: 'a done run with an open tab is not selected without a reference', tabClosed: false, hasRef: false, selected: false },
    ])('$label', async ({ tabClosed, hasRef, selected }) => {
      const observed = await observedFor(trackedRun({
        orca: hasRef ? REF : null,
        phase: { kind: 'done', at: NOW, summary: 'already done', tabClosed },
      }))
      expect(observed).toEqual([{ paths: selected ? [projectPath] : [], hooks: false }])
    })

    it.each([
      { label: 'an aborted run without tabClosed is observed if it has a reference', hasRef: true },
      { label: 'an aborted run without tabClosed is not selected without a reference', hasRef: false },
    ])('$label', async ({ hasRef }) => {
      const observed = await observedFor(trackedRun({
        orca: hasRef ? REF : null,
        phase: { kind: 'aborted', at: NOW, reason: 'already aborted' },
      }))
      expect(observed).toEqual([{ paths: hasRef ? [projectPath] : [], hooks: false }])
    })
  })

  it.each([
    { kind: 'done', at: NOW, summary: 'already done', tabClosed: false },
    { kind: 'aborted', at: NOW, reason: 'already aborted' },
  ] satisfies Run['phase'][])('a $kind run without recovery information is not selected even with a tab reference', async (phase) => {
    const observed = await observedFor([runWith({ phase })])
    expect(observed).toEqual([{ paths: [], hooks: false }])
  })

  it('a duplicate path is observed only once, in first-seen order', async () => {
    const firstPath = join(home, 'git', 'z-first')
    const secondPath = join(home, 'git', 'a-second')
    const target = (path: string): Run['target'] => ({ path, repo: 'alice/todos', githubAccount: 'taylor' })
    const observed = await observedFor([
      runWith({ id: RUN_A, target: target(firstPath) }),
      runWith({ id: RUN_B, target: target(secondPath) }),
      runWith({ id: '20261023-0007-cccccc', target: target(firstPath), phase: { kind: 'starting', since: NOW } }),
    ])
    expect(observed).toEqual([{ paths: [firstPath, secondPath], hooks: false }])
  })

  it.each([
    { seconds: 59, hooks: false },
    { seconds: 60, hooks: true },
  ])('hooks $hooks at $seconds seconds after starting', async ({ seconds, hooks }) => {
    const observed = await observedFor([runWith({ phase: { kind: 'starting', since: secondsBefore(seconds) } })])
    expect(observed).toEqual([{ paths: [projectPath], hooks }])
  })
})

describe('runCycle: configuration load status and daemon information', () => {
  const later = (seconds: number) => () => new Date(Date.parse(NOW) + seconds * 1000)
  const secondsAfter = (seconds: number): string => new Date(Date.parse(NOW) + seconds * 1000).toISOString()
  const emptySnapshot = async (): Promise<OrcaSnapshot> => ({ agents: new Map(), terminals: new Map(), hooks: null })

  it('A42: when the configuration is unchanged, keeps loadedAt and advances only lastCycleAt, and in the cycle where the configuration is rewritten, updates loadedAt and sha256', async () => {
    writeConfig()
    saveState(home, stateWith())
    const firstSha = configSha()
    const first = await runCycle(depsWith(orcaWith({})), fresh)
    const second = await runCycle(depsWith(orcaWith({}), undefined, { now: later(20) }), first)
    expect(loadState(home).configStatus).toEqual({ loadedAt: NOW, sha256: firstSha, error: null })
    expect(loadState(home).daemonInfo).toEqual({ pid: 4242, startedAt: '2026-10-23T00:00:00.000Z', lastCycleAt: secondsAfter(20), lastCycleError: null, orcaVersion: null, cycleSeconds: 20 })
    writeConfig({ desktop: false })
    const third = await runCycle(depsWith(orcaWith({}), undefined, { now: later(40) }), second)
    expect(configSha()).not.toBe(firstSha)
    expect([loadState(home).configStatus, third.configStatus]).toEqual([{ loadedAt: secondsAfter(40), sha256: configSha(), error: null }, { loadedAt: secondsAfter(40), sha256: configSha(), error: null }])
  })

  it('A43: in a cycle where the configuration is broken, keeps the previous sha256 and loadedAt and puts all errors in error, and clears error in the cycle where it is fixed', async () => {
    writeConfig()
    saveState(home, stateWith())
    const sha = configSha()
    const first = await runCycle(depsWith(orcaWith({})), fresh)
    writeFileSync(join(home, 'config.yaml'), 'version: 2\nkinds: 1\nprojects: []\n')
    const broken = await runCycle(depsWith(orcaWith({}), undefined, { now: later(20) }), first)
    expect(loadState(home).configStatus).toEqual({ loadedAt: NOW, sha256: sha, error: 'version: 1 is required (got: 2)\nkinds: must be an array (got: 1)' })
    writeConfig()
    await runCycle(depsWith(orcaWith({}), undefined, { now: later(40) }), broken)
    expect(loadState(home).configStatus).toEqual({ loadedAt: NOW, sha256: sha, error: null })
  })

  it('A44: saves the failure of the previous cycle in daemonInfo.lastCycleError, clears it in the returned memory, and it is null in the next cycle save', async () => {
    writeConfig()
    saveState(home, stateWith())
    const memory = await runCycle(depsWith(orcaWith({})), { ...fresh, lastCycleError: { at: secondsBefore(20), message: 'x' } })
    expect([loadState(home).daemonInfo?.lastCycleError, memory.lastCycleError]).toEqual([{ at: '2026-10-23T00:16:40.000Z', message: 'x' }, null])
    await runCycle(depsWith(orcaWith({}), undefined, { now: later(20) }), memory)
    expect(loadState(home).daemonInfo?.lastCycleError).toBeNull()
  })

  it('A45: refetches the Orca version every cycle until obtained (failures are not logged), and does not refetch once obtained', async () => {
    writeConfig()
    saveState(home, stateWith())
    let calls = 0
    const orca = orcaWith({
      status: async () => {
        calls += 1
        if (calls === 1) throw new Error('orca status does not respond')
        return { running: true, version: '1.4.217' }
      },
    })
    const first = await runCycle(depsWith(orca), fresh)
    expect([first.daemon.orcaVersion, loadState(home).daemonInfo?.orcaVersion]).toEqual([null, null])
    const second = await runCycle(depsWith(orca, undefined, { now: later(20) }), first)
    expect([second.daemon.orcaVersion, loadState(home).daemonInfo?.orcaVersion]).toEqual(['1.4.217', '1.4.217'])
    await runCycle(depsWith(orca, undefined, { now: later(40) }), second)
    expect([calls, loadState(home).daemonInfo?.orcaVersion]).toEqual([2, '1.4.217'])
    expect(logText()).not.toContain('orca status does not respond')
  })

  it('A45: does not refetch the version while Orca is down, refetches in the cycle where it recovers and sets null on failure, and refetches again in the next cycle', async () => {
    writeConfig()
    saveState(home, stateWith({ orcaOutageSince: secondsBefore(60) }))
    let calls = 0
    let answer = async (): Promise<{ running: boolean; version: string | null }> => {
      throw new Error('orca status does not respond')
    }
    const status = async (): Promise<{ running: boolean; version: string | null }> => {
      calls += 1
      return answer()
    }
    const known: CycleMemory = { ...fresh, daemon: { ...DAEMON, orcaVersion: '1.4.216' } }
    const down = await runCycle(depsWith(orcaWith({ status, observe: async () => { throw new OrcaError('exec_failed', 'socket hang up') } })), known)
    expect([calls, down.daemon.orcaVersion, loadState(home).daemonInfo?.orcaVersion]).toEqual([0, '1.4.216', '1.4.216'])
    const reconnected = await runCycle(depsWith(orcaWith({ status, observe: emptySnapshot }), undefined, { now: later(20) }), down)
    expect([calls, reconnected.daemon.orcaVersion, loadState(home).daemonInfo?.orcaVersion, loadState(home).orcaOutageSince]).toEqual([1, null, null, null])
    answer = async () => ({ running: true, version: '1.4.217' })
    const retried = await runCycle(depsWith(orcaWith({ status, observe: emptySnapshot }), undefined, { now: later(40) }), reconnected)
    expect([calls, retried.daemon.orcaVersion, loadState(home).daemonInfo?.orcaVersion]).toEqual([2, '1.4.217', '1.4.217'])
  })

  it('A41: the only paths queried against Orca are those of active runs and of failed runs that still have a tab and a reference', async () => {
    writeConfig()
    const pathOf = (name: string): string => join(home, 'git', name)
    const failed = (tabClosed: boolean) => ({ kind: 'failed' as const, at: secondsBefore(60), reason: 'x', tabClosed })
    const target = (name: string) => ({ path: pathOf(name), repo: 'alice/todos', githubAccount: 'taylor' })
    saveState(home, stateWith({ runs: [
      runWith({ id: RUN_A, target: target('p1') }),
      runWith({ id: RUN_B, target: target('p2'), phase: failed(false) }),
      runWith({ id: '20261023-0007-cccccc', target: target('p3'), phase: failed(true) }),
      runWith({ id: '20261023-0007-dddddd', target: target('p4'), phase: failed(false), orca: null }),
    ] }))
    const observed: unknown[] = []
    await runCycle(depsWith(orcaWith({ observe: async (input) => { observed.push(input); return emptySnapshot() } })), fresh)
    expect(observed).toEqual([{ paths: [pathOf('p1'), pathOf('p2')], hooks: false }])
  })

  describe('A49: one cycle from a 001-shaped state.json (no configStatus or daemonInfo, no tabClosed on failed)', () => {
    function write001State(): void {
      const phase001 = { kind: 'failed', at: secondsBefore(600), reason: 'launch failed: x' }
      const runs = [{ ...runWith(), phase: phase001 }, { ...runWith({ id: RUN_B, orca: null }), phase: phase001 }]
      mkdirSync(join(home, 'state'), { recursive: true })
      writeFileSync(statePath(home), JSON.stringify({ version: 1, processed: [], pending: [], runs, watchedRules: [IMPL_KEY], lastPolledAt: { todos: NOW }, projectErrors: {}, orcaOutageSince: null, consumedRequests: [] }))
    }

    function savedOnDisk(): Pick<State, 'configStatus' | 'daemonInfo'> & { tabClosed: unknown[] } {
      const saved = JSON.parse(readFileSync(statePath(home), 'utf8')) as State
      return { configStatus: saved.configStatus, daemonInfo: saved.daemonInfo, tabClosed: saved.runs.map((run) => [run.id, run.phase.kind === 'failed' ? run.phase.tabClosed : null]) }
    }

    it('when the tabs are visible, both runs stay false, and the 2 fields are added and saved', async () => {
      writeConfig()
      write001State()
      const observed: unknown[] = []
      await runCycle(depsWith(orcaWith({ observe: async (input) => { observed.push(input); return snapshot() } })), fresh)
      expect(observed).toEqual([{ paths: [projectPath], hooks: false }])
      expect(savedOnDisk()).toEqual({
        configStatus: { loadedAt: NOW, sha256: configSha(), error: null },
        daemonInfo: { pid: 4242, startedAt: '2026-10-23T00:00:00.000Z', lastCycleAt: NOW, lastCycleError: null, orcaVersion: null, cycleSeconds: 20 },
        tabClosed: [[RUN_A, false], [RUN_B, false]],
      })
    })

    it('when the listing is complete and the tab is not visible, only the one run with a reference becomes true, and nothing is logged', async () => {
      writeConfig()
      write001State()
      await runCycle(depsWith(orcaWith({ observe: async () => snapshot([], []) })), fresh)
      expect(savedOnDisk().tabClosed).toEqual([[RUN_A, true], [RUN_B, false]])
      expect(loadState(home).runs.map((run) => run.history)).toEqual([[], []])
      expect(logText()).toBe('')
    })
  })
})

describe('start', () => {
  function mockExit(): void {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${code}`)
    })
  }

  it('G7: persists the launch failure, suppresses the restart notification for the same configuration, and notifies the same failure again after repair', async () => {
    mockExit()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'on').mockImplementation(() => process)
    const marker = join(home, 'state', 'startup-error.json')
    const startup = vi.fn<(ok: boolean) => void>()
    const deps = depsWith(orcaWith({ status: async () => ({ running: true, version: 'test' }) }))
    writeConfig()
    const valid = readFileSync(join(home, 'config.yaml'), 'utf8')
    const invalid = valid.replace('version: 1', 'version: 2')
    const fail = async (): Promise<void> => {
      await expect(start(deps, startup)).rejects.toThrow('exit 0')
      expect(startup).toHaveBeenLastCalledWith(false)
      expect(existsSync(lockPath(home))).toBe(false)
      expect(vi.mocked(sleep)).toHaveBeenLastCalledWith(60_000)
    }
    writeFileSync(join(home, 'config.yaml'), invalid)
    await fail()
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(['version: 1 is required (got: 2)'])
    expect(notices).toEqual([{ title: 'orcapod: config broken, cannot start', message: 'version: 1 is required (got: 2)' }])
    const first = readFileSync(marker, 'utf8')
    await fail()
    expect(notices).toHaveLength(1)
    expect(readFileSync(marker, 'utf8')).toBe(first)

    writeFileSync(join(home, 'config.yaml'), valid.replace('version: 1', 'version: 3'))
    await fail()
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(['version: 1 is required (got: 3)'])
    expect(notices).toHaveLength(2)
    expect(notices[1].message).toBe('version: 1 is required (got: 3)')

    writeFileSync(join(home, 'config.yaml'), valid)
    // Stop at the real successful startup acknowledgment, before the cycle loop.
    await expect(start(deps, (ok) => {
      expect(ok).toBe(true)
      expect(existsSync(marker)).toBe(false)
      throw new Error('startup observed')
    })).rejects.toThrow('startup observed')
    expect(notices).toHaveLength(2)
    expect(logText()).toContain('daemon started')
    const { releaseDaemonLock } = await import('../src/state.ts')
    releaseDaemonLock(home, process.pid)
    writeFileSync(join(home, 'config.yaml'), invalid)
    await fail()
    expect(notices).toHaveLength(3)
    expect(notices[2]).toEqual(notices[0])
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(['version: 1 is required (got: 2)'])
  })

  it('when the gh account listing cannot be read, releases the lock, waits 60 seconds, and exits with code 1', async () => {
    mockExit()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = depsWith(orcaWith({}), undefined, { ghAccounts: async () => { throw new Error('cannot run gh auth status: gh not found') } })
    await expect(start(deps)).rejects.toThrow('exit 1')
    expect(error).toHaveBeenCalledWith('orcapod start: cannot run gh auth status: gh not found')
    expect(existsSync(lockPath(home))).toBe(false)
    expect(vi.mocked(sleep)).toHaveBeenCalledWith(60_000)
  })

  it('X1-11: when the content shape of state.json is broken, releases the lock, waits 60 seconds, and exits with code 1', async () => {
    mockExit()
    writeConfig()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mkdirSync(join(home, 'state'), { recursive: true })
    writeFileSync(statePath(home), JSON.stringify({ ...stateWith(), pending: [{ ruleKey: IMPL_KEY }] }))
    await expect(start(depsWith(orcaWith({})))).rejects.toThrow('exit 1')
    expect(error).toHaveBeenCalledWith(`orcapod start: ${statePath(home)} is corrupt: pending[0].project is not a string`)
    expect(existsSync(lockPath(home))).toBe(false)
    expect(vi.mocked(sleep)).toHaveBeenCalledWith(60_000)
  })

  it('I10: at startup, determines the Orca version and configuration identity and saves them in the first cycle, and records a cycle that ended with an exception in lastCycleError of the next cycle that saves', async () => {
    mockExit()
    writeConfig()
    saveState(home, stateWith())
    vi.spyOn(process, 'on').mockImplementation(() => process)
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    let startError: unknown = null
    const untilNextCycleScheduled = async (): Promise<void> => {
      for (let i = 0; i < 1000 && vi.getTimerCount() === 0 && startError === null; i++) await new Promise((resolve) => setImmediate(resolve))
      expect([startError, vi.getTimerCount()]).toEqual([null, 1])
    }
    try {
      start(depsWith(orcaWith({ status: async () => ({ running: true, version: '1.4.217' }) }))).catch((error: unknown) => {
        startError = error
      })
      await untilNextCycleScheduled()
      const daemonInfo = { pid: process.pid, startedAt: NOW, lastCycleAt: NOW, lastCycleError: null, orcaVersion: '1.4.217', cycleSeconds: 20 }
      expect([loadState(home).configStatus, loadState(home).daemonInfo]).toEqual([{ loadedAt: NOW, sha256: configSha(), error: null }, daemonInfo])

      const valid = readFileSync(statePath(home), 'utf8')
      const broken = JSON.stringify({ ...stateWith(), runs: [{}] })
      writeFileSync(statePath(home), broken)
      vi.advanceTimersByTime(20_000)
      await untilNextCycleScheduled()
      expect(readFileSync(statePath(home), 'utf8')).toBe(broken)
      expect(logText()).toContain(`error cycle failed: ${statePath(home)} is corrupt: runs[0].id is not a string`)

      writeFileSync(statePath(home), valid)
      vi.advanceTimersByTime(20_000)
      await untilNextCycleScheduled()
      expect(loadState(home).daemonInfo).toEqual({ ...daemonInfo, lastCycleError: { at: NOW, message: `${statePath(home)} is corrupt: runs[0].id is not a string` } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('when a live pid holds the lock, reports that it is already running and exits with code 1', async () => {
    expect(acquireDaemonLock(home, process.pid)).toEqual({ ok: true })
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${code}`)
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(start(depsWith(orcaWith({})))).rejects.toThrow('exit 1')
    expect(exit).toHaveBeenCalledWith(1)
    expect(error).toHaveBeenCalledWith(`orcapod start: already running (pid ${process.pid})`)
  })
})

describe('incident recovery cycle persistence', () => {
  it('takes the result of a real file, does not apply before approval, and tracks until verification completes after approval', async () => {
    writeConfig()
    const source = runWith({ phase: { kind: 'failed', at: NOW, reason: 'operating doc mismatch', tabClosed: true }, orca: null, incident: { status: 'pending', reason: 'waiting to investigate', updatedAt: NOW, tasks: [], evidence: [], revisions: [] } })
    saveState(home, stateWith({ runs: [source] }))
    let creates = 0
    const orca = orcaWith({
      observe: async () => snapshot([], []),
      createTerminal: async () => {
        creates++
        return { ref: { ...REF, handle: `term-${creates}`, paneKey: `tab-${creates}:pane`, tabId: `tab-${creates}` }, warning: null }
      },
    })
    await runCycle(depsWith(orca), fresh)
    let saved = loadState(home)
    const prepareId = saved.runs[1].id
    expect(saved.runs[1].recovery?.stage).toBe('prepare')
    const proposal = { summary: 'align operations', cause: 'doc mismatch', evidence: ['checked the code'], changes: [], validation: ['unit tests passed'], actions: ['apply the approved scope and verify'], risks: [] }
    writeFileSync(join(home, 'runs', prepareId, 'result.json'), JSON.stringify({ status: 'done', summary: 'prepared', links: [], proposal }))
    await runCycle(depsWith(orca), fresh)
    await runCycle(depsWith(orca), fresh)
    saved = loadState(home)
    expect(saved.runs[0].incident?.status).toBe('awaiting_approval')
    expect(creates).toBe(1)
    expect(notices.some((notice) => notice.title === 'orcapod: approval needed')).toBe(true)
    const revision = saved.runs[0].incident!.proposal!.revision
    writeRequest(home, { type: 'approve', runId: source.id, revision })
    await runCycle(depsWith(orca), fresh)
    saved = loadState(home)
    const apply = saved.runs[2]
    expect(creates).toBe(2)
    expect(apply.recovery?.proposal?.revision).toBe(revision)
    expect(readFileSync(join(home, 'runs', apply.id, 'prompt.md'), 'utf8')).toContain(revision)
    writeFileSync(join(home, 'runs', apply.id, 'result.json'), JSON.stringify({ status: 'done', summary: 'applied', links: [], verification: ['verified consistency after applying'] }))
    await runCycle(depsWith(orca), fresh)
    await runCycle(depsWith(orca), fresh)
    saved = loadState(home)
    expect(saved.runs[0].incident?.status).toBe('resolved')
    expect(saved.runs[0].phase.kind).toBe('failed')
    expect(creates).toBe(2)
    expect(saved.runs).toHaveLength(3)
  })
})

describe('invalid late pane', () => {
  it.each(['{}', '{', '{"handle":"","tabId":"","paneKey":""}'])('a half-written or unidentifiable pane %s is not used for termination confirmation', async (pane) => {
    writeConfig()
    const source = runWith({ phase: { kind: 'failed', at: NOW, reason: 'launch unknown', tabClosed: false }, orca: null, launchUncertain: true })
    saveState(home, stateWith({ runs: [source] }))
    mkdirSync(join(home, 'runs', source.id), { recursive: true })
    writeFileSync(join(home, 'runs', source.id, 'pane.json'), pane)
    await runCycle(depsWith(orcaWith({ observe: async () => snapshot([], []) })), fresh)
    expect(loadState(home).runs[0].launchUncertain).toBe(true)
    expect(loadState(home).runs[0].orca).toBeNull()
    expect(loadState(home).runs[0].phase).toMatchObject({ tabClosed: false })
  })
})
