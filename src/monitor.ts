import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { basename, join } from 'node:path'
import { loadConfig, ruleKey } from './config.ts'
import { buildMonitorModel, configViewOf, ruleOfPending, shownConfig } from './monitor-model.ts'
import type { ConfigView, DetailContent, DetailRef, MonitorModel, RunFile } from './monitor-model.ts'
import { clampDetailScroll, initialUi, printableLines, reduceKey, renderScreen } from './monitor-layout.ts'
import type { Key, ScreenLine, ScreenSize, UiState } from './monitor-layout.ts'
import { configPath, lockPath, logPath, resultPath, runDir } from './paths.ts'
import { liveDaemonPid, loadState, readStateSnapshot } from './state.ts'
import { formatStatus } from './status.ts'
import type { ConfigResult, State } from './types.ts'

const ENTER_ALT_SCREEN = '\u001b[?1049h'
const LEAVE_ALT_SCREEN = '\u001b[?1049l'
const HIDE_CURSOR = '\u001b[?25l'
const SHOW_CURSOR = '\u001b[?25h'
const CURSOR_HOME = '\u001b[H'
const CLEAR_BELOW = '\u001b[J'
const INVERSE_ON = '\u001b[7m'
const INVERSE_OFF = '\u001b[27m'
const RED_ON = '\u001b[31m'
const COLOR_OFF = '\u001b[39m'
const LOG_CHUNK_BYTES = 64 * 1024
const NEWLINE = 0x0a
const LAST_MESSAGE_FILE = 'last-message.md'

const ESC = '\u001b'
const CSI_PREFIX = `${ESC}[`
const SS3_PREFIX = `${ESC}O`
const CSI_FINAL_BYTE = /[@-~]/
const SEQUENCE_KEYS = new Map<string, Key>([[`${CSI_PREFIX}A`, 'up'], [`${CSI_PREFIX}B`, 'down'], [`${SS3_PREFIX}A`, 'up'], [`${SS3_PREFIX}B`, 'down']])
const CHARACTER_KEYS = new Map<string, Key>([
  ['\u0003', 'ctrl-c'], ['\r', 'enter'], ['\n', 'enter'], ['\t', 'tab'],
  ['j', 'down'], ['k', 'up'], ['h', 'h'], ['c', 'c'], ['l', 'l'], ['r', 'r'], ['?', '?'], ['q', 'q'],
])

export interface MonitorTerminal { size(): ScreenSize; write(text: string): void; keys(onKey: (key: Key) => void): () => void; onResize(handler: () => void): () => void; setRawMode(on: boolean): void }
export interface MonitorOptions { home: string; intervalMs: number; logLines: number; terminal: MonitorTerminal; now: () => Date; signal: AbortSignal }

interface StateReading { state: State | null; mtime: string | null; error: string | null }
interface LogTail { offset: number; lines: string[] }
type LogReading = LogTail | { unreadable: string }
interface DaemonLockReading { pid: number | null; error: string | null }
interface Sources { reading: StateReading; configSha256: string | null; disk: ConfigResult; daemon: DaemonLockReading; log: LogReading }

const NOT_READ: StateReading = { state: null, mtime: null, error: null }
const EMPTY_LOG: LogTail = { offset: 0, lines: [] }

export function monitorText(home: string, now: Date): string {
  const loaded = loadConfig(home, { ghAccounts: 'unchecked' })
  return printableLines(formatStatus({ state: loadState(home), config: loaded.ok ? loaded.config : null, daemonPid: liveDaemonPid(home), now: now.toISOString(), history: false }))
}

export function runMonitor(options: MonitorOptions): Promise<void> {
  const { home, intervalMs, logLines, terminal, now, signal } = options
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const cleanups: (() => void)[] = []
    let finished = false
    let sources: Sources | null = null
    let model: MonitorModel | null = null
    let ui: UiState | null = null
    let detail: DetailContent | null = null

    const restore = (): void => {
      attempt(() => terminal.setRawMode(false))
      attempt(() => terminal.write(SHOW_CURSOR))
      attempt(() => terminal.write(LEAVE_ALT_SCREEN))
      for (const cleanup of cleanups.splice(0)) attempt(cleanup)
    }
    const close = (): boolean => {
      if (finished) return false
      finished = true
      restore()
      return true
    }
    const quit = (): void => {
      if (close()) resolve()
    }
    const fail = (error: unknown): void => {
      if (!close()) return
      process.exitCode = 1
      reject(error)
    }
    const guarded = <Args extends unknown[]>(handler: (...args: Args) => void) => (...args: Args): void => {
      if (finished) return
      try {
        handler(...args)
      } catch (error) {
        fail(error)
      }
    }

    const refresh = (force: boolean): void => {
      sources = readSources(home, logLines, sources, force)
      const { state } = sources.reading
      const config = configViewOf(sources.disk, state?.configStatus ?? null)
      model = buildMonitorModel({ home, state, stateError: sources.reading.error, stateMtime: sources.reading.mtime, daemonPid: sources.daemon.pid, lockError: sources.daemon.error, config, now: now().toISOString() })
      ui ??= initialUi(model)
      detail = ui.view.kind === 'detail' ? detailContent(home, ui.view.ref, state, config) : null
      const size = terminal.size()
      ui = clampDetailScroll(ui, size, detail)
      terminal.write(frameText(renderScreen(model, ui, size, logLinesOf(sources.log), detail), size.height))
    }
    const onKey = (key: Key): void => {
      if (model === null || ui === null) return
      const result = reduceKey(ui, key, model, terminal.size(), detail)
      if (result.kind === 'quit') {
        quit()
        return
      }
      ui = result.ui
      refresh(result.kind === 'reload')
    }
    const start = (): void => {
      terminal.write(ENTER_ALT_SCREEN)
      terminal.write(HIDE_CURSOR)
      terminal.setRawMode(true)
      cleanups.push(terminal.keys(guarded(onKey)))
      cleanups.push(terminal.onResize(guarded(() => refresh(false))))
      refresh(true)
      const timer = setInterval(guarded(() => refresh(false)), intervalMs)
      cleanups.push(() => clearInterval(timer))
    }

    const onProcessError = (error: unknown): void => fail(error)
    process.on('uncaughtException', onProcessError)
    process.on('unhandledRejection', onProcessError)
    cleanups.push(() => process.off('uncaughtException', onProcessError), () => process.off('unhandledRejection', onProcessError))
    signal.addEventListener('abort', quit, { once: true })
    cleanups.push(() => signal.removeEventListener('abort', quit))
    guarded(start)()
  })
}

export function processTerminal(): MonitorTerminal {
  const { stdin, stdout } = process
  return {
    size: () => ({ width: stdout.columns ?? 0, height: stdout.rows ?? 0 }),
    write: (text) => {
      stdout.write(text)
    },
    keys(onKey) {
      const listener = (chunk: Buffer | string): void => {
        for (const key of keysOf(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))) onKey(key)
      }
      stdin.on('data', listener)
      stdin.resume()
      return () => {
        stdin.off('data', listener)
        stdin.pause()
      }
    },
    onResize(handler) {
      stdout.on('resize', handler)
      return () => {
        stdout.off('resize', handler)
      }
    },
    setRawMode(on) {
      stdin.setRawMode(on)
    },
  }
}

function keysOf(input: string): Key[] {
  const keys: Key[] = []
  let i = 0
  while (i < input.length) {
    const length = input[i] === ESC ? escapeSequenceLength(input, i) : 1
    const token = input.slice(i, i + length)
    const key = token === ESC ? 'escape' : (SEQUENCE_KEYS.get(token) ?? CHARACTER_KEYS.get(token))
    if (key !== undefined) keys.push(key)
    i += length
  }
  return keys
}

function escapeSequenceLength(input: string, start: number): number {
  if (start + 1 >= input.length) return 1
  if (input.startsWith(SS3_PREFIX, start)) return Math.min(3, input.length - start)
  if (!input.startsWith(CSI_PREFIX, start)) return 2
  let end = start + CSI_PREFIX.length
  while (end < input.length && !CSI_FINAL_BYTE.test(input[end])) end += 1
  return Math.min(end + 1, input.length) - start
}

function attempt(operation: () => void): void {
  try {
    operation()
  } catch {
    return
  }
}

function frameText(lines: readonly ScreenLine[], height: number): string {
  const body = lines.map((line) => {
    let text = line.text
    for (const { start, end } of [...line.redRanges ?? []].reverse()) text = `${text.slice(0, start)}${RED_ON}${text.slice(start, end)}${COLOR_OFF}${text.slice(end)}`
    return line.inverse ? `${INVERSE_ON}${text}${INVERSE_OFF}` : text
  }).join('\r\n')
  return `${CURSOR_HOME}${body}${lines.length < height ? `\r\n${CLEAR_BELOW}` : ''}`
}

function readSources(home: string, logLines: number, previous: Sources | null, force: boolean): Sources {
  const reading = readState(home, previous?.reading ?? NOT_READ, force)
  const configSha256 = configDigest(home)
  const reloadAll = previous === null || force
  const configStale = reloadAll || reading.mtime !== previous.reading.mtime || configSha256 !== previous.configSha256
  return {
    reading,
    configSha256,
    disk: configStale ? loadConfig(home, { ghAccounts: 'unchecked' }) : previous.disk,
    daemon: readDaemonLock(home, previous?.daemon.pid ?? null),
    log: readLogOrError(logPath(home), logLines, reloadAll ? null : previous.log),
  }
}

function readDaemonLock(home: string, previousPid: number | null): DaemonLockReading {
  try {
    return { pid: liveDaemonPid(home), error: null }
  } catch (error) {
    return { pid: previousPid, error: `cannot read ${basename(lockPath(home))}: ${(error as Error).message}` }
  }
}

function configDigest(home: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(configPath(home))).digest('hex')
  } catch {
    return null
  }
}

function readState(home: string, previous: StateReading, force: boolean): StateReading {
  const snapshot = readStateSnapshot(home)
  switch (snapshot.kind) {
    case 'ok':
      if (!force && snapshot.mtime === previous.mtime) return { ...previous, error: null }
      return { state: snapshot.state, mtime: snapshot.mtime, error: null }
    case 'error':
      return { ...previous, error: `cannot read state.json: ${snapshot.message}` }
    case 'missing':
      return previous.state === null ? NOT_READ : { ...previous, error: 'state.json not found' }
  }
}

function readLogOrError(path: string, logLines: number, previous: LogReading | null): LogReading {
  try {
    return readLog(path, logLines, previous === null || 'unreadable' in previous ? null : previous)
  } catch (error) {
    return { unreadable: `cannot read ${basename(path)}: ${(error as Error).message}` }
  }
}

function logLinesOf(log: LogReading): string[] {
  return 'unreadable' in log ? [log.unreadable] : log.lines
}

function readLog(path: string, logLines: number, previous: LogTail | null): LogTail {
  const fd = openIfExists(path)
  if (fd === null) return EMPTY_LOG
  try {
    const { size } = fstatSync(fd)
    if (previous === null || size < previous.offset || size - previous.offset > LOG_CHUNK_BYTES) return lastLines(fd, size, logLines)
    return appendedLines(fd, size, previous, logLines)
  } finally {
    closeSync(fd)
  }
}

function lastLines(fd: number, size: number, logLines: number): LogTail {
  const chunks: Buffer[] = []
  let start = size
  let newlines = 0
  while (start > 0 && newlines <= logLines) {
    const length = Math.min(LOG_CHUNK_BYTES, start)
    start -= length
    const chunk = readRange(fd, start, length)
    chunks.unshift(chunk)
    newlines += chunk.reduce((count, byte) => (byte === NEWLINE ? count + 1 : count), 0)
  }
  const text = Buffer.concat(chunks)
  const end = text.lastIndexOf(NEWLINE) + 1
  return { offset: start + end, lines: completeLines(text.subarray(0, end)).slice(-logLines) }
}

function appendedLines(fd: number, size: number, previous: LogTail, logLines: number): LogTail {
  if (size === previous.offset) return previous
  const added = readRange(fd, previous.offset, size - previous.offset)
  const end = added.lastIndexOf(NEWLINE) + 1
  if (end === 0) return previous
  return { offset: previous.offset + end, lines: [...previous.lines, ...completeLines(added.subarray(0, end))].slice(-logLines) }
}

function completeLines(newlineTerminated: Buffer): string[] {
  return newlineTerminated.toString('utf8').split('\n').slice(0, -1)
}

function readRange(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    const read = readSync(fd, buffer, filled, length - filled, position + filled)
    if (read === 0) break
    filled += read
  }
  return buffer.subarray(0, filled)
}

function openIfExists(path: string): number | null {
  try {
    return openSync(path, 'r')
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

function readRunFile(path: string): RunFile {
  try {
    return { kind: 'text', text: readFileSync(path, 'utf8') }
  } catch (error) {
    if (isMissing(error)) return { kind: 'missing' }
    return { kind: 'unreadable', message: (error as Error).message }
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function detailContent(home: string, ref: DetailRef, state: State | null, view: ConfigView): DetailContent | null {
  if (state === null) return null
  switch (ref.kind) {
    case 'run': {
      const run = state.runs.find((candidate) => candidate.id === ref.runId)
      if (run === undefined) return null
      return { kind: 'run', run, resultJson: readRunFile(resultPath(home, run.id)), lastMessage: readRunFile(join(runDir(home, run.id), LAST_MESSAGE_FILE)) }
    }
    case 'pending': {
      const pending = state.pending.find((candidate) => candidate.ruleKey === ref.ruleKey)
      if (pending === undefined) return null
      return { kind: 'pending', pending, rule: ruleOfPending(shownConfig(view), pending) }
    }
    case 'project': {
      const project = shownConfig(view)?.projects.find((candidate) => candidate.name === ref.name) ?? null
      const rule = project?.rules.find((candidate) => ruleKey(project.name, candidate) === ref.ruleKey)
      if (ref.ruleKey !== undefined && rule === undefined) return null
      const error = Object.hasOwn(state.projectErrors, ref.name) ? state.projectErrors[ref.name] : null
      return { kind: 'project', name: ref.name, project: project !== null && rule !== undefined ? { ...project, rules: [rule] } : project, error }
    }
  }
}
