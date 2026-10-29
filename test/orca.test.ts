import { describe, expect, it } from 'vitest'
import type { ExecFile } from '../src/orca.ts'
import { OrcaError, WAITING_TOOL_NAMES, createOrcaClient, findAgent, findTerminal, paneKeyOf, parseClose, parseCreate, parseEnvelope, parseHooksStatus, parseList, parsePs, parseRead, parseRepoList, parseStatus, parseWait } from '../src/orca.ts'
import type { AgentObservation, OrcaRef, TerminalList } from '../src/types.ts'

const TAB = '005abc9f-6c2e-4d1a-9b7e-1f2a3b4c5d6e'
const LEAF = '3e1b7c20-8a4f-4b6d-a1c9-7d2e5f8a9b01'
const PANE = '005abc9f-6c2e-4d1a-9b7e-1f2a3b4c5d6e:3e1b7c20-8a4f-4b6d-a1c9-7d2e5f8a9b01'
const PROJECT = '/Users/alice/git/orcapod'

function codeThrownBy(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return error instanceof OrcaError ? error.code : `not OrcaError: ${String(error)}`
  }
  return 'did not throw'
}

function success(result: unknown): string {
  return JSON.stringify({ id: 'cli-1', ok: true, result, _meta: { runtimeId: 'rt-4f2a' } })
}

function failure(code: string, message: string): string {
  return JSON.stringify({ id: 'cli-1', ok: false, error: { code, message }, _meta: { runtimeId: 'rt-4f2a' } })
}

function exitedWithCode1(stdout: string, stderr = ''): Error {
  return Object.assign(new Error('Command failed: orca'), { code: 1, stdout, stderr })
}

interface Call { file: string; args: string[]; options: { timeout: number; maxBuffer: number } }

function fakeExec(respond: (args: string[]) => string | Error): { exec: ExecFile; calls: Call[] } {
  const calls: Call[] = []
  const exec: ExecFile = async (file, args, options) => {
    calls.push({ file, args, options })
    const answer = respond(args)
    if (answer instanceof Error) throw answer
    return { stdout: answer, stderr: '' }
  }
  return { exec, calls }
}

const spikeCreate = {
  terminal: {
    handle: 'term_101bbf07-984a-499b-b311-eccf58f81592',
    tabId: TAB,
    paneKey: PANE,
    ptyId: 'd0f717f5-3057-4454-a786-ecc357dcf861::/Users/alice/git/orcapod@@9029ec62',
    worktreeId: 'wt-orcapod-main',
    title: '#123 Feature',
    surface: 'visible',
  },
}

const spikeList = {
  terminals: [
    {
      handle: 'term_101bbf07-984a-499b-b311-eccf58f81592',
      ptyId: 'd0f717f5-3057-4454-a786-ecc357dcf861::/Users/alice/git/orcapod@@9029ec62',
      orphaned: false,
      worktreeId: 'wt-orcapod-main',
      worktreePath: PROJECT,
      branch: 'main',
      tabId: TAB,
      leafId: LEAF,
      title: '✳ orcapod spike: write result.json',
      connected: true,
      writable: true,
      lastOutputAt: 1792714640000,
      preview: '',
      agentIdentity: 'claude',
    },
    {
      handle: 'term_aca909a8-5a90-42b0-b79a-c367585a5e1d',
      ptyId: 'd0f717f5-3057-4454-a786-ecc357dcf861::/Users/alice/git/orcapod@@bda0521a',
      orphaned: true,
      worktreeId: 'wt-orcapod-main',
      worktreePath: PROJECT,
      branch: 'main',
      tabId: 'pty:d0f717f5-3057-4454-a786-ecc357dcf861::/Users/alice/git/orcapod@@bda0521a',
      leafId: 'pty:d0f717f5-3057-4454-a786-ecc357dcf861::/Users/alice/git/orcapod@@bda0521a',
      title: null,
      connected: false,
      writable: false,
      lastOutputAt: null,
      preview: '',
    },
  ],
  totalCount: 2,
  truncated: false,
}

const spikePs = {
  worktrees: [
    {
      worktreeId: 'wt-orcapod-main',
      repoId: 'repo-orcapod',
      repo: 'orcapod',
      path: PROJECT,
      branch: 'main',
      isMainWorktree: true,
      liveTerminalCount: 2,
      status: 'done',
      agents: [
        {
          paneKey: PANE,
          parentPaneKey: null,
          state: 'done',
          agentType: 'claude',
          prompt: 'orcapod spike: write result.json',
          taskTitle: null,
          displayName: null,
          lastAssistantMessage: 'Wrote result.json.',
          toolName: null,
          toolInput: null,
          interrupted: false,
          stateStartedAt: 1792716100123,
          updatedAt: 1792716100200,
        },
        {
          paneKey: '7d0e1f2a-0000-4000-8000-000000000001:9a8b7c6d-0000-4000-8000-000000000002',
          parentPaneKey: null,
          state: 'waiting',
          agentType: null,
          prompt: '',
          taskTitle: null,
          displayName: null,
          lastAssistantMessage: null,
          toolName: 'AskUserQuestion',
          toolInput: '{"question":"Continue?"}',
          interrupted: false,
          stateStartedAt: 1792714640000,
          updatedAt: 1792714641000,
        },
      ],
    },
    {
      worktreeId: 'wt-todos-main',
      repoId: 'repo-todos',
      repo: 'todos',
      path: '/Users/alice/git/todos',
      branch: 'main',
      isMainWorktree: true,
      liveTerminalCount: 0,
      status: 'inactive',
      agents: [],
    },
  ],
  totalCount: 2,
  truncated: false,
}

const spikeHooks = {
  enabled: true,
  settingsPath: '/Users/alice/Library/Application Support/orca',
  appliedBy: 'offline',
  statuses: [
    { agent: 'claude', state: 'installed', configPath: '/Users/alice/.claude/settings.json', managedHooksPresent: true, detail: null },
    { agent: 'codex', state: 'partial', configPath: '/Users/alice/.codex/hooks.json', managedHooksPresent: true, detail: 'missing Stop hook' },
    { agent: 'dsh', state: 'skipped', configPath: '', managedHooksPresent: false, detail: null, skipReason: 'cli_not_found' },
  ],
}

describe('parseEnvelope', () => {
  it('returns result when ok: true', () => {
    expect(parseEnvelope(JSON.parse(success({ close: { handle: 'term-1', tabId: TAB, ptyKilled: true } })))).toEqual({ close: { handle: 'term-1', tabId: TAB, ptyKilled: true } })
  })

  it('throws an OrcaError carrying error.code and error.message when ok: false', () => {
    let thrown: unknown
    try {
      parseEnvelope(JSON.parse(failure('terminal_handle_stale', 'Terminal handle term-1 is stale.')))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(OrcaError)
    expect({ code: (thrown as OrcaError).code, message: (thrown as OrcaError).message }).toEqual({ code: 'terminal_handle_stale', message: 'Terminal handle term-1 is stale.' })
  })

  it('a failure without error.code is runtime_error', () => {
    expect(codeThrownBy(() => parseEnvelope({ id: 'local', ok: false, error: {} }))).toBe('runtime_error')
  })

  it('invalid_response when the value is not in the envelope shape', () => {
    expect(codeThrownBy(() => parseEnvelope([]))).toBe('invalid_response')
    expect(codeThrownBy(() => parseEnvelope({ id: 'x', result: {} }))).toBe('invalid_response')
  })
})

describe('parseStatus', () => {
  it('reads result.app.running and result.runtime.appVersion', () => {
    expect(parseStatus({ target: { kind: 'local' }, app: { running: true, pid: 4242 }, runtime: { state: 'ready', reachable: true, runtimeId: 'rt-4f2a', appVersion: '1.4.217' }, graph: { state: 'ready' } })).toEqual({ running: true, version: '1.4.217' })
  })

  it('when not running, running: false and the revision is null', () => {
    expect(parseStatus({ target: { kind: 'local' }, app: { running: false, pid: null }, runtime: { state: 'not_running', reachable: false, runtimeId: null }, graph: { state: 'not_running' } })).toEqual({ running: false, version: null })
  })
})

describe('parseCreate', () => {
  it('maps the spike response to an OrcaRef', () => {
    expect(parseCreate(parseEnvelope(JSON.parse(success(spikeCreate))))).toEqual({
      ref: { handle: 'term_101bbf07-984a-499b-b311-eccf58f81592', tabId: TAB, paneKey: PANE, ptyId: 'd0f717f5-3057-4454-a786-ecc357dcf861::/Users/alice/git/orcapod@@9029ec62' },
      warning: null,
    })
  })

  it('a response without paneKey is OrcaError(no_pane_key)', () => {
    expect(codeThrownBy(() => parseCreate({ terminal: { handle: 'term_101bbf07-984a-499b-b311-eccf58f81592', worktreeId: 'wt-orcapod-main', title: null, paneKey: null, ptyId: null } }))).toBe('no_pane_key')
    expect(codeThrownBy(() => parseCreate({ terminal: { handle: 'term_101bbf07-984a-499b-b311-eccf58f81592', worktreeId: 'wt-orcapod-main', title: null } }))).toBe('no_pane_key')
  })

  it('a response without tabId is invalid_response', () => {
    expect(codeThrownBy(() => parseCreate({ terminal: { handle: 'term_101bbf07-984a-499b-b311-eccf58f81592', paneKey: PANE, ptyId: 'd0f717f5-3057-4454-a786-ecc357dcf861::/Users/alice/git/orcapod@@9029ec62', worktreeId: 'wt-orcapod-main', title: null } }))).toBe('invalid_response')
  })

  it('a ptyId of null becomes an empty string', () => {
    expect(parseCreate({ terminal: { ...spikeCreate.terminal, ptyId: null } }).ref.ptyId).toBe('')
  })

  it('merges warning and surface: background into warning', () => {
    expect(parseCreate({ terminal: { ...spikeCreate.terminal, surface: 'background', warning: 'Created terminal term_101bbf07-984a-499b-b311-eccf58f81592 but could not reveal it.' } }).warning).toBe('Created terminal term_101bbf07-984a-499b-b311-eccf58f81592 but could not reveal it. / surface: background')
    expect(parseCreate({ terminal: { ...spikeCreate.terminal, surface: 'background' } }).warning).toBe('surface: background')
  })
})

describe('parseList', () => {
  it('maps terminals, and truncated: false gives complete: true', () => {
    expect(parseList(spikeList)).toEqual({
      terminals: [
        { handle: 'term_101bbf07-984a-499b-b311-eccf58f81592', tabId: TAB, leafId: LEAF, ptyId: 'd0f717f5-3057-4454-a786-ecc357dcf861::/Users/alice/git/orcapod@@9029ec62', orphaned: false, title: '✳ orcapod spike: write result.json' },
        { handle: 'term_aca909a8-5a90-42b0-b79a-c367585a5e1d', tabId: 'pty:d0f717f5-3057-4454-a786-ecc357dcf861::/Users/alice/git/orcapod@@bda0521a', leafId: 'pty:d0f717f5-3057-4454-a786-ecc357dcf861::/Users/alice/git/orcapod@@bda0521a', ptyId: 'd0f717f5-3057-4454-a786-ecc357dcf861::/Users/alice/git/orcapod@@bda0521a', orphaned: true, title: null },
      ],
      complete: true,
    })
  })

  it('truncated: true gives complete: false', () => {
    expect(parseList({ terminals: [], totalCount: 240, truncated: true })).toEqual({ terminals: [], complete: false })
  })

  it('without truncated, the listing is not considered complete', () => {
    expect(parseList({ terminals: [] }).complete).toBe(false)
  })

  it('an entry without orphaned is false, and a missing ptyId or title is null', () => {
    expect(parseList({ terminals: [{ handle: 'term-1', tabId: TAB, leafId: LEAF }], truncated: false }).terminals).toEqual([{ handle: 'term-1', tabId: TAB, leafId: LEAF, ptyId: null, orphaned: false, title: null }])
  })

  it('an entry without handle is invalid_response (entries are not silently dropped)', () => {
    expect(codeThrownBy(() => parseList({ terminals: [{ tabId: TAB, leafId: LEAF }], truncated: false }))).toBe('invalid_response')
  })
})

describe('parsePs', () => {
  it('maps agents per worktree path and converts stateStartedAt to ISO', () => {
    expect(parsePs(spikePs)).toEqual(new Map<string, AgentObservation[]>([
      [PROJECT, [
        { paneKey: PANE, state: 'done', stateSince: '2026-10-23T00:41:40.123Z', agentType: 'claude', toolName: null, lastAssistantMessage: 'Wrote result.json.' },
        { paneKey: '7d0e1f2a-0000-4000-8000-000000000001:9a8b7c6d-0000-4000-8000-000000000002', state: 'waiting', stateSince: '2026-10-23T00:17:20.000Z', agentType: null, toolName: 'AskUserQuestion', lastAssistantMessage: null },
      ]],
      ['/Users/alice/git/todos', []],
    ]))
  })

  it('concatenates agents when the same path appears twice', () => {
    const agent = { paneKey: PANE, state: 'working', agentType: 'codex', lastAssistantMessage: null, toolName: 'shell', stateStartedAt: 1792714640000 }
    expect(parsePs({ worktrees: [{ path: PROJECT, agents: [agent] }, { path: PROJECT, agents: [{ ...agent, paneKey: 'tab-2:leaf-2' }] }] }).get(PROJECT)).toEqual([
      { paneKey: PANE, state: 'working', stateSince: '2026-10-23T00:17:20.000Z', agentType: 'codex', toolName: 'shell', lastAssistantMessage: null },
      { paneKey: 'tab-2:leaf-2', state: 'working', stateSince: '2026-10-23T00:17:20.000Z', agentType: 'codex', toolName: 'shell', lastAssistantMessage: null },
    ])
  })

  it('an unknown state is OrcaError(unknown_state)', () => {
    expect(codeThrownBy(() => parsePs({ worktrees: [{ path: PROJECT, agents: [{ paneKey: PANE, state: 'idle', stateStartedAt: 1792714640000 }] }] }))).toBe('unknown_state')
  })

  it('invalid_response when stateStartedAt is not a number', () => {
    expect(codeThrownBy(() => parsePs({ worktrees: [{ path: PROJECT, agents: [{ paneKey: PANE, state: 'done', stateStartedAt: '2026-10-23T00:17:20Z' }] }] }))).toBe('invalid_response')
  })

  it('invalid_response when worktrees is missing', () => {
    expect(codeThrownBy(() => parsePs({}))).toBe('invalid_response')
  })
})

describe('parseClose', () => {
  it('returns ptyKilled as is', () => {
    expect(parseClose({ close: { handle: 'term_101bbf07-984a-499b-b311-eccf58f81592', tabId: TAB, ptyKilled: true } })).toEqual({ ptyKilled: true })
    expect(parseClose({ close: { handle: 'term_101bbf07-984a-499b-b311-eccf58f81592', tabId: TAB, ptyKilled: false } })).toEqual({ ptyKilled: false })
  })

  it('ptyKilled is null when missing', () => {
    expect(parseClose({ close: { handle: 'term_101bbf07-984a-499b-b311-eccf58f81592', tabId: TAB } })).toEqual({ ptyKilled: null })
  })
})

describe('parseRead', () => {
  const screen = {
    terminal: {
      handle: 'term_101bbf07-984a-499b-b311-eccf58f81592',
      status: 'running',
      tail: ['', ' Do you trust the files in this folder?', '', ' /Users/alice/git/orcapod', '', ' ❯ 1. Yes, I trust this folder', '   2. No, exit', '', ' Enter to confirm · Esc to cancel'],
      truncated: false,
      nextCursor: null,
      source: 'screen',
    },
  }

  it('source: screen gives rendered: true and the last `lines` lines', () => {
    expect(parseRead(screen, 3)).toEqual({ lines: ['   2. No, exit', '', ' Enter to confirm · Esc to cancel'], rendered: true })
  })

  it('source: screen-unavailable gives rendered: false', () => {
    expect(parseRead({ terminal: { ...screen.terminal, tail: [], source: 'screen-unavailable' } }, 6)).toEqual({ lines: [], rendered: false })
  })

  it('empty when lines is 0', () => {
    expect(parseRead(screen, 0)).toEqual({ lines: [], rendered: true })
  })

  it('G6: rejects non-string tail elements with OrcaError and shows the element position', () => {
    expect(() => parseRead({ terminal: { tail: ['ok', 42], source: 'screen' } }, 6)).toThrow(OrcaError)
    expect(() => parseRead({ terminal: { tail: ['ok', 42], source: 'screen' } }, 6)).toThrow(expect.objectContaining({
      code: 'invalid_response', message: expect.stringContaining('result.terminal.tail[1]'),
    }))
  })
})

describe('parseHooksStatus', () => {
  it('maps the claude and codex states and ignores other agents', () => {
    expect(parseHooksStatus(spikeHooks)).toEqual({ enabled: true, agents: { claude: 'installed', codex: 'partial' } })
  })

  it('maps enabled: false', () => {
    expect(parseHooksStatus({ ...spikeHooks, enabled: false })).toEqual({ enabled: false, agents: { claude: 'installed', codex: 'partial' } })
  })

  it('a missing agent is not_installed, and anything other than the 5 values is unknown', () => {
    expect(parseHooksStatus({ enabled: true, statuses: [{ agent: 'claude', state: 'outdated', configPath: '', managedHooksPresent: false, detail: null }] })).toEqual({ enabled: true, agents: { claude: 'unknown', codex: 'not_installed' } })
  })
})

describe('parseWait and parseRepoList', () => {
  it('satisfied: true gives exited: true, false gives exited: false', () => {
    expect(parseWait({ wait: { handle: 'term_101bbf07-984a-499b-b311-eccf58f81592', condition: 'exit', satisfied: true, status: 'exited', exitCode: 0 } })).toEqual({ exited: true })
    expect(parseWait({ wait: { handle: 'term_101bbf07-984a-499b-b311-eccf58f81592', condition: 'exit', satisfied: false, status: 'running', exitCode: null } })).toEqual({ exited: false })
  })

  it('returns result.repos[].path', () => {
    expect(parseRepoList({ repos: [{ id: 'repo-orcapod', path: PROJECT, displayName: 'orcapod' }, { id: 'repo-todos', path: '/Users/alice/git/todos', displayName: 'todos' }] })).toEqual([PROJECT, '/Users/alice/git/todos'])
  })
})

describe('pane lookup', () => {
  const ref: OrcaRef = { handle: 'term-old', tabId: TAB, paneKey: PANE, ptyId: 'd0f717f5-3057-4454-a786-ecc357dcf861::/Users/alice/git/orcapod@@bda0521a' }

  it('paneKeyOf is tabId:leafId', () => {
    expect(paneKeyOf({ handle: 'term_101bbf07-984a-499b-b311-eccf58f81592', tabId: TAB, leafId: LEAF, ptyId: 'd0f717f5-3057-4454-a786-ecc357dcf861::/Users/alice/git/orcapod@@9029ec62', orphaned: false, title: null })).toBe(PANE)
  })

  it('a paneKey match takes precedence over a ptyId match', () => {
    const list = parseList(spikeList)
    expect(findTerminal(list, ref)?.handle).toBe('term_101bbf07-984a-499b-b311-eccf58f81592')
  })

  it('can look up by ptyId even when an orphaned paneKey is replaced by pty:', () => {
    const list = parseList({ ...spikeList, terminals: [spikeList.terminals[1]] })
    expect(findTerminal(list, ref)).toEqual({ handle: 'term_aca909a8-5a90-42b0-b79a-c367585a5e1d', tabId: 'pty:d0f717f5-3057-4454-a786-ecc357dcf861::/Users/alice/git/orcapod@@bda0521a', leafId: 'pty:d0f717f5-3057-4454-a786-ecc357dcf861::/Users/alice/git/orcapod@@bda0521a', ptyId: 'd0f717f5-3057-4454-a786-ecc357dcf861::/Users/alice/git/orcapod@@bda0521a', orphaned: true, title: null })
  })

  it('does not look up by ptyId when ref.ptyId is an empty string', () => {
    const list: TerminalList = { terminals: [{ handle: 'term-x', tabId: 'pty:', leafId: 'pty:', ptyId: '', orphaned: true, title: null }], complete: true }
    expect(findTerminal(list, { ...ref, ptyId: '' })).toBeNull()
  })

  it('null when neither matches', () => {
    expect(findTerminal(parseList(spikeList), { ...ref, paneKey: 'tab-z:leaf-z', ptyId: 'pty-zzz' })).toBeNull()
  })

  it('findAgent looks up by paneKey', () => {
    const agents = parsePs(spikePs).get(PROJECT) ?? []
    expect(findAgent(agents, ref)?.state).toBe('done')
    expect(findAgent(agents, { ...ref, paneKey: 'tab-z:leaf-z' })).toBeNull()
  })

  it('WAITING_TOOL_NAMES is AskUserQuestion', () => {
    expect(WAITING_TOOL_NAMES).toEqual(['AskUserQuestion'])
  })
})

describe('createOrcaClient', () => {
  it('createTerminal passes the arguments and --json to the default bin, and calls with a 60-second timeout and 64 MiB maxBuffer', async () => {
    const { exec, calls } = fakeExec(() => success(spikeCreate))
    const created = await createOrcaClient(undefined, exec).createTerminal({ worktreePath: PROJECT, title: '#123 Feature', command: "bash '/Users/alice/.orcapod/runs/20261023-0917-3f9a1c/launch.sh'" })
    expect(created).toEqual({ ref: { handle: 'term_101bbf07-984a-499b-b311-eccf58f81592', tabId: TAB, paneKey: PANE, ptyId: 'd0f717f5-3057-4454-a786-ecc357dcf861::/Users/alice/git/orcapod@@9029ec62' }, warning: null })
    expect(calls).toEqual([{
      file: '/Applications/Orca.app/Contents/Resources/bin/orca',
      args: ['terminal', 'create', '--worktree', 'path:/Users/alice/git/orcapod', '--title', '#123 Feature', '--command', "bash '/Users/alice/.orcapod/runs/20261023-0917-3f9a1c/launch.sh'", '--json'],
      options: { timeout: 60000, maxBuffer: 67108864 },
    }])
  })

  it('reads the failure envelope on stdout even with exit code 1, and keeps the code (terminal_handle_stale)', async () => {
    const { exec } = fakeExec(() => exitedWithCode1(failure('terminal_handle_stale', 'Terminal handle term-old is stale.')))
    await expect(createOrcaClient('/opt/orca', exec).closeTerminal('term-old')).rejects.toMatchObject({ name: 'OrcaError', code: 'terminal_handle_stale', message: 'Terminal handle term-old is stale.' })
  })

  it('a close failure envelope that cannot confirm the stop is also an OrcaError (terminal_stop_live)', async () => {
    const { exec } = fakeExec(() => exitedWithCode1(failure('terminal_stop_live', 'Terminal term_101bbf07-984a-499b-b311-eccf58f81592 close failed to confirm the PTY stopped (live). The PTY is live.')))
    await expect(createOrcaClient('/opt/orca', exec).closeTerminal('term_101bbf07-984a-499b-b311-eccf58f81592')).rejects.toMatchObject({ code: 'terminal_stop_live' })
  })

  it('a successful closeTerminal returns ptyKilled', async () => {
    const { exec, calls } = fakeExec(() => success({ close: { handle: 'term_101bbf07-984a-499b-b311-eccf58f81592', tabId: TAB, ptyKilled: true } }))
    expect(await createOrcaClient('/opt/orca', exec).closeTerminal('term_101bbf07-984a-499b-b311-eccf58f81592')).toEqual({ ptyKilled: true })
    expect(calls[0]?.args).toEqual(['terminal', 'close', '--terminal', 'term_101bbf07-984a-499b-b311-eccf58f81592', '--json'])
  })

  it('a failure with empty stdout (e.g. missing bin) is exec_failed and includes stderr', async () => {
    const { exec } = fakeExec(() => Object.assign(new Error('spawn /opt/orca ENOENT'), { code: 'ENOENT', stdout: '', stderr: '' }))
    await expect(createOrcaClient('/opt/orca', exec).status()).rejects.toMatchObject({ code: 'exec_failed', message: 'orca status: spawn /opt/orca ENOENT' })
    const withStderr = fakeExec(() => exitedWithCode1('', 'orca: runtime not reachable'))
    await expect(createOrcaClient('/opt/orca', withStderr.exec).status()).rejects.toMatchObject({ code: 'exec_failed', message: 'orca status: orca: runtime not reachable' })
  })

  it('invalid_json when stdout is not JSON', async () => {
    const { exec } = fakeExec(() => 'Orca is updating…')
    await expect(createOrcaClient('/opt/orca', exec).worktreePs()).rejects.toMatchObject({ code: 'invalid_json' })
  })

  it('commands for readScreen / registeredPaths / hooksStatus / status / listTerminals', async () => {
    const { exec, calls } = fakeExec((args) => {
      if (args[0] === 'terminal' && args[1] === 'read') return success({ terminal: { handle: 'term_101bbf07-984a-499b-b311-eccf58f81592', status: 'running', tail: ['a', 'b'], truncated: false, nextCursor: null, source: 'screen' } })
      if (args[0] === 'repo') return success({ repos: [{ path: PROJECT }] })
      if (args[0] === 'agent') return success(spikeHooks)
      if (args[0] === 'status') return success({ app: { running: true, pid: 1 }, runtime: { appVersion: '1.4.218' } })
      return success({ terminals: [], totalCount: 0, truncated: false })
    })
    const orca = createOrcaClient('/opt/orca', exec)
    expect(await orca.readScreen('term_101bbf07-984a-499b-b311-eccf58f81592', 6)).toEqual({ lines: ['a', 'b'], rendered: true })
    expect(await orca.registeredPaths()).toEqual([PROJECT])
    expect(await orca.hooksStatus()).toEqual({ enabled: true, agents: { claude: 'installed', codex: 'partial' } })
    expect(await orca.status()).toEqual({ running: true, version: '1.4.218' })
    expect(await orca.listTerminals(PROJECT)).toEqual({ terminals: [], complete: true })
    expect(calls.map((c) => c.args)).toEqual([
      ['terminal', 'read', '--terminal', 'term_101bbf07-984a-499b-b311-eccf58f81592', '--screen', '--json'],
      ['repo', 'list', '--json'],
      ['agent', 'hooks', 'status', '--json'],
      ['status', '--json'],
      ['terminal', 'list', '--worktree', 'path:/Users/alice/git/orcapod', '--json'],
    ])
  })
})

describe('waitExit', () => {
  it('exited: true when it exits. The execFile timeout is longer than the wait time', async () => {
    const { exec, calls } = fakeExec(() => success({ wait: { handle: 'term_101bbf07-984a-499b-b311-eccf58f81592', condition: 'exit', satisfied: true, status: 'exited', exitCode: 0 } }))
    expect(await createOrcaClient('/opt/orca', exec).waitExit('term_101bbf07-984a-499b-b311-eccf58f81592', 120000)).toEqual({ exited: true })
    expect(calls).toEqual([{ file: '/opt/orca', args: ['terminal', 'wait', '--terminal', 'term_101bbf07-984a-499b-b311-eccf58f81592', '--for', 'exit', '--timeout-ms', '120000', '--json'], options: { timeout: 130000, maxBuffer: 67108864 } }])
  })

  it('even for a short wait, the execFile timeout is not below 60 seconds', async () => {
    const { exec, calls } = fakeExec(() => success({ wait: { handle: 'term_101bbf07-984a-499b-b311-eccf58f81592', condition: 'exit', satisfied: true, status: 'exited', exitCode: 0 } }))
    await createOrcaClient('/opt/orca', exec).waitExit('term_101bbf07-984a-499b-b311-eccf58f81592', 5000)
    expect(calls[0]?.options.timeout).toBe(60000)
  })

  it('ok: true with satisfied: false (exit code 1) gives exited: false', async () => {
    const { exec } = fakeExec(() => exitedWithCode1(success({ wait: { handle: 'term_101bbf07-984a-499b-b311-eccf58f81592', condition: 'exit', satisfied: false, status: 'running', exitCode: null } })))
    expect(await createOrcaClient('/opt/orca', exec).waitExit('term_101bbf07-984a-499b-b311-eccf58f81592', 5000)).toEqual({ exited: false })
  })

  it('ok: false with code timeout gives exited: false', async () => {
    const { exec } = fakeExec(() => exitedWithCode1(failure('timeout', 'Timed out waiting for terminal term_101bbf07-984a-499b-b311-eccf58f81592.')))
    expect(await createOrcaClient('/opt/orca', exec).waitExit('term_101bbf07-984a-499b-b311-eccf58f81592', 5000)).toEqual({ exited: false })
  })

  it('a failure other than timeout is an OrcaError', async () => {
    const { exec } = fakeExec(() => exitedWithCode1(failure('terminal_handle_stale', 'Terminal handle term_101bbf07-984a-499b-b311-eccf58f81592 is stale.')))
    await expect(createOrcaClient('/opt/orca', exec).waitExit('term_101bbf07-984a-499b-b311-eccf58f81592', 5000)).rejects.toMatchObject({ code: 'terminal_handle_stale' })
  })
})

describe('observe', () => {
  const STOCK = '/Users/alice/git/todos'

  it('combines ps, per-path list and hooks. Only the failed path gets complete: false, and a hooks failure is null', async () => {
    const { exec, calls } = fakeExec((args) => {
      if (args[0] === 'worktree') return success(spikePs)
      if (args[0] === 'terminal' && args[3] === `path:${STOCK}`) return exitedWithCode1(failure('selector_not_found', 'No worktree matches path:/Users/alice/git/todos.'))
      if (args[0] === 'terminal') return success(spikeList)
      return exitedWithCode1('', 'agent hooks status crashed')
    })
    const snapshot = await createOrcaClient('/opt/orca', exec).observe({ paths: [PROJECT, STOCK, PROJECT], hooks: true })
    expect(snapshot.agents).toEqual(parsePs(spikePs))
    expect(snapshot.terminals).toEqual(new Map<string, TerminalList>([
      [PROJECT, parseList(spikeList)],
      [STOCK, { terminals: [], complete: false }],
    ]))
    expect(snapshot.hooks).toBeNull()
    expect(calls.filter((c) => c.args[0] === 'terminal').map((c) => c.args[3])).toEqual([`path:${PROJECT}`, `path:${STOCK}`])
  })

  it('puts hooks in when hooks: true succeeds', async () => {
    const { exec } = fakeExec((args) => (args[0] === 'worktree' ? success(spikePs) : success({ ...spikeHooks, enabled: false })))
    const snapshot = await createOrcaClient('/opt/orca', exec).observe({ paths: [], hooks: true })
    expect(snapshot.hooks).toEqual({ enabled: false, agents: { claude: 'installed', codex: 'partial' } })
    expect(snapshot.terminals).toEqual(new Map())
  })

  it('does not call agent hooks status when hooks: false', async () => {
    const { exec, calls } = fakeExec(() => success(spikePs))
    const snapshot = await createOrcaClient('/opt/orca', exec).observe({ paths: [], hooks: false })
    expect(snapshot.hooks).toBeNull()
    expect(calls.map((c) => c.args)).toEqual([['worktree', 'ps', '--json']])
  })

  it('only a ps failure throws', async () => {
    const { exec } = fakeExec((args) => (args[0] === 'worktree' ? exitedWithCode1(failure('runtime_unavailable', 'Orca is not running.')) : success(spikeList)))
    await expect(createOrcaClient('/opt/orca', exec).observe({ paths: [PROJECT], hooks: true })).rejects.toMatchObject({ code: 'runtime_unavailable' })
  })

  it('an unknown state in ps also throws (a partial observation is not trusted)', async () => {
    const { exec } = fakeExec(() => success({ worktrees: [{ path: PROJECT, agents: [{ paneKey: PANE, state: 'sleeping', stateStartedAt: 1792714640000 }] }] }))
    await expect(createOrcaClient('/opt/orca', exec).observe({ paths: [], hooks: false })).rejects.toMatchObject({ code: 'unknown_state' })
  })
})
