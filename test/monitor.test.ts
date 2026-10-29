import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ruleKey } from '../src/config.ts'
import type { Key, ScreenSize } from '../src/monitor-layout.ts'
import { processTerminal, runMonitor } from '../src/monitor.ts'
import type { MonitorTerminal } from '../src/monitor.ts'
import { configPath, lockPath, logPath, promptsDir, resultPath, runDir, stateDir, statePath } from '../src/paths.ts'
import { saveState } from '../src/state.ts'
import type { Item, Pending, Rule, Run, State } from '../src/types.ts'

const launched = vi.hoisted(() => [] as string[])

vi.mock('node:child_process', () => {
  const refuse = (file: string): never => {
    launched.push(file)
    throw new Error(`${file} is not launched in tests`)
  }
  return {
    execFileSync: (file: string): string => {
      if (file !== 'git') return refuse(file)
      launched.push(file)
      return 'git@github.com:taylor/todos.git\n'
    },
    execFile: refuse,
    execSync: refuse,
    exec: refuse,
    spawn: refuse,
    spawnSync: refuse,
    fork: refuse,
  }
})

const NOW = '2026-10-23T01:00:00.000Z'
const INTERVAL_MS = 1000
const WIDE: ScreenSize = { width: 400, height: 40 }
const ESC = '\u001b'
const CURSOR_HOME = `${ESC}[H`
const ENTER_ALT_SCREEN = `${ESC}[?1049h`
const SHOW_CURSOR = `${ESC}[?25h`
const LEAVE_ALT_SCREEN = `${ESC}[?1049l`
const MONITOR_SEQUENCES = new RegExp(`${ESC}\\[(?:\\?1049[hl]|\\?25[hl]|H|J|7m|27m|31m|39m)`, 'g')
const NASTY = '\u001b[2J\u001b]0;x\u0007\u6539\u884c\n\u30bf\u30d6\t\u009b31m'

let originalTz: string | undefined
let originalExitCode: typeof process.exitCode
let clock: Date

beforeAll(() => {
  originalTz = process.env.TZ
  process.env.TZ = 'Asia/Tokyo'
})

afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
})

const dirs: string[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
  launched.length = 0
  clock = new Date(NOW)
  originalExitCode = process.exitCode
})

afterEach(() => {
  vi.useRealTimers()
  process.exitCode = originalExitCode
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function secondsBefore(seconds: number): string {
  return new Date(Date.parse(NOW) - seconds * 1000).toISOString()
}

const featureRule: Rule = { target: 'issue', label: 'impl', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 5, enabled: true, bootstrap: 'skip' }

function item(number: number, title = `Title ${number}`): Item {
  return { project: 'todos', repo: 'taylor/todos', target: 'issue', number, title, url: `https://github.com/taylor/todos/issues/${number}`, labels: ['impl'], author: { login: 'taylor', bot: false, association: 'OWNER' } }
}

function runWith(overrides: Partial<Run>): Run {
  return {
    id: '20261023-0917-3f9a1c',
    project: 'todos',
    target: { path: '/Users/me/git/todos', repo: 'taylor/todos', githubAccount: 'taylor' },
    rule: featureRule,
    kindName: 'Feature',
    items: [item(123)],
    createdAt: secondsBefore(30 * 60),
    startedAt: secondsBefore(24 * 60),
    phase: { kind: 'running', agent: 'working', agentSince: secondsBefore(60), closeAttempts: 0 },
    history: [],
    orca: null,
    notified: [],
    bypassLimit: false,
    manual: false,
    lastMessage: null,
    ...overrides,
  }
}

function stateWith(overrides: Partial<State>): State {
  return {
    version: 1, processed: [], pending: [], runs: [], watchedRules: [], lastPolledAt: {}, projectErrors: {}, orcaOutageSince: null, consumedRequests: [],
    configStatus: null,
    daemonInfo: { pid: process.pid, startedAt: secondsBefore(7200), lastCycleAt: secondsBefore(10), lastCycleError: null, orcaVersion: '1.4.217', cycleSeconds: 20 },
    ...overrides,
  }
}

function state001(runs: Run[]): Record<string, unknown> {
  const shaped: Record<string, unknown> = { ...stateWith({}), runs: runs.map((run) => (run.phase.kind === 'failed' ? { ...run, phase: { kind: 'failed', at: run.phase.at, reason: run.phase.reason } } : run)) }
  delete shaped.configStatus
  delete shaped.daemonInfo
  return shaped
}

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orcapod-monitor-'))
  dirs.push(dir)
  return dir
}

function homeWithConfig(): string {
  const home = tempHome()
  writeConfig(home, '')
  mkdirSync(promptsDir(home))
  writeFileSync(join(promptsDir(home), 'feature.claude.md'), 'Implement issue #{{item.number}} of {{repo}}.\n')
  return home
}

function writeConfig(home: string, trailer: string): void {
  writeFileSync(configPath(home), [
    'version: 1',
    'kinds:',
    '  - { id: feature, name: Feature }',
    'projects:',
    '  - name: todos',
    `    path: ${JSON.stringify(home)}`,
    '    githubAccount: unregistered-account',
    '    rules:',
    '      - { target: issue, label: impl, kind: feature, ai: claude, batch: each, delayMinutes: 5 }',
    trailer,
  ].join('\n'))
}

function setMtime(path: string, iso: string): void {
  utimesSync(path, new Date(iso), new Date(iso))
}

function writeState(home: string, state: State, mtime: string): void {
  saveState(home, state)
  setMtime(statePath(home), mtime)
}

function writeRawState(home: string, content: string, mtime: string): void {
  mkdirSync(stateDir(home), { recursive: true })
  writeFileSync(statePath(home), content)
  setMtime(statePath(home), mtime)
}

function markDaemonAlive(home: string): void {
  mkdirSync(stateDir(home), { recursive: true })
  writeFileSync(lockPath(home), `${process.pid}\n`)
}

function writeLog(home: string, content: string): void {
  mkdirSync(join(home, 'logs'), { recursive: true })
  writeFileSync(logPath(home), content)
}

function snapshot(home: string): Record<string, string> {
  const entries: Record<string, string> = { '.': `dir ${statSync(home).mtimeMs}` }
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const stat = statSync(path)
      entries[relative(home, path)] = stat.isDirectory() ? `dir ${stat.mtimeMs}` : `file ${stat.mtimeMs} ${readFileSync(path, 'base64')}`
      if (stat.isDirectory()) walk(path)
    }
  }
  walk(home)
  return entries
}

interface FakeTerminal extends MonitorTerminal {
  writes: string[]
  rawModes: boolean[]
  subscriptions(): number
  press(...keys: Key[]): void
  resizeTo(size: ScreenSize): void
}

interface FakeTerminalOptions { size?: ScreenSize; beforeWrite?: (text: string) => void; beforeRawMode?: (on: boolean) => void; beforeSize?: () => void }

function fakeTerminal(options: FakeTerminalOptions = {}): FakeTerminal {
  let size = options.size ?? WIDE
  const writes: string[] = []
  const rawModes: boolean[] = []
  const keyHandlers = new Set<(key: Key) => void>()
  const resizeHandlers = new Set<() => void>()
  return {
    writes,
    rawModes,
    size() {
      options.beforeSize?.()
      return size
    },
    write(text) {
      options.beforeWrite?.(text)
      writes.push(text)
    },
    keys(onKey) {
      keyHandlers.add(onKey)
      return () => {
        keyHandlers.delete(onKey)
      }
    },
    onResize(handler) {
      resizeHandlers.add(handler)
      return () => {
        resizeHandlers.delete(handler)
      }
    },
    setRawMode(on) {
      options.beforeRawMode?.(on)
      rawModes.push(on)
    },
    subscriptions: () => keyHandlers.size + resizeHandlers.size,
    press(...keys) {
      for (const key of keys) for (const handler of [...keyHandlers]) handler(key)
    },
    resizeTo(next) {
      size = next
      for (const handler of [...resizeHandlers]) handler()
    },
  }
}

function monitor(home: string, terminal: MonitorTerminal, options: { logLines?: number; signal?: AbortSignal } = {}): Promise<void> {
  return runMonitor({ home, intervalMs: INTERVAL_MS, logLines: options.logLines ?? 200, terminal, now: () => clock, signal: options.signal ?? new AbortController().signal })
}

function cycle(times = 1): void {
  vi.advanceTimersByTime(INTERVAL_MS * times)
}

function frames(terminal: FakeTerminal): string[] {
  return terminal.writes.filter((text) => text.startsWith(CURSOR_HOME))
}

function screen(terminal: FakeTerminal): string[] {
  const frame = frames(terminal).at(-1)
  if (frame === undefined) throw new Error('nothing drawn yet')
  return frame.replace(MONITOR_SEQUENCES, '').split('\r\n')
}

function screenText(terminal: FakeTerminal): string {
  return screen(terminal).join('\n')
}

function occurrences(texts: readonly string[], needle: string): number {
  return texts.filter((text) => text === needle).length
}

function exceptionListenerCounts(): number[] {
  return [process.listenerCount('uncaughtException'), process.listenerCount('unhandledRejection')]
}

type ProcessListener = (error: unknown) => void

function processListeners(event: 'uncaughtException' | 'unhandledRejection'): ProcessListener[] {
  return (event === 'uncaughtException' ? process.listeners('uncaughtException') : process.listeners('unhandledRejection')) as ProcessListener[]
}

function expectRestored(terminal: FakeTerminal): void {
  expect(terminal.writes.slice(-2)).toEqual([SHOW_CURSOR, LEAVE_ALT_SCREEN])
  expect(occurrences(terminal.writes, SHOW_CURSOR)).toBe(1)
  expect(occurrences(terminal.writes, LEAVE_ALT_SCREEN)).toBe(1)
  expect(terminal.subscriptions()).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
}

const failedRun = runWith({ id: '20261023-0917-7a44f0', phase: { kind: 'failed', at: secondsBefore(5 * 60), reason: 'AI reported failed: type error', tabClosed: false }, orca: { handle: 'h1', tabId: 't1', paneKey: 'p1', ptyId: 'y1' } })
const doneRun = runWith({ id: '20261023-0930-6d0e11', items: [item(40)], phase: { kind: 'done', at: secondsBefore(2 * 60), summary: 'approved with 2 comments', tabClosed: true } })

describe('runMonitor: does not write under the home (I1)', () => {
  it('A1: even after 3 loops in a home with neither state/ nor runs/, the file listing of the home is the same as before the run', async () => {
    const home = homeWithConfig()
    const before = snapshot(home)
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    cycle(3)
    terminal.press('q')
    await done
    expect(snapshot(home)).toEqual(before)
    expect(frames(terminal)).toHaveLength(4)
    expect(screenText(terminal)).toContain('daemon has never run (start it with orcapod start)')
  })

  it('A2: in a home with a 001-shaped state.json, log and result.json, nothing changes except the state.json written by the test, and the 001 state.json remains without being backfilled', async () => {
    const home = homeWithConfig()
    const original = JSON.stringify(state001([failedRun, doneRun]))
    writeRawState(home, original, secondsBefore(10))
    markDaemonAlive(home)
    writeLog(home, '2026-10-23 09:59:00 info poll todos: open 1, new 0\n')
    mkdirSync(runDir(home, failedRun.id), { recursive: true })
    writeFileSync(resultPath(home, failedRun.id), '{"status":"failed","summary":"type error","links":[]}\n')
    const before = snapshot(home)
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    cycle(2)
    expect(snapshot(home)).toEqual(before)
    expect(readFileSync(statePath(home), 'utf8')).toBe(original)
    writeState(home, stateWith({ runs: [doneRun] }), secondsBefore(5))
    const afterTestWrite = snapshot(home)
    cycle(2)
    terminal.press('q')
    await done
    expect(snapshot(home)).toEqual(afterTestWrite)
    expect(screenText(terminal)).not.toContain('7a44f0')
  })

  it('A3: when the terminal throws while drawing the 3rd loop, runMonitor ends with an exception and the home is the same as before the run', async () => {
    const home = homeWithConfig()
    writeState(home, stateWith({ runs: [failedRun] }), secondsBefore(10))
    const before = snapshot(home)
    let drawn = 0
    const terminal = fakeTerminal({
      beforeWrite: (text) => {
        if (text.startsWith(CURSOR_HOME) && ++drawn === 3) throw new Error('cannot write to the terminal')
      },
    })
    const done = monitor(home, terminal)
    cycle(2)
    await expect(done).rejects.toThrow('cannot write to the terminal')
    expect(snapshot(home)).toEqual(before)
    expectRestored(terminal)
  })

  it('A5: opening and closing history, configuration, help and detail in turn leaves the home the same as before the run', async () => {
    const home = homeWithConfig()
    writeRawState(home, JSON.stringify(state001([failedRun, doneRun])), secondsBefore(10))
    mkdirSync(runDir(home, doneRun.id), { recursive: true })
    writeFileSync(resultPath(home, doneRun.id), '{"status":"done","summary":"approved","links":[]}\n')
    const before = snapshot(home)
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    terminal.press('h', 'escape', 'c', 'escape', '?', 'escape', 'down', 'down', 'enter')
    expect(screenText(terminal)).toContain(`Detail run ${doneRun.id}`)
    expect(screenText(terminal)).toContain('  {"status":"done","summary":"approved","links":[]}')
    terminal.press('escape', 'q')
    await done
    expect(snapshot(home)).toEqual(before)
    expect(frames(terminal).map((frame) => frame.replace(MONITOR_SEQUENCES, '').split('\r\n')[1].trim().split(' ')[0])).toEqual(['┌', 'History', '┌', 'Settings', '┌', 'Keys', '┌', '┌', '┌', 'Detail', '┌'])
  })
})

describe('runMonitor: does not launch orca or gh (I2)', () => {
  it('A8: during the r reload, the config.yaml rewrite and the state.json rewrite, the only thing launched was git for deriving the repo', async () => {
    const home = homeWithConfig()
    writeState(home, stateWith({ runs: [failedRun] }), secondsBefore(30))
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    terminal.press('r')
    writeConfig(home, '# rewritten')
    setMtime(configPath(home), secondsBefore(20))
    cycle()
    writeState(home, stateWith({ runs: [doneRun] }), secondsBefore(10))
    cycle()
    terminal.press('q')
    await done
    expect(launched.length).toBeGreaterThanOrEqual(3)
    expect(new Set(launched)).toEqual(new Set(['git']))
  })

  it('A9: even with a state.json where Orca is stopped and daemonInfo is null, nothing other than git is launched and the heading shows "version unknown"', async () => {
    const home = homeWithConfig()
    writeState(home, stateWith({ runs: [failedRun], orcaOutageSince: secondsBefore(120), daemonInfo: null }), secondsBefore(10))
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    terminal.press('r')
    cycle(2)
    terminal.press('q')
    await done
    expect(new Set(launched)).toEqual(new Set(['git']))
    expect(screen(terminal)[0]).toContain('Orca version unknown (daemon is the 001 version)')
    expect(screen(terminal)[0]).toContain('Orca: unreachable since 10-23 09:58!')
  })
})

describe('runMonitor: drawing control sequences (I6)', () => {
  it('A27: even when all views are opened with external strings containing control characters, no control sequences other than those generated by the monitor remain in the entire output', async () => {
    const home = homeWithConfig()
    const pending: Pending = { ruleKey: ruleKey('todos', featureRule), project: 'todos', items: [item(7, NASTY)], fireAt: new Date(Date.parse(NOW) + 60_000).toISOString() }
    const failed = runWith({ ...failedRun, phase: { kind: 'failed', at: secondsBefore(300), reason: NASTY, tabClosed: false }, lastMessage: NASTY, items: [item(119, NASTY)] })
    const finished = runWith({ ...doneRun, phase: { kind: 'done', at: secondsBefore(120), summary: NASTY, tabClosed: true } })
    writeState(home, stateWith({ runs: [failed, finished], pending: [pending], projectErrors: { todos: { since: secondsBefore(60), message: NASTY } } }), secondsBefore(10))
    writeLog(home, `2026-10-23 09:59:00 error ${NASTY}\n`)
    mkdirSync(runDir(home, failed.id), { recursive: true })
    writeFileSync(resultPath(home, failed.id), NASTY)
    writeFileSync(join(runDir(home, failed.id), 'last-message.md'), NASTY)
    const terminal = fakeTerminal({ size: { width: 80, height: 24 } })
    const done = monitor(home, terminal)
    terminal.press('h', 'escape', 'c', 'escape', '?', 'escape', 'enter')
    expect(screenText(terminal)).toContain(`Detail run ${failed.id}`)
    terminal.press('escape', 'tab', 'enter')
    expect(screenText(terminal)).toContain('Detail pending todos')
    terminal.resizeTo({ width: 126, height: 40 })
    terminal.press('escape', 'tab', 'enter')
    expect(screenText(terminal)).toContain(`Detail run ${finished.id}`)
    terminal.press('escape', 'tab', 'enter')
    expect(screenText(terminal)).toContain('Detail project todos')
    terminal.press('escape')
    terminal.resizeTo({ width: 126, height: 40 })
    cycle()
    terminal.press('q')
    await done
    const residue = terminal.writes.join('').replace(MONITOR_SEQUENCES, '').replaceAll('\r\n', '')
    const controls = [...residue].filter((char) => {
      const code = char.codePointAt(0) ?? 0
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
    })
    expect(controls).toEqual([])
  })

  it('resizing redraws at the new size (below 80×24 only the single guidance line is shown and the rest is erased)', async () => {
    const home = homeWithConfig()
    writeState(home, stateWith({ runs: [failedRun] }), secondsBefore(10))
    const terminal = fakeTerminal({ size: { width: 126, height: 40 } })
    const done = monitor(home, terminal)
    expect(screen(terminal)).toHaveLength(40)
    terminal.resizeTo({ width: 80, height: 24 })
    expect(screen(terminal)).toHaveLength(24)
    expect(screen(terminal).every((line) => line.length <= 80)).toBe(true)
    terminal.resizeTo({ width: 79, height: 24 })
    expect(frames(terminal).at(-1)).toBe(`${CURSOR_HOME}Needs 80×24 or larger (now 79×24)${' '.repeat(46)}\r\n${ESC}[J`)
    terminal.press('q')
    await done
  })

  it('an inverted row is wrapped in ESC[7m and ESC[27m, rows are separated by \\r\\n, and no newline is written after the last row', async () => {
    const home = homeWithConfig()
    writeState(home, stateWith({ runs: [failedRun] }), secondsBefore(10))
    const terminal = fakeTerminal({ size: { width: 80, height: 24 } })
    const done = monitor(home, terminal)
    const frame = frames(terminal)[0]
    expect(frame.split('\r\n')).toHaveLength(24)
    expect(frame.endsWith('\r\n')).toBe(false)
    expect(frame.split('\r\n').filter((line) => line.startsWith(`${ESC}[7m`) && line.endsWith(`${ESC}[27m`)).map((line) => line.slice(0, 21))).toEqual([`${ESC}[7m│ ! 7a44f0  todos`])
    terminal.press('q')
    await done
  })
})

describe('runMonitor: terminal restoration and handler removal (I7)', () => {
  it.each([
    ['q', (terminal: FakeTerminal) => terminal.press('q')],
    ['ctrl-c', (terminal: FakeTerminal) => terminal.press('ctrl-c')],
    ['signal abort', (_terminal: FakeTerminal, controller: AbortController) => controller.abort()],
  ])('A28: ending with %s leaves raw mode, restores the cursor, exits the alternate screen, and removes the timer, key, resize and exception handlers', async (_name, end) => {
    const home = homeWithConfig()
    const listenersBefore = exceptionListenerCounts()
    let listenersWhenEntering: number[] = []
    const terminal = fakeTerminal({
      beforeWrite: (text) => {
        if (text === ENTER_ALT_SCREEN) listenersWhenEntering = exceptionListenerCounts()
      },
    })
    const controller = new AbortController()
    const done = monitor(home, terminal, { signal: controller.signal })
    cycle()
    expect(terminal.subscriptions()).toBe(2)
    expect(vi.getTimerCount()).toBe(1)
    end(terminal, controller)
    await done
    expect(terminal.writes.slice(0, 2)).toEqual([ENTER_ALT_SCREEN, `${ESC}[?25l`])
    expect(listenersWhenEntering).toEqual(listenersBefore.map((count) => count + 1))
    expect(terminal.rawModes).toEqual([true, false])
    expectRestored(terminal)
    expect(exceptionListenerCounts()).toEqual(listenersBefore)
  })

  it('A29: when drawing the 1st loop throws, restoration is written only once and runMonitor ends with an exception', async () => {
    const home = homeWithConfig()
    const terminal = fakeTerminal({
      beforeWrite: (text) => {
        if (text.startsWith(CURSOR_HOME)) throw new Error('cannot draw')
      },
    })
    await expect(monitor(home, terminal)).rejects.toThrow('cannot draw')
    expect(terminal.rawModes).toEqual([true, false])
    expectRestored(terminal)
  })

  it('A29: even when abort follows immediately after q, restoration is written only once', async () => {
    const home = homeWithConfig()
    const terminal = fakeTerminal()
    const controller = new AbortController()
    const done = monitor(home, terminal, { signal: controller.signal })
    terminal.press('q')
    controller.abort()
    await done
    expect(terminal.rawModes).toEqual([true, false])
    expectRestored(terminal)
  })

  it('A29: even when setRawMode(false) throws, the writes that show the cursor and exit the alternate screen are still made', async () => {
    const home = homeWithConfig()
    const terminal = fakeTerminal({
      beforeRawMode: (on) => {
        if (!on) throw new Error('cannot leave raw mode')
      },
    })
    const done = monitor(home, terminal)
    terminal.press('q')
    await done
    expect(terminal.rawModes).toEqual([true])
    expectRestored(terminal)
  })

  it('A30: when an exception occurs during key input handling, the terminal is restored, then the exit code is set to 1 and the number of exception handlers is returned to its pre-run count', async () => {
    const home = homeWithConfig()
    const listenersBefore = exceptionListenerCounts()
    let broken = false
    const terminal = fakeTerminal({
      beforeSize: () => {
        if (broken) throw new Error('cannot read the terminal size')
      },
    })
    const done = monitor(home, terminal)
    broken = true
    terminal.press('down')
    await expect(done).rejects.toThrow('cannot read the terminal size')
    expect(process.exitCode).toBe(1)
    expect(exceptionListenerCounts()).toEqual(listenersBefore)
    expect(terminal.rawModes).toEqual([true, false])
    expectRestored(terminal)
  })

  it.each([
    ['uncaughtException', new Error('uncaught exception')],
    ['unhandledRejection', new Error('unhandled Promise rejection')],
  ] as const)('A30: when the %s handler registered by the monitor is called, the terminal is restored, the exit code is set to 1, it ends with an exception, and the number of handlers is returned to its pre-run count', async (event, error) => {
    const home = homeWithConfig()
    const listenersBefore = processListeners(event)
    const countsBefore = exceptionListenerCounts()
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    const added = processListeners(event).filter((listener) => !listenersBefore.includes(listener))
    expect(added).toHaveLength(1)
    expect(terminal.subscriptions()).toBe(2)
    expect(process.exitCode).toBe(originalExitCode)
    added[0](error)
    await expect(done).rejects.toBe(error)
    expect(process.exitCode).toBe(1)
    expect(terminal.rawModes).toEqual([true, false])
    expectRestored(terminal)
    expect(exceptionListenerCounts()).toEqual(countsBefore)
    expect(processListeners(event)).toEqual(listenersBefore)
  })

  it('even when an exception occurs partway through startup (raw mode cannot be entered), the terminal is restored and then it ends with the exception', async () => {
    const home = homeWithConfig()
    const listenersBefore = exceptionListenerCounts()
    const terminal = fakeTerminal({
      beforeRawMode: (on) => {
        if (on) throw new Error('cannot enter raw mode')
      },
    })
    await expect(monitor(home, terminal)).rejects.toThrow('cannot enter raw mode')
    expect(terminal.writes).toEqual([ENTER_ALT_SCREEN, `${ESC}[?25l`, SHOW_CURSOR, LEAVE_ALT_SCREEN])
    expect(terminal.subscriptions()).toBe(0)
    expect(exceptionListenerCounts()).toEqual(listenersBefore)
  })

  it('if already aborted before start, it ends without writing anything to the terminal', async () => {
    const home = homeWithConfig()
    const controller = new AbortController()
    controller.abort()
    const terminal = fakeTerminal()
    await monitor(home, terminal, { signal: controller.signal })
    expect(terminal.writes).toEqual([])
    expect(terminal.rawModes).toEqual([])
  })
})

describe('runMonitor: reading state.json and freshness (I11)', () => {
  it('when the daemon stops, the next update turns red, and it returns to the normal color after restart', async () => {
    const home = homeWithConfig()
    markDaemonAlive(home)
    writeState(home, stateWith({}), secondsBefore(10))
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    expect(frames(terminal).at(-1)).not.toContain(`${ESC}[31mdaemon:`)
    rmSync(lockPath(home))
    cycle()
    expect(frames(terminal).at(-1)).toContain(`${ESC}[31mdaemon: stopped (updated 10s ago)!${ESC}[39m`)
    expect(screenText(terminal)).toContain('daemon: stopped')
    terminal.press('c')
    expect(frames(terminal).at(-1)).toContain(`${ESC}[31mdaemon: stopped`)
    markDaemonAlive(home)
    cycle()
    expect(screen(terminal)[0]).toContain('daemon: running')
    expect(frames(terminal).at(-1)).not.toContain(`${ESC}[31mdaemon:`)
    terminal.press('q')
    await done
  })

  it('while state.json is missing it shows "never ran", and the content is drawn on the loop after it appears', async () => {
    const home = homeWithConfig()
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    expect(screen(terminal)[0]).toContain('daemon: never started!')
    markDaemonAlive(home)
    writeState(home, stateWith({ runs: [failedRun] }), secondsBefore(10))
    cycle()
    expect(screen(terminal)[0]).toContain(`daemon: running pid ${process.pid} (updated 10s ago)`)
    expect(screenText(terminal)).toContain('7a44f0')
    terminal.press('q')
    await done
  })

  it('an update to state.json is redrawn on the next loop', async () => {
    const home = homeWithConfig()
    markDaemonAlive(home)
    writeState(home, stateWith({ runs: [failedRun] }), secondsBefore(10))
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    expect(screenText(terminal)).toContain('7a44f0')
    writeState(home, stateWith({ runs: [doneRun] }), secondsBefore(5))
    cycle()
    expect(screenText(terminal)).not.toContain('7a44f0')
    expect(screenText(terminal)).toContain('6d0e11')
    expect(screen(terminal)[0]).toContain('updated 5s ago')
    terminal.press('q')
    await done
  })

  it('A47: when a readable file is rewritten with broken content, the previous content and previous last-updated time keep being shown, and the heading says it cannot be read', async () => {
    const home = homeWithConfig()
    markDaemonAlive(home)
    writeState(home, stateWith({ runs: [failedRun] }), secondsBefore(10))
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    writeRawState(home, '{"version": 1, "runs": [', secondsBefore(5))
    cycle()
    expect(screen(terminal)[0]).toContain(`daemon: running pid ${process.pid} (updated 10s ago)  cannot read state.json: ${statePath(home)} is corrupt: `)
    expect(screenText(terminal)).toContain('7a44f0')
    writeState(home, stateWith({ runs: [doneRun] }), secondsBefore(3))
    cycle()
    expect(screen(terminal)[0]).not.toContain('cannot read state.json')
    expect(screen(terminal)[0]).toContain('updated 3s ago')
    terminal.press('q')
    await done
  })

  it('A48: when a readable file disappears, the previous content and previous last-updated time keep being shown, and the heading says "state.json not found"', async () => {
    const home = homeWithConfig()
    markDaemonAlive(home)
    writeState(home, stateWith({ runs: [failedRun] }), secondsBefore(10))
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    rmSync(statePath(home))
    cycle()
    expect(screen(terminal)[0]).toContain(`daemon: running pid ${process.pid} (updated 10s ago)  state.json not found!`)
    expect(screenText(terminal)).toContain('7a44f0')
    terminal.press('q')
    await done
  })

  it('A55: rewriting only the content while restoring the mtime keeps the previous load, and when the mtime advances the new content and last-updated time appear together', async () => {
    const home = homeWithConfig()
    markDaemonAlive(home)
    writeState(home, stateWith({ runs: [failedRun] }), secondsBefore(10))
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    const first = screen(terminal)
    writeState(home, stateWith({ runs: [doneRun] }), secondsBefore(10))
    cycle()
    expect(screen(terminal)).toEqual(first)
    setMtime(statePath(home), secondsBefore(4))
    cycle()
    expect(screenText(terminal)).toContain('6d0e11')
    expect(screenText(terminal)).not.toContain('7a44f0')
    expect(screen(terminal)[0]).toContain('updated 4s ago')
    terminal.press('q')
    await done
  })

  it('A56: for the same load, the heading is the same in the standard, history, configuration and detail views, and stays the same after reloading with r', async () => {
    const home = homeWithConfig()
    markDaemonAlive(home)
    writeState(home, stateWith({ runs: [failedRun, doneRun] }), secondsBefore(10))
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    const headers = (): string[] => {
      const seen = [screen(terminal)[0]]
      for (const keys of [['h'], ['escape', 'c'], ['escape', 'enter'], ['escape']] satisfies Key[][]) {
        terminal.press(...keys)
        seen.push(screen(terminal)[0])
      }
      return seen
    }
    const beforeReload = headers()
    expect(new Set(beforeReload).size).toBe(1)
    expect(beforeReload[0]).toContain('updated 10s ago')
    terminal.press('r')
    expect(headers()).toEqual(beforeReload)
    terminal.press('q')
    await done
  })

  it('A46: when state.json updates stop for 3 cycles (60 seconds), "possibly stopped" is shown even if the pid is alive', async () => {
    const home = homeWithConfig()
    markDaemonAlive(home)
    writeState(home, stateWith({ runs: [failedRun] }), secondsBefore(10))
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    expect(screen(terminal)[0]).toContain('daemon: running')
    clock = new Date(Date.parse(NOW) + 50_000)
    cycle()
    expect(screen(terminal)[0]).toContain(`daemon: possibly stopped pid ${process.pid} (updated 1m ago)!`)
    terminal.press('q')
    await done
  })
})

describe('runMonitor: reloading configuration (I8)', () => {
  it('opening the detail of each rule of the same project shows the detail of that rule, and a deleted rule is shown as not found', async () => {
    const home = homeWithConfig()
    const original = readFileSync(configPath(home), 'utf8')
    writeFileSync(join(promptsDir(home), 'feature.claude.md'), 'Process the items of {{repo}}.\n')
    writeFileSync(configPath(home), original.replace('    rules:', '    rules:\n      - { target: pr, label: dependencies, kind: feature, ai: claude, batch: together, delayMinutes: 30 }'))
    writeState(home, stateWith({}), secondsBefore(10))
    const terminal = fakeTerminal({ size: { width: 126, height: 40 } })
    const done = monitor(home, terminal)
    const rows = screen(terminal).filter((line) => line.startsWith('│   todos'))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('pr/dependencies')
    expect(rows[1]).toContain('issue/impl')
    terminal.press('enter')
    expect(screenText(terminal)).toContain('pr/dependencies → feature claude batch together delay 30m')
    expect(screenText(terminal)).not.toContain('issue/impl')
    terminal.press('escape', 'down', 'enter')
    expect(screenText(terminal)).toContain('issue/impl → feature claude batch each delay 5m')
    expect(screenText(terminal)).not.toContain('pr/dependencies')
    terminal.press('escape', 'up', 'enter')
    writeFileSync(configPath(home), original)
    cycle()
    expect(screenText(terminal)).toContain('target not found')
    terminal.press('escape', 'enter')
    expect(screenText(terminal)).toContain('issue/impl → feature')
    terminal.press('q')
    await done
  })

  it('A35: rewriting config.yaml makes it unapplied on the next loop, and it returns to running once the daemon writes a state.json with the new sha256', async () => {
    const home = homeWithConfig()
    markDaemonAlive(home)
    const sha256Of = (): string => createHash('sha256').update(readFileSync(configPath(home))).digest('hex')
    const loadedAt = secondsBefore(600)
    writeState(home, stateWith({ configStatus: { loadedAt, sha256: sha256Of(), error: null } }), secondsBefore(10))
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    expect(screen(terminal)[0]).toContain('config loaded 10-23 09:50 OK')
    writeConfig(home, '# rewritten')
    setMtime(configPath(home), secondsBefore(5))
    cycle()
    expect(screen(terminal)[0]).toContain('config not applied (daemon runs the config loaded 10-23 09:50)!')
    writeState(home, stateWith({ configStatus: { loadedAt: secondsBefore(2), sha256: sha256Of(), error: null } }), secondsBefore(2))
    cycle()
    expect(screen(terminal)[0]).toContain('config loaded 10-23 09:59 OK')
    terminal.press('q')
    await done
  })

  it('I8: even when the content of config.yaml (maxConcurrentPerProject 1 → 2) is changed while restoring its mtime, it becomes unapplied on the next loop with state.json unchanged, and the new on-disk content is shown', async () => {
    const home = homeWithConfig()
    markDaemonAlive(home)
    writeConfig(home, 'settings: { maxConcurrentPerProject: 1 }')
    const configMtime = secondsBefore(600)
    setMtime(configPath(home), configMtime)
    const sha256 = createHash('sha256').update(readFileSync(configPath(home))).digest('hex')
    writeState(home, stateWith({ configStatus: { loadedAt: secondsBefore(600), sha256, error: null } }), secondsBefore(10))
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    expect(screen(terminal)[0]).toContain('config loaded 10-23 09:50 OK')
    writeConfig(home, 'settings: { maxConcurrentPerProject: 2 }')
    setMtime(configPath(home), configMtime)
    cycle()
    expect(screen(terminal)[0]).toContain('config not applied (daemon runs the config loaded 10-23 09:50)!')
    terminal.press('c')
    expect(screen(terminal).map((line) => line.trimEnd()).join('\n')).toContain('Config on disk (not applied):\nsettings:\n  maxConcurrentPerProject: 2')
    terminal.press('q')
    await done
  })
})

describe('runMonitor: log tail', () => {
  function logArea(terminal: FakeTerminal): string[] {
    const lines = screen(terminal)
    const top = lines.findIndex((line) => line.startsWith('┌ Log '))
    return lines.slice(top + 1, lines.length - 2).map((line) => line.slice(1, -1).trimEnd()).filter((line) => line !== '')
  }

  it('keeps the last logLines lines, adds appended lines, does not show an unfinished line without a newline until the newline arrives, and rereads when the log shrinks', async () => {
    const home = homeWithConfig()
    writeLog(home, ['1', '2', '3', '4', '5'].map((n) => `2026-10-23 09:00:0${n} info line ${n}\n`).join(''))
    const terminal = fakeTerminal()
    const done = monitor(home, terminal, { logLines: 3 })
    expect(logArea(terminal)).toEqual(['09:00:03 info line 3', '09:00:04 info line 4', '09:00:05 info line 5'])
    appendFileSync(logPath(home), '2026-10-23 09:00:06 warn line 6\n2026-10-23 09:00:07 info partial')
    cycle()
    expect(logArea(terminal)).toEqual(['09:00:04 info line 4', '09:00:05 info line 5', '09:00:06 warn line 6'])
    appendFileSync(logPath(home), ' line\n  continued line\n')
    cycle()
    expect(logArea(terminal)).toEqual(['09:00:06 warn line 6', '09:00:07 info partial line', '           continued line'])
    truncateSync(logPath(home), 0)
    appendFileSync(logPath(home), '2026-10-23 10:00:00 info after shrinking\n')
    cycle()
    expect(logArea(terminal)).toEqual(['10:00:00 info after shrinking'])
    terminal.press('q')
    await done
  })

  it('even when the 64 KiB boundary splits a multi-byte character, backward reading does not corrupt the character; an append exceeding 64 KiB is reread from the end', async () => {
    const home = homeWithConfig()
    const longLine = `\u6f22${'x'.repeat(65533)}`
    writeLog(home, `2026-10-23 09:00:00 info previous line\n${longLine}\n`)
    const terminal = fakeTerminal()
    const done = monitor(home, terminal, { logLines: 1 })
    expect(logArea(terminal)).toHaveLength(1)
    expect(logArea(terminal)[0].startsWith(`         \u6f22xxx`)).toBe(true)
    appendFileSync(logPath(home), `${'2026-10-23 09:00:01 info bulk\n'.repeat(3000)}2026-10-23 09:00:02 info last\n`)
    cycle()
    expect(logArea(terminal)).toEqual(['09:00:02 info last'])
    terminal.press('q')
    await done
  })

  it('with no log it is empty, and the log is shown from the loop after it is created', async () => {
    const home = homeWithConfig()
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    expect(logArea(terminal)).toEqual([])
    writeLog(home, '2026-10-23 09:00:00 info first line\n')
    cycle()
    expect(logArea(terminal)).toEqual(['09:00:00 info first line'])
    terminal.press('q')
    await done
  })
})

describe('processTerminal: key translation on a real terminal', () => {
  it.each([
    ['j and k are as in vim: j is down, k is up', 'jjk', ['down', 'down', 'up']],
    ['arrow keys go in the same directions as j and k', '\u001b[B\u001b[A', ['down', 'up']],
    ['application-mode arrows (SS3) go in the same directions', '\u001bOB\u001bOA', ['down', 'up']],
    ['multiple keys arriving in one chunk are translated in order', '\u001b[Aj\r\n\th?q', ['up', 'down', 'enter', 'enter', 'tab', 'h', '?', 'q']],
    ['a lone ESC is escape and is distinguished from arrow sequences starting with ESC', '\u001b', ['escape']],
    ['a lone ESC after an arrow is also escape', '\u001b[B\u001b', ['down', 'escape']],
    ['Ctrl-C and c / l / r', '\u0003clr', ['ctrl-c', 'c', 'l', 'r']],
    ['F5, Shift-Tab, Alt+j, uppercase J and control characters are ignored', '\u001b[15~\u001b[Z\u001bjJ\u0001', []],
  ])('%s', async (_name, input, expected) => {
    const stdin = new PassThrough()
    const stdinGetter = vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin)
    const seen: Key[] = []
    const stop = processTerminal().keys((key) => seen.push(key))
    stdin.write(input)
    await new Promise((resolve) => setImmediate(resolve))
    stop()
    stdinGetter.mockRestore()
    expect(seen).toEqual(expected)
  })

  it('I7: after shutdown, the numbers of stdin data and keypress listeners return to their pre-start counts, and keys after shutdown are not delivered', async () => {
    const stdin = new PassThrough()
    const stdinGetter = vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin)
    const listenerCounts = (): number[] => [stdin.listenerCount('data'), stdin.listenerCount('keypress')]
    const before = listenerCounts()
    const seen: Key[] = []
    const stop = processTerminal().keys((key) => seen.push(key))
    const during = listenerCounts()
    stop()
    const after = listenerCounts()
    stdin.write('q')
    await new Promise((resolve) => setImmediate(resolve))
    stdinGetter.mockRestore()
    expect([before, during, after, seen]).toEqual([[0, 0], [1, 0], [0, 0], []])
  })
})

describe('runMonitor: detail view', () => {
  it('even after repeated down at the bottom of the detail, a single up moves back, and after enlarging the terminal it also moves back from the display position', async () => {
    const home = homeWithConfig()
    writeState(home, stateWith({ runs: [failedRun] }), secondsBefore(10))
    mkdirSync(runDir(home, failedRun.id), { recursive: true })
    writeFileSync(join(runDir(home, failedRun.id), 'last-message.md'), Array.from({ length: 40 }, (_, i) => `evidence${i + 1}`).join('\n'))
    const terminal = fakeTerminal({ size: { width: 80, height: 24 } })
    const done = monitor(home, terminal)
    try {
      terminal.press('enter', ...Array<Key>(120).fill('down'))
      expect(screen(terminal)[2].trimEnd()).toBe('  evidence20')
      terminal.press('up')
      expect(screen(terminal)[2].trimEnd()).toBe('  evidence19')
      terminal.resizeTo({ width: 126, height: 40 })
      expect(screen(terminal)[2].trimEnd()).toBe('  evidence4')
      terminal.press('up')
      expect(screen(terminal)[2].trimEnd()).toBe('  evidence3')
      terminal.resizeTo({ width: 80, height: 24 })
      expect(screen(terminal)[2].trimEnd()).toBe('  evidence3')
    } finally {
      terminal.press('q')
      await done
    }
  })

  it('when the detail file is shortened and re-enlarged, or the target run disappears and returns, the display does not revert to the old scroll position', async () => {
    const home = homeWithConfig()
    const state = stateWith({ runs: [failedRun] })
    writeState(home, state, secondsBefore(10))
    mkdirSync(runDir(home, failedRun.id), { recursive: true })
    const path = join(runDir(home, failedRun.id), 'last-message.md')
    const long = Array.from({ length: 40 }, (_, i) => `evidence${i + 1}`).join('\n')
    writeFileSync(path, long)
    const terminal = fakeTerminal({ size: { width: 80, height: 24 } })
    const done = monitor(home, terminal)
    try {
      terminal.press('enter')
      const first = screen(terminal)[2]
      terminal.press(...Array<Key>(120).fill('down'))
      expect(screen(terminal)[2].trimEnd()).toBe('  evidence20')
      writeFileSync(path, 'short body')
      cycle()
      expect(screen(terminal)[2]).toBe(first)
      writeFileSync(path, long)
      cycle()
      expect(screen(terminal)[2]).toBe(first)
      terminal.press(...Array<Key>(120).fill('down'))
      writeState(home, { ...state, runs: [] }, secondsBefore(5))
      cycle()
      expect(screen(terminal)[2].trimEnd()).toBe('target not found (removed from state)')
      writeState(home, state, NOW)
      cycle()
      expect(screen(terminal)[2]).toBe(first)
    } finally {
      terminal.press('q')
      await done
    }
  })

  it('the run detail shows the full text of runs/<id>/result.json and last-message.md, and shows "missing" when absent', async () => {
    const home = homeWithConfig()
    writeState(home, stateWith({ runs: [failedRun, doneRun] }), secondsBefore(10))
    mkdirSync(runDir(home, failedRun.id), { recursive: true })
    writeFileSync(resultPath(home, failedRun.id), '{\n  "status": "failed"\n}')
    writeFileSync(join(runDir(home, failedRun.id), 'last-message.md'), 'please decide the approach')
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    terminal.press('enter')
    const failedDetail = screen(terminal).map((line) => line.trimEnd())
    expect(failedDetail).toEqual(expect.arrayContaining(['result.json:', '  {', '    "status": "failed"', '  }', 'last-message.md:', '  please decide the approach']))
    terminal.press('escape', 'down', 'down', 'enter')
    const doneDetail = screen(terminal).map((line) => line.trimEnd())
    expect(doneDetail).toEqual(expect.arrayContaining([` Detail run ${doneRun.id}`, 'result.json: missing', 'last-message.md: missing']))
    terminal.press('q')
    await done
  })

  it('even when result.json is a directory and last-message.md is unreadable by permission, it does not exit and keeps showing a "cannot read <file name>: <message>" row in the detail', async () => {
    const home = homeWithConfig()
    writeState(home, stateWith({ runs: [failedRun] }), secondsBefore(10))
    mkdirSync(resultPath(home, failedRun.id), { recursive: true })
    const lastMessagePath = join(runDir(home, failedRun.id), 'last-message.md')
    writeFileSync(lastMessagePath, 'please decide the approach', { mode: 0o000 })
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    terminal.press('enter')
    cycle(2)
    const expected = ['cannot read result.json: EISDIR: illegal operation on a directory, read', `cannot read last-message.md: EACCES: permission denied, open '${lastMessagePath}'`]
    expect(screen(terminal).map((line) => line.trimEnd()).filter((line) => /^(cannot read )?(result\.json|last-message\.md)/.test(line))).toEqual(expected)
    terminal.press('q')
    await expect(done).resolves.toBeUndefined()
  })
})

describe('runMonitor: daemon.lock cannot be read', () => {
  it('even when the daemon.lock location is a directory, it does not exit, the heading says it cannot be read, and that message disappears on the loop after it becomes readable', async () => {
    const home = homeWithConfig()
    writeState(home, stateWith({ runs: [failedRun] }), secondsBefore(10))
    mkdirSync(lockPath(home), { recursive: true })
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    expect(screen(terminal)[0]).toContain('cannot read daemon.lock: EISDIR: illegal operation on a directory, read')
    cycle()
    expect(screen(terminal)[0]).toContain('cannot read daemon.lock: EISDIR: illegal operation on a directory, read')
    rmSync(lockPath(home), { recursive: true })
    markDaemonAlive(home)
    cycle()
    expect(screen(terminal)[0]).not.toContain('cannot read daemon.lock')
    expect(screen(terminal)[0]).toContain(`daemon: running pid ${process.pid}`)
    terminal.press('q')
    await expect(done).resolves.toBeUndefined()
  })
})

describe('runMonitor: log cannot be read', () => {
  it('even when the log location is a directory, it does not exit, the log area says it cannot be read, and the tail is shown from the loop after it becomes readable', async () => {
    const home = homeWithConfig()
    mkdirSync(logPath(home), { recursive: true })
    const terminal = fakeTerminal()
    const done = monitor(home, terminal)
    expect(screenText(terminal)).toContain('│         cannot read orcapod.log: EISDIR: illegal operation on a directory, read')
    rmSync(logPath(home), { recursive: true })
    writeFileSync(logPath(home), '2026-10-23 09:00:00 info readable\n')
    cycle()
    expect(screenText(terminal)).not.toContain('cannot read orcapod.log')
    expect(screenText(terminal)).toContain('│09:00:00 info readable')
    terminal.press('q')
    await expect(done).resolves.toBeUndefined()
  })
})
