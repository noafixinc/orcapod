import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentObservation, AgentState, Ai, HooksState, OrcaClient, OrcaRef, OrcaSnapshot, TerminalList, TerminalObservation } from './types.ts'

export type ExecFile = (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>

const DEFAULT_BIN = '/Applications/Orca.app/Contents/Resources/bin/orca'
const EXEC_TIMEOUT_MS = 60_000
const WAIT_EXIT_MARGIN_MS = 10_000
const MAX_BUFFER = 64 * 1024 * 1024
const AGENT_STATES: readonly AgentState[] = ['working', 'blocked', 'waiting', 'done']
const HOOKS_STATES: readonly HooksState[] = ['installed', 'not_installed', 'partial', 'skipped', 'error']

export const WAITING_TOOL_NAMES: readonly string[] = ['AskUserQuestion']

export class OrcaError extends Error {
  code: string

  constructor(code: string, message: string = code) {
    super(message)
    this.name = 'OrcaError'
    this.code = code
  }
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(path: string, expected: string): OrcaError {
  return new OrcaError('invalid_response', `${path} is not ${expected}`)
}

function objectAt(value: unknown, path: string): JsonObject {
  if (!isObject(value)) throw invalid(path, 'an object')
  return value
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw invalid(path, 'an array')
  return value
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') throw invalid(path, 'a non-empty string')
  return value
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function parseEnvelope(json: unknown): unknown {
  const envelope = objectAt(json, 'envelope')
  if (envelope.ok === true) return envelope.result
  if (envelope.ok === false) {
    const error = isObject(envelope.error) ? envelope.error : {}
    const code = typeof error.code === 'string' && error.code !== '' ? error.code : 'runtime_error'
    throw new OrcaError(code, typeof error.message === 'string' && error.message !== '' ? error.message : code)
  }
  throw invalid('envelope.ok', 'true / false')
}

export function parseStatus(result: unknown): { running: boolean; version: string | null } {
  const body = objectAt(result, 'result')
  const app = objectAt(body.app, 'result.app')
  const runtime = isObject(body.runtime) ? body.runtime : {}
  return { running: app.running === true, version: stringOrNull(runtime.appVersion) }
}

export function parseCreate(result: unknown): { ref: OrcaRef; warning: string | null } {
  const terminal = objectAt(objectAt(result, 'result').terminal, 'result.terminal')
  if (typeof terminal.paneKey !== 'string' || terminal.paneKey === '') {
    throw new OrcaError('no_pane_key', 'terminal create response has no paneKey')
  }
  const ref: OrcaRef = {
    handle: stringAt(terminal.handle, 'result.terminal.handle'),
    tabId: stringAt(terminal.tabId, 'result.terminal.tabId'),
    paneKey: terminal.paneKey,
    ptyId: typeof terminal.ptyId === 'string' ? terminal.ptyId : '',
  }
  const warnings = [stringOrNull(terminal.warning), terminal.surface === 'background' ? 'surface: background' : null].filter((w): w is string => w !== null && w !== '')
  return { ref, warning: warnings.length > 0 ? warnings.join(' / ') : null }
}

function parseTerminal(value: unknown, path: string): TerminalObservation {
  const terminal = objectAt(value, path)
  return {
    handle: stringAt(terminal.handle, `${path}.handle`),
    tabId: stringAt(terminal.tabId, `${path}.tabId`),
    leafId: stringAt(terminal.leafId, `${path}.leafId`),
    ptyId: stringOrNull(terminal.ptyId),
    orphaned: terminal.orphaned === true,
    title: stringOrNull(terminal.title),
  }
}

export function parseList(result: unknown): TerminalList {
  const body = objectAt(result, 'result')
  const terminals = arrayAt(body.terminals, 'result.terminals').map((t, i) => parseTerminal(t, `result.terminals[${i}]`))
  return { terminals, complete: body.truncated === false }
}

function parseAgentState(value: unknown, path: string): AgentState {
  const state = AGENT_STATES.find((s) => s === value)
  if (state === undefined) throw new OrcaError('unknown_state', `${path} has an unknown value: ${JSON.stringify(value)}`)
  return state
}

function parseAgent(value: unknown, path: string): AgentObservation {
  const agent = objectAt(value, path)
  const startedAt = agent.stateStartedAt
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) throw invalid(`${path}.stateStartedAt`, 'epoch ms')
  return {
    paneKey: stringAt(agent.paneKey, `${path}.paneKey`),
    state: parseAgentState(agent.state, `${path}.state`),
    stateSince: new Date(startedAt).toISOString(),
    agentType: stringOrNull(agent.agentType),
    toolName: stringOrNull(agent.toolName),
    lastAssistantMessage: stringOrNull(agent.lastAssistantMessage),
  }
}

export function parsePs(result: unknown): Map<string, AgentObservation[]> {
  const worktrees = arrayAt(objectAt(result, 'result').worktrees, 'result.worktrees')
  const byPath = new Map<string, AgentObservation[]>()
  worktrees.forEach((value, i) => {
    const path = `result.worktrees[${i}]`
    const worktree = objectAt(value, path)
    const worktreePath = stringAt(worktree.path, `${path}.path`)
    const agents = arrayAt(worktree.agents, `${path}.agents`).map((a, j) => parseAgent(a, `${path}.agents[${j}]`))
    byPath.set(worktreePath, [...(byPath.get(worktreePath) ?? []), ...agents])
  })
  return byPath
}

export function parseClose(result: unknown): { ptyKilled: boolean | null } {
  const close = objectAt(objectAt(result, 'result').close, 'result.close')
  return { ptyKilled: typeof close.ptyKilled === 'boolean' ? close.ptyKilled : null }
}

export function parseRead(result: unknown, lines: number): { lines: string[]; rendered: boolean } {
  const terminal = objectAt(objectAt(result, 'result').terminal, 'result.terminal')
  const tail = arrayAt(terminal.tail, 'result.terminal.tail').map((line, i) => {
    if (typeof line !== 'string') throw invalid(`result.terminal.tail[${i}]`, 'a string')
    return line
  })
  return { lines: lines > 0 ? tail.slice(-lines) : [], rendered: terminal.source === 'screen' }
}

function parseHooksState(value: unknown): HooksState {
  return HOOKS_STATES.find((s) => s === value) ?? 'unknown'
}

export function parseHooksStatus(result: unknown): { enabled: boolean; agents: Record<Ai, HooksState> } {
  const body = objectAt(result, 'result')
  const statuses = arrayAt(body.statuses, 'result.statuses').filter(isObject)
  const stateOf = (ai: Ai): HooksState => {
    const status = statuses.find((s) => s.agent === ai)
    return status === undefined ? 'not_installed' : parseHooksState(status.state)
  }
  return { enabled: body.enabled !== false, agents: { claude: stateOf('claude'), codex: stateOf('codex') } }
}

export function parseWait(result: unknown): { exited: boolean } {
  const wait = objectAt(objectAt(result, 'result').wait, 'result.wait')
  return { exited: wait.satisfied !== false }
}

export function parseRepoList(result: unknown): string[] {
  return arrayAt(objectAt(result, 'result').repos, 'result.repos').map((repo, i) => stringAt(objectAt(repo, `result.repos[${i}]`).path, `result.repos[${i}].path`))
}

export const paneKeyOf = (t: TerminalObservation): string => `${t.tabId}:${t.leafId}`

export function findTerminal(list: TerminalList, ref: OrcaRef): TerminalObservation | null {
  const byPaneKey = list.terminals.find((t) => paneKeyOf(t) === ref.paneKey)
  if (byPaneKey !== undefined) return byPaneKey
  if (ref.ptyId === '') return null
  return list.terminals.find((t) => t.ptyId === ref.ptyId) ?? null
}

export function findAgent(agents: AgentObservation[], ref: OrcaRef): AgentObservation | null {
  return agents.find((a) => a.paneKey === ref.paneKey) ?? null
}

function parseStdout(stdout: string, command: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    throw new OrcaError('invalid_json', `${command} output is not JSON`)
  }
}

function stdoutOfRejection(error: unknown): string {
  return isObject(error) && typeof error.stdout === 'string' ? error.stdout : ''
}

function describeRejection(error: unknown): string {
  const stderr = isObject(error) && typeof error.stderr === 'string' ? error.stderr.trim() : ''
  if (stderr !== '') return stderr
  return error instanceof Error ? error.message : String(error)
}

const defaultExecFile: ExecFile = promisify(execFile)

export function createOrcaClient(bin: string = DEFAULT_BIN, run: ExecFile = defaultExecFile): OrcaClient {
  const call = async (args: string[], timeout: number = EXEC_TIMEOUT_MS): Promise<unknown> => {
    const command = `orca ${args.join(' ')}`
    let stdout: string
    try {
      stdout = (await run(bin, [...args, '--json'], { timeout, maxBuffer: MAX_BUFFER })).stdout
    } catch (error) {
      // The Orca CLI prints the failure envelope to stdout and exits with code 1 (P8)
      stdout = stdoutOfRejection(error)
      if (stdout.trim() === '') throw new OrcaError('exec_failed', `${command}: ${describeRejection(error)}`)
    }
    return parseEnvelope(parseStdout(stdout, command))
  }

  const worktreePs = async (): Promise<Map<string, AgentObservation[]>> => parsePs(await call(['worktree', 'ps']))
  const listTerminals = async (worktreePath: string): Promise<TerminalList> => parseList(await call(['terminal', 'list', '--worktree', `path:${worktreePath}`]))
  const hooksStatus = async (): Promise<{ enabled: boolean; agents: Record<Ai, HooksState> }> => parseHooksStatus(await call(['agent', 'hooks', 'status']))

  return {
    status: async () => parseStatus(await call(['status'])),
    createTerminal: async ({ worktreePath, title, command }) => parseCreate(await call(['terminal', 'create', '--worktree', `path:${worktreePath}`, '--title', title, '--command', command])),
    listTerminals,
    closeTerminal: async (handle) => parseClose(await call(['terminal', 'close', '--terminal', handle])),
    worktreePs,
    readScreen: async (handle, lines) => parseRead(await call(['terminal', 'read', '--terminal', handle, '--screen']), lines),
    hooksStatus,
    waitExit: async (handle, timeoutMs) => {
      try {
        return parseWait(await call(['terminal', 'wait', '--terminal', handle, '--for', 'exit', '--timeout-ms', String(timeoutMs)], Math.max(EXEC_TIMEOUT_MS, timeoutMs + WAIT_EXIT_MARGIN_MS)))
      } catch (error) {
        if (error instanceof OrcaError && error.code === 'timeout') return { exited: false }
        throw error
      }
    },
    registeredPaths: async () => parseRepoList(await call(['repo', 'list'])),
    observe: async ({ paths, hooks }): Promise<OrcaSnapshot> => {
      const listOrIncomplete = async (path: string): Promise<[string, TerminalList]> => {
        try {
          return [path, await listTerminals(path)]
        } catch {
          return [path, { terminals: [], complete: false }]
        }
      }
      const [agents, lists, hooksState] = await Promise.all([
        worktreePs(),
        Promise.all([...new Set(paths)].map(listOrIncomplete)),
        hooks ? hooksStatus().catch(() => null) : Promise.resolve(null),
      ])
      return { agents, terminals: new Map(lists), hooks: hooksState }
    },
  }
}

export function usablePane(ref: OrcaRef): boolean {
  return ref.handle.trim() !== '' && ref.tabId.trim() !== '' && ref.paneKey.trim() !== ''
}
