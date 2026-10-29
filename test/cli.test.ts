import { execFile, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openIncident, proposalRevision } from '../src/incident-contract.ts'
import { monitorText } from '../src/monitor.ts'
import { configPath, lockPath, logPath, promptsDir, stateDir, statePath } from '../src/paths.ts'
import { loadState, readRequests, saveState } from '../src/state.ts'
import { cliProcess, collect, execCalls, publicCli, setupCliHome, STOPPED_WARNING, writeFixture } from './helpers/cli-process.ts'
import { JAPANESE } from './helpers/japanese.ts'
import type { Run, State } from '../src/types.ts'

const CLI = join(import.meta.dirname, '..', 'bin', 'orcapod.js')
const DAEMON_STOPPED_WARNING = 'warning: the daemon is not running (orcapod start). It processes the request once started\n'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orcapod-cli-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

async function orcapod(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return orcapodIn({ env: { ...process.env, ORCAPOD_HOME: home } }, ...args)
}

async function orcapodIn(options: { env: NodeJS.ProcessEnv; cwd?: string }, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], options)
    return { code: 0, stdout, stderr }
  } catch (error) {
    const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string }
    return { code, stdout, stderr }
  }
}

function run(id: string): Run {
  return {
    id,
    project: 'todos',
    target: { path: '/Users/me/git/todos', repo: 'taylor/todos', githubAccount: 'taylor' },
    rule: { target: 'issue', label: 'impl', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 5, enabled: true, bootstrap: 'skip' },
    kindName: 'Feature',
    items: [],
    createdAt: '2026-10-23T00:17:00.000Z',
    startedAt: null,
    phase: { kind: 'failed', at: '2026-10-23T00:20:00.000Z', reason: 'launch failed: x', tabClosed: false },
    history: [],
    orca: null,
    notified: [],
    bypassLimit: false,
    manual: false,
    lastMessage: null,
  }
}

const state: State = {
  version: 1,
  processed: [],
  pending: [],
  runs: [run('20261023-0917-3f9a1c'), run('20261023-0918-77ab12'), run('20261024-1000-77ab12')],
  watchedRules: [],
  lastPolledAt: {},
  projectErrors: {},
  orcaOutageSince: null,
  consumedRequests: [],
  configStatus: null,
  daemonInfo: null,
}

describe('stopping the daemon', () => {
  it('even with repeated make stop, the real daemon completes its cycle, saves state, and releases the lock', async () => {
    mkdirSync(promptsDir(home), { recursive: true })
    writeFileSync(join(promptsDir(home), 'feature.claude.md'), '{{items}}\n')
    writeFileSync(configPath(home), JSON.stringify({
      version: 1, settings: { notify: { desktop: false } },
      kinds: [{ id: 'feature', name: 'Feature' }],
      projects: [{ name: 'todos', path: home, repo: 'alice/todos', githubAccount: 'alice', rules: [
        { target: 'issue', label: 'impl', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 5 },
      ] }],
    }))
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { start } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'daemon.ts'))}
      let finish
      process.on('message', (message) => {
        if (message === 'finish') finish([])
        else process.send('alive')
      })
      await start({
        home: process.argv[1], now: () => new Date(), ghAccounts: async () => ['alice'], notify: async () => {},
        github: () => new Promise((resolve) => { finish = resolve; process.send('cycling') }),
        orca: {
          status: async () => ({ running: true, version: 'test' }),
          observe: async () => ({ agents: new Map(), terminals: new Map(), hooks: null }),
        },
      })
    `, home], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    const exited = once(child, 'exit')
    try {
      expect(await once(child, 'message')).toEqual(['cycling', undefined])
      for (let i = 0; i < 2; i++) {
        const { stdout, stderr } = await promisify(execFile)('make', ['stop', `NODE=${process.execPath}`], {
          cwd: join(import.meta.dirname, '..'), env: { ...process.env, ORCAPOD_HOME: home },
        })
        expect(stderr).toBe('')
        expect(stdout).toContain(`asked the daemon to stop (pid ${child.pid})`)
      }
      const alive = Promise.race([once(child, 'message'), exited])
      child.send('probe')
      expect((await alive)[0]).toBe('alive')
      expect(existsSync(lockPath(home))).toBe(true)
      expect(existsSync(statePath(home))).toBe(false)
      expect(readRequests(home)).toEqual([])
      child.send('finish')
      expect(await exited).toEqual([0, null])
      expect(loadState(home).daemonInfo?.pid).toBe(child.pid)
      expect(loadState(home).lastPolledAt.todos).toBeDefined()
      expect(existsSync(lockPath(home))).toBe(false)
      expect(await orcapod('stop')).toEqual({ code: 0, stdout: 'daemon is not running\n', stderr: '' })
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    }
  })

  it.each([null, '2147483647\n', '0\n', '-1\n', 'garbage\n', '2147483648\n'])('a lock for a daemon that is not started, stale, or invalid (%s) exits normally and does not rewrite the file', async (lock) => {
    if (lock !== null) {
      mkdirSync(stateDir(home), { recursive: true })
      writeFileSync(lockPath(home), lock)
    }
    expect(await orcapod('stop')).toEqual({ code: 0, stdout: 'daemon is not running\n', stderr: '' })
    expect(readRequests(home)).toEqual([])
    if (lock === null) expect(existsSync(stateDir(home))).toBe(false)
    else expect(readFileSync(lockPath(home), 'utf8')).toBe(lock)
  })

  it.each([['--unknown'], ['one', 'two']])('does not issue a stop request for invalid arguments %j', async (...args) => {
    mkdirSync(stateDir(home), { recursive: true })
    writeFileSync(lockPath(home), `${process.pid}\n`)
    const result = await orcapod('stop', ...args)
    expect(result).toEqual({ code: 1, stdout: '', stderr: args[0] === '--unknown'
      ? `orcapod stop: Unknown option '--unknown'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- "--unknown"\nUsage: orcapod stop [<run.id>]\n`
      : 'give exactly one run id (see orcapod status). Usage: orcapod stop <run.id>\n' })
    expect(readRequests(home)).toEqual([])
  })
})

describe('orcapod stop / rerun id resolution', () => {
  it('resolves by the last 6 characters, places a request with the full id, and warns if the daemon is not running', async () => {
    saveState(home, state)
    const result = await orcapod('stop', '3f9a1c')
    const requests = readRequests(home)
    expect(requests.map((read) => ('request' in read ? read.request : read.error))).toEqual([{ type: 'stop', runId: '20261023-0917-3f9a1c' }])
    expect(result).toEqual({ code: 0, stdout: `request placed: ${requests[0].file} (stop 20261023-0917-3f9a1c)\n`, stderr: DAEMON_STOPPED_WARNING })
  })

  it('resolves by the full id and does not warn if the daemon is alive', async () => {
    saveState(home, state)
    writeFileSync(lockPath(home), `${process.pid}\n`)
    const result = await orcapod('rerun', '20261023-0918-77ab12')
    const requests = readRequests(home)
    expect(requests.map((read) => ('request' in read ? read.request : read.error))).toEqual([{ type: 'rerun', runId: '20261023-0918-77ab12' }])
    expect(result).toEqual({ code: 0, stdout: `request placed: ${requests[0].file} (rerun 20261023-0918-77ab12)\n`, stderr: '' })
  })

  it.each([
    ['ambiguous last 6 characters', '77ab12', '77ab12 matches multiple runs: 20261023-0918-77ab12, 20261024-1000-77ab12 (give the full id)\n'],
    ['no match', 'ffffff', 'no run matches ffffff (give the last 6 characters of the id or the full id; see orcapod status --history)\n'],
  ])('%s is an error and places no request', async (_name, query, stderr) => {
    saveState(home, state)
    expect(await orcapod('stop', query)).toEqual({ code: 1, stdout: '', stderr })
    expect(readRequests(home)).toEqual([])
  })

  it('an error when the id is missing', async () => {
    expect(await orcapod('rerun')).toEqual({ code: 1, stdout: '', stderr: 'give exactly one run id (see orcapod status). Usage: orcapod rerun <run.id>\n' })
  })
})

describe('orcapod status --json / logs', () => {
  it.each([[], ['--history']])('status %j neutralizes OSC and CSI, while --json and the saved state keep the original string', async (...args) => {
    const attack = '\u001b]52;c;UE9DTw==\u0007\u001b]0;title\u0007\u001b[2J\u009b31m\r\t\ud800X\udc00\n\u65e5\u672c\u8a9e😀'
    const safe = ' ]52;c;UE9DTw==  ]0;title  [2J 31m   X \n\u65e5\u672c\u8a9e😀'
    const unsafeState: State = {
      ...state,
      runs: [{ ...run('20261023-0917-3f9a1c'), kindName: `Kind${attack}`, phase: { kind: 'done', at: '2026-10-23T00:20:00.000Z', summary: `Summary${attack}`, tabClosed: true } }],
      projectErrors: { todos: { since: '2026-10-23T00:10:00.000Z', message: `Watch${attack}` } },
    }
    saveState(home, unsafeState)
    const before = readFileSync(statePath(home), 'utf8')
    const bin = join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const result = await orcapodIn({ env: { ...process.env, ORCAPOD_HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}` } }, 'status', ...args)
    expect([result.code, result.stderr]).toEqual([0, ''])
    for (const text of ['Kind', 'Summary', 'Watch']) expect(result.stdout).toContain(`${text}${safe}`)
    expect(result.stdout).not.toContain('\u001b')
    expect(result.stdout).not.toContain('\u009b')
    const json = await orcapod('status', '--json', ...args)
    expect([json.code, JSON.parse(json.stdout), json.stderr]).toEqual([0, unsafeState, ''])
    expect(readFileSync(statePath(home), 'utf8')).toBe(before)
  })

  it('status --json prints state.json as it is', async () => {
    saveState(home, state)
    const result = await orcapod('status', '--json', '--history')
    expect([result.code, JSON.parse(result.stdout), result.stderr]).toEqual([0, state, ''])
  })

  it('A49: status --json prints a 001-shape state.json in its completed form (configStatus and daemonInfo are null, tabClosed of a failed run is false)', async () => {
    const phase001 = { kind: 'failed', at: '2026-10-23T00:20:00.000Z', reason: 'launch failed: x' }
    const runs = state.runs.map((r) => ({ ...r, phase: phase001 }))
    mkdirSync(stateDir(home), { recursive: true })
    writeFileSync(statePath(home), JSON.stringify({ version: 1, processed: [], pending: [], runs, watchedRules: [], lastPolledAt: {}, projectErrors: {}, orcaOutageSince: null, consumedRequests: [] }))
    const result = await orcapod('status', '--json')
    expect([result.code, JSON.parse(result.stdout), result.stderr]).toEqual([0, state, ''])
  })

  describe('A50: a state.json with a malformed body exits with code 1 and a corrupted-file message, not a TypeError, in both status and monitor', () => {
    const phaseNull = { ...run('20261023-0917-3f9a1c'), phase: null }
    it.each([
      ['runs: [{}]', [{}], 'runs[0].id is not a string'],
      ['runs: [null]', [null], 'runs[0] is not an object'],
      ['run with phase: null', [phaseNull], 'runs[0].phase is not an object'],
    ])('%s', async (_name, runs, reason) => {
      mkdirSync(stateDir(home), { recursive: true })
      writeFileSync(statePath(home), JSON.stringify({ version: 1, processed: [], pending: [], runs, watchedRules: [], lastPolledAt: {}, projectErrors: {}, orcaOutageSince: null, consumedRequests: [] }))
      for (const args of [['status', '--json'], ['monitor']]) {
        const result = await orcapod(...args)
        expect(result).toEqual({ code: 1, stdout: '', stderr: `orcapod ${args[0]}: ${statePath(home)} is corrupt: ${reason}\n` })
      }
    })
  })

  it('logs prints the tail of the log and is an error when there is no log', async () => {
    expect(await orcapod('logs')).toEqual({ code: 1, stdout: '', stderr: `no log: ${logPath(home)}\n` })
    mkdirSync(join(home, 'logs'))
    writeFileSync(logPath(home), '2026-10-23 09:12:00 info a\n2026-10-23 09:12:20 info b\n')
    expect(await orcapod('logs')).toEqual({ code: 0, stdout: '2026-10-23 09:12:00 info a\n2026-10-23 09:12:20 info b\n', stderr: '' })
  })
})

describe('orcapod monitor', () => {
  const MONITOR_USAGE = 'Usage: orcapod monitor [--interval <seconds>] [--log-lines <N>]\n'

  function writeConfig(dir: string, project: { path: string; repo?: string; githubAccount: string }): void {
    writeFileSync(configPath(dir), [
      'version: 1',
      'kinds:',
      '  - { id: feature, name: Feature }',
      'projects:',
      '  - name: todos',
      `    path: ${JSON.stringify(project.path)}`,
      ...(project.repo === undefined ? [] : [`    repo: ${project.repo}`]),
      `    githubAccount: ${project.githubAccount}`,
      '    rules:',
      '      - { target: issue, label: impl, kind: feature, ai: claude, batch: each, delayMinutes: 5 }',
      '',
    ].join('\n'))
    mkdirSync(promptsDir(dir), { recursive: true })
    writeFileSync(join(promptsDir(dir), 'feature.claude.md'), 'Implement issue #{{item.number}} of {{repo}}.\n')
  }

  function snapshot(root: string): Record<string, string> {
    const entries: Record<string, string> = { '.': `dir ${statSync(root).mtimeMs}` }
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name)
        const stat = statSync(path)
        entries[relative(root, path)] = stat.isDirectory() ? `dir ${stat.mtimeMs}` : `file ${stat.mtimeMs} ${readFileSync(path, 'base64')}`
        if (stat.isDirectory()) walk(path)
      }
    }
    walk(root)
    return entries
  }

  it('A31: when stdout is a pipe, does not enter the alternate screen, prints the same body as monitorText once, and exits 0', async () => {
    saveState(home, state)
    const result = await orcapod('monitor')
    expect(result).toEqual({ code: 0, stdout: `${monitorText(home, new Date())}\n`, stderr: '' })
    expect(result.stdout).not.toContain('\u001b')
  })

  it('I6: when stdout is a pipe, the body replaces control characters and lone surrogates in the monitor error body, summary, and reason with spaces, and keeps the newlines that separate lines', async () => {
    const failedWithNasty: Run = { ...run('20261023-0917-3f9a1c'), phase: { kind: 'failed', at: '2026-10-23T00:20:00.000Z', reason: 'launch failed:\u009b31m\r\u007fx', tabClosed: false } }
    const doneWithNasty: Run = { ...run('20261023-0918-77ab12'), phase: { kind: 'done', at: '2026-10-23T00:30:00.000Z', summary: 'Done\t\ud800\u0000', tabClosed: true } }
    saveState(home, { ...state, runs: [failedWithNasty, doneWithNasty], projectErrors: { todos: { since: '2026-10-23T00:10:00.000Z', message: '\u001b]52;c;UE9DTw==\u0007' } } })
    const result = await orcapod('monitor')
    const lines = result.stdout.split('\n')
    expect([result.code, result.stderr]).toEqual([0, ''])
    const isControlOrLoneSurrogate = (char: string): boolean => {
      const code = char.codePointAt(0) ?? 0
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff)
    }
    expect(lines.filter((line) => [...line].some(isControlOrLoneSurrogate))).toEqual([])
    expect(lines.filter((line) => line.includes('watch error'))).toEqual([expect.stringContaining('watch error:  ]52;c;UE9DTw==  (')])
    expect(lines.filter((line) => line.includes('launch failed'))).toEqual([expect.stringContaining('(launch failed: 31m  x)')])
    expect(lines.filter((line) => line.includes('Done'))).toEqual([expect.stringContaining('"Done   "')])
  })

  it('A6: reads a configuration with a githubAccount missing from gh and a project that omits repo without launching gh, and exits 0', async () => {
    const repo = join(home, 'repo')
    execFileSync('git', ['init', '-q', repo])
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:taylor/todos.git'])
    writeConfig(home, { path: repo, githubAccount: 'unregistered-account' })
    saveState(home, state)
    const bin = join(home, 'bin')
    const mark = join(home, 'gh-was-called')
    mkdirSync(bin)
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$@" >> '${mark}'\n`, { mode: 0o755 })
    const env = { ...process.env, ORCAPOD_HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}` }

    const result = await orcapodIn({ env }, 'monitor')
    expect([result.code, result.stderr, existsSync(mark)]).toEqual([0, '', false])
    expect(result.stdout).toContain('  todos (unregistered-account, not polled yet)\n')
    expect(result.stdout).not.toContain('config: unreadable')

    await orcapodIn({ env }, 'status')
    expect(existsSync(mark)).toBe(true)
  })

  it.each([['0.2'], ['60']])('A4: returns 0 with a relative ORCAPOD_HOME and --interval %s, and does not change anything under the home', async (interval) => {
    const relativeHome = join(home, 'rel')
    mkdirSync(relativeHome)
    writeConfig(relativeHome, { path: '/Users/me/git/todos', repo: 'taylor/todos', githubAccount: 'taylor' })
    saveState(relativeHome, state)
    const before = snapshot(relativeHome)
    const result = await orcapodIn({ env: { ...process.env, ORCAPOD_HOME: './rel' }, cwd: home }, 'monitor', '--interval', interval)
    expect([result.code, result.stderr]).toEqual([0, ''])
    expect(result.stdout).toContain('Watching:\n  todos (taylor, not polled yet)\n')
    expect(snapshot(relativeHome)).toEqual(before)
  })

  it.each([['1'], ['10000']])('--log-lines %s is within range, so 0', async (logLines) => {
    expect(await orcapod('monitor', '--log-lines', logLines)).toEqual({ code: 0, stdout: `${monitorText(home, new Date())}\n`, stderr: '' })
  })

  it.each([
    ['--interval', '0.1', '--interval: must be a number of seconds from 0.2 to 60 (got: 0.1)'],
    ['--interval', '60.5', '--interval: must be a number of seconds from 0.2 to 60 (got: 60.5)'],
    ['--interval', 'abc', '--interval: must be a number of seconds from 0.2 to 60 (got: abc)'],
    ['--log-lines', '0', '--log-lines: must be an integer from 1 to 10000 (got: 0)'],
    ['--log-lines', '10001', '--log-lines: must be an integer from 1 to 10000 (got: 10001)'],
    ['--log-lines', '1.5', '--log-lines: must be an integer from 1 to 10000 (got: 1.5)'],
  ])('%s %s is out of range, so prints usage and returns 1', async (option, value, message) => {
    expect(await orcapod('monitor', option, value)).toEqual({ code: 1, stdout: '', stderr: `${message}\n${MONITOR_USAGE}` })
  })

  it('A7: modules reached by following imports from src/monitor*.ts do not include orca, github, daemon, notify, log, tick, or doctor', () => {
    const srcDir = join(import.meta.dirname, '..', 'src')
    const reached = new Set<string>()
    const pending = ['monitor.ts', 'monitor-model.ts', 'monitor-layout.ts']
    while (pending.length > 0) {
      const file = pending.pop()
      if (file === undefined || reached.has(file)) continue
      reached.add(file)
      for (const match of readFileSync(join(srcDir, file), 'utf8').matchAll(/from '\.\/([\w-]+\.ts)'/g)) pending.push(match[1])
    }
    expect([...reached].sort()).toEqual(['config.ts', 'incident-contract.ts', 'incident-prompt.ts', 'launch.ts', 'monitor-layout.ts', 'monitor-model.ts', 'monitor.ts', 'paths.ts', 'prompt.ts', 'records.ts', 'state.ts', 'status.ts', 'terminal-text.ts', 'types.ts'])
  })

  it('A7 (additional): the reached modules have neither dynamic imports nor side-effect-only imports, and only config.ts reads node:child_process, which launches processes', () => {
    const srcDir = join(import.meta.dirname, '..', 'src')
    const reached = ['config.ts', 'incident-contract.ts', 'incident-prompt.ts', 'launch.ts', 'monitor-layout.ts', 'monitor-model.ts', 'monitor.ts', 'paths.ts', 'prompt.ts', 'records.ts', 'state.ts', 'status.ts', 'terminal-text.ts', 'types.ts']
    const sources = new Map(reached.map((file) => [file, readFileSync(join(srcDir, file), 'utf8')]))
    expect([...sources].filter(([, text]) => /\bimport\s*\(/.test(text) || /^import\s+['"]/m.test(text)).map(([file]) => file)).toEqual([])
    expect([...sources].filter(([, text]) => /node:child_process|from 'child_process'|require\(/.test(text)).map(([file]) => file)).toEqual(['config.ts'])
  })
})


describe('incident recovery CLI', () => {
  it('handles the detail of an existing failure and an investigation-only request, and does not re-run the original processing', async () => {
    saveState(home, state)
    const shown = await orcapod('incident', '3f9a1c')
    expect([shown.code, shown.stderr]).toEqual([0, ''])
    expect(shown.stdout).toContain('launch failed: x')
    expect(shown.stdout).toContain('orcapod investigate')
    const requested = await orcapod('investigate', '3f9a1c')
    expect(requested).toEqual({ code: 0, stdout: `investigation request placed: ${readRequests(home)[0].file} (the original work is not rerun)\n`, stderr: DAEMON_STOPPED_WARNING })
    expect(readRequests(home).map((read) => 'request' in read ? read.request : read)).toEqual([{ type: 'investigate', runId: state.runs[0].id, evidence: '' }])
    expect(loadState(home)).toEqual(state)
  })

  it('rejects a stale approval and a re-investigation without additional evidence, without creating a request file', async () => {
    const changed = structuredClone(state)
    changed.runs[0].incident = { ...openIncident('2026-10-24T00:00:00.000Z'), status: 'blocked', tasks: ['earlier'] }
    saveState(home, changed)
    expect(await orcapod('approve', '3f9a1c', '0'.repeat(64))).toEqual({ code: 1, stdout: '', stderr: 'orcapod approve: does not match the revision awaiting approval\n' })
    expect(await orcapod('investigate', '3f9a1c')).toEqual({ code: 1, stdout: '', stderr: 'orcapod investigate: a new investigation needs added evidence different from the previous one\n' })
    expect(readRequests(home)).toEqual([])
  })

  it('shows the approval target in full and requests only approval of the new revision', async () => {
    const changed = structuredClone(state)
    const body = { summary: 'align operations', cause: 'documents disagree', evidence: ['checked the code'], changes: [], validation: ['unit tests passed'], actions: ['align the documents and verify'], risks: ['database not verified'] }
    const revision = proposalRevision(body)
    changed.runs[0].incident = { ...openIncident('2026-10-24T00:00:00.000Z'), status: 'awaiting_approval', proposal: { body, revision } }
    saveState(home, changed)
    const bin = join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'gh'), `#!/bin/sh
cat <<'JSON'
Logged in to github.com account taylor
JSON
`, { mode: 0o755 })
    mkdirSync(join(home, 'prompts'))
    writeFileSync(join(home, 'prompts', 'feature.claude.md'), '{{items}}')
    writeFileSync(configPath(home), JSON.stringify({ version: 1, settings: {}, kinds: [{ id: 'feature', name: 'Development' }], projects: [{ name: 'todos', path: '/Users/me/git/todos', repo: 'taylor/todos', githubAccount: 'taylor', rules: [{ target: 'issue', label: 'impl', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 0 }] }] }))
    const detail = await orcapod('incident', '3f9a1c')
    expect([detail.code, detail.stderr]).toEqual([0, ''])
    for (const value of [body.cause, body.actions[0], body.validation[0], body.risks[0], revision]) expect(detail.stdout).toContain(value)
    const result = await orcapodIn({ env: { ...process.env, ORCAPOD_HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}` } }, 'approve', '3f9a1c', revision)
    expect(result).toEqual({ code: 0, stdout: `approval request placed: ${readRequests(home)[0].file} (${revision})\n`, stderr: DAEMON_STOPPED_WARNING })
    expect(readRequests(home).map((read) => 'request' in read ? read.request : read)).toEqual([{ type: 'approve', runId: changed.runs[0].id, revision }])
  })
})

describe('G1: public CLI normal path, external dependencies, arguments, and output', () => {
  it('validate prints the configuration count to stdout and exits 0', async () => {
    setupCliHome(home)
    expect(await publicCli(home, 'validate')).toEqual({ code: 0, signal: null, stdout: 'OK: projects 1 / rules 1 / prompts 2\n', stderr: '' })
  })

  it.each(['config', 'path', 'gh'] as const)('validate prints the invalid %s to stderr and leaves neither normal output nor a request', async (failure) => {
    const { config, fixture, projectPath } = setupCliHome(home)
    const errors = {
      config: 'version: 1 is required (got: 2)\n',
      path: `projects[0].path: "${projectPath}" does not exist\n`,
      gh: 'orcapod validate: cannot run gh auth status: isolated gh unavailable\n',
    }
    if (failure === 'config') writeFileSync(configPath(home), JSON.stringify({ ...config, version: 2 }))
    if (failure === 'path') rmSync(projectPath, { recursive: true })
    if (failure === 'gh') writeFixture(home, { ...fixture, ghError: true })
    expect(await publicCli(home, 'validate')).toEqual({ code: 1, signal: null, stdout: '', stderr: errors[failure] })
    expect(readRequests(home)).toEqual([])
  })

  it.each([false, true])('doctor --probe=%s diagnoses with the real bin and returns 0 when there is no NG, even with WARN', async (probe) => {
    const { projectPath } = setupCliHome(home)
    const result = await publicCli(home, 'doctor', ...(probe ? ['--probe'] : []))
    expect([result.code, result.signal, result.stderr]).toEqual([0, null, ''])
    expect(result.stdout).toContain('OK   Orca: running (version test-cli)\n')
    expect(result.stdout).toContain('OK   config: projects 1 / rules 1 / prompts 2\n')
    expect(result.stdout).toContain('WARN daemon: not running')
    expect(result.stdout).not.toContain('NG ')
    expect(result.stdout.trim().split('\n').every((line) => /^(OK {2}|WARN) /.test(line))).toBe(true)
    const terminalCalls = execCalls(home).filter((call) => call.args[0] === 'terminal')
    expect(terminalCalls.map((call) => call.args)).toEqual(probe ? [
      ['terminal', 'create', '--worktree', `path:${projectPath}`, '--title', 'orcapod probe', '--command', "bash -c 'echo ORCAPOD_PROBE_OK; sleep 2'; exit", '--json'],
      ['terminal', 'wait', '--terminal', 'term-test', '--for', 'exit', '--timeout-ms', '20000', '--json'],
      ['terminal', 'close', '--terminal', 'term-test', '--json'],
    ] : [])
    if (probe) for (const stage of ['create', 'wait', 'close']) expect(result.stdout).toContain(`OK   probe ${stage}:`)
  })

  it('doctor prints the diagnosis to stdout and returns 1 when there is an NG', async () => {
    const { fixture } = setupCliHome(home)
    writeFixture(home, { ...fixture, orcaStopped: true })
    const result = await publicCli(home, 'doctor')
    expect([result.code, result.signal, result.stderr]).toEqual([1, null, ''])
    expect(result.stdout).toContain('NG   Orca: not running (open Orca)\n')
  })

  it.each([
    { target: 'issue', ai: undefined, now: false },
    { target: 'pr', ai: 'codex', now: true },
  ] as const)('run places exactly one complete request for $target / $ai / now=$now', async ({ target, ai, now }) => {
    const { fixture } = setupCliHome(home)
    if (target === 'pr') writeFixture(home, { ...fixture, item: { ...fixture.item, pull_request: {} } })
    const result = await publicCli(home, 'run', '--project', 'todos', `--${target}`, '7', '--kind', 'feature', ...(ai ? ['--ai', ai] : []), ...(now ? ['--now'] : []))
    const requests = readRequests(home)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ request: {
      type: 'run', project: 'todos', kind: 'feature', ai: ai ?? 'claude', now,
      item: { project: 'todos', repo: 'alice/todos', target, number: 7, title: 'Work from the public CLI', url: fixture.item.html_url, labels: ['impl'], author: { login: 'alice', bot: false, association: 'OWNER' } },
    } })
    expect(result).toEqual({ code: 0, signal: null, stdout: `request placed: ${requests[0].file} (${target} #7 Work from the public CLI / feature / ${ai ?? 'claude'}${now ? ' / --now' : ''})\n`, stderr: STOPPED_WARNING })
    expect(existsSync(statePath(home))).toBe(false)
  })

  it.each([
    [[], '--project is required'],
    [['--project', 'todos'], 'exactly one of --issue or --pr is required'],
    [['--project', 'todos', '--issue', '7', '--pr', '8'], 'exactly one of --issue or --pr is required'],
    ...['0', '1.5', 'abc'].map((n) => [['--project', 'todos', '--issue', n, '--kind', 'feature'], `--issue: must be a positive integer (got: ${n})`]),
    [['--project', 'todos', '--issue=-1', '--kind', 'feature'], '--issue: must be a positive integer (got: -1)'],
    [['--project', 'todos', '--pr', '0', '--kind', 'feature'], '--pr: must be a positive integer (got: 0)'],
    [['--project', 'todos', '--issue', '7'], '--kind is required'],
    [['--project', 'todos', '--issue', '7', '--kind', 'feature', '--ai', 'other'], '--ai: must be claude or codex (got: other)'],
    [['--project', 'missing', '--issue', '7', '--kind', 'feature'], '--project: missing is not in the config (choices: todos)'],
    [['--project', 'todos', '--issue', '7', '--kind', 'missing'], '--kind: missing is not in kinds (choices: feature)'],
  ] as [string[], string][])('rejects the run arguments %j and places no request', async (args, error) => {
    setupCliHome(home)
    expect(await publicCli(home, 'run', ...args)).toEqual({ code: 1, signal: null, stdout: '', stderr: `${error}\n` })
    expect(readRequests(home)).toEqual([])
  })

  it.each(['inference', 'prompt', 'gh', 'api'] as const)('run reports a %s failure explicitly and places no request', async (failure) => {
    const { config, fixture } = setupCliHome(home)
    if (failure === 'inference') {
      config.projects[0].rules[0].enabled = false
      writeFileSync(configPath(home), JSON.stringify(config))
    }
    if (failure === 'prompt') rmSync(join(home, 'prompts', 'feature.codex.md'))
    if (failure === 'gh') writeFixture(home, { ...fixture, ghError: true })
    if (failure === 'api') writeFixture(home, { ...fixture, apiError: true })
    const errors = {
      api: 'orcapod run: gh api repos/alice/todos/issues/7 failed: API denied\n',
      inference: '--ai: required because todos has no enabled rule for kind feature\n',
      prompt: 'prompts/feature.codex.md is missing\n',
      gh: 'orcapod run: cannot run gh auth status: isolated gh unavailable\n',
    }
    expect(await publicCli(home, 'run', '--project', 'todos', '--issue', '7', '--kind', 'feature', ...(failure === 'prompt' ? ['--ai', 'codex'] : []))).toEqual({ code: 1, signal: null, stdout: '', stderr: errors[failure] })
    expect(readRequests(home)).toEqual([])
  })

  it.each([true, false])('start initializes through the public entry point and returns %s over the startup IPC', async (valid) => {
    const { config } = setupCliHome(home)
    if (!valid) writeFileSync(configPath(home), JSON.stringify({ ...config, version: 2 }))
    const child = cliProcess(home, ['start'], true)
    const finished = collect(child)
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
    try {
      expect(await Promise.race([once(child, 'message').then(([message]: unknown[]) => message), finished.then(() => { throw new Error('exited without a startup IPC message') })])).toEqual({ type: 'startup', ok: valid })
      if (valid) {
        expect(readFileSync(lockPath(home), 'utf8').trim()).toBe(String(child.pid))
        expect(execCalls(home).some((call) => call.args[0] === 'status')).toBe(true)
      }
      // Failure stays in the real 60s startup wait; cancel only after its IPC verdict.
      // The natural exit(0) convention is protected by start's G7 DI test.
      child.kill('SIGTERM')
      const result = await finished
      expect([result.code, result.signal, result.stderr]).toEqual([valid ? 0 : null, valid ? null : 'SIGTERM', valid ? '' : 'version: 1 is required (got: 2)\n'])
      if (valid) expect(result.stdout).toContain('daemon started')
      else expect(result.stdout).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} info notify orcapod: config broken, cannot start: version: 1 is required \(got: 2\)\n$/)
      expect(existsSync(lockPath(home))).toBe(false)
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await finished
    }
  })

  it.each([{ args: [] }, { args: ['unknown-command'] }])('arguments $args print the usage of all commands to stderr and return 1', async ({ args }) => {
    setupCliHome(home)
    const result = await publicCli(home, ...args)
    expect([result.code, result.signal, result.stdout]).toEqual([1, null, ''])
    expect(result.stderr.startsWith('Usage:\n')).toBe(true)
    for (const command of ['validate', 'doctor', 'status', 'up', 'start', 'run', 'stop', 'rerun', 'incident', 'investigate', 'approve', 'logs', 'monitor']) expect(result.stderr).toContain(`  orcapod ${command}`)
  })

  it('status warns about a gh read failure and continues showing the saved state', async () => {
    const { fixture } = setupCliHome(home)
    saveState(home, state)
    writeFixture(home, { ...fixture, ghError: true })
    const result = await publicCli(home, 'status')
    expect([result.code, result.signal, result.stderr]).toEqual([0, null, 'warning: cannot read the gh accounts, so the config is not checked (cannot run gh auth status: isolated gh unavailable)\n'])
    expect(result.stdout).toContain('3f9a1c "Feature ×0" failed')
    expect(loadState(home)).toEqual(state)
  })

  it('logs prints only the last 200 lines to stdout', async () => {
    setupCliHome(home)
    mkdirSync(join(home, 'logs'))
    const lines = Array.from({ length: 205 }, (_, i) => `line ${i + 1}\n`)
    writeFileSync(logPath(home), lines.join(''))
    expect(await publicCli(home, 'logs')).toEqual({ code: 0, signal: null, stdout: lines.slice(-200).join(''), stderr: '' })
  })

  it.each(['-f', '--follow'])('logs %s streams appended output to stdout', async (option) => {
    setupCliHome(home)
    mkdirSync(join(home, 'logs'))
    writeFileSync(logPath(home), 'before\n')
    const child = cliProcess(home, ['logs', option])
    let output = ''
    child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString() })
    const finished = collect(child)
    try {
      await expect.poll(() => output).toBe('before\n')
      appendFileSync(logPath(home), 'after\n')
      await expect.poll(() => output, { timeout: 4000 }).toBe('before\nafter\n')
      const tails = execCalls(home).filter((call) => call.type === 'tail')
      expect(tails).toHaveLength(1)
      process.kill(tails[0].pid, 'SIGTERM')
      expect(await finished).toEqual({ code: 1, signal: null, stdout: 'before\nafter\n', stderr: '' })
    } finally {
      for (const call of execCalls(home).filter((call) => call.type === 'tail')) {
        try { process.kill(call.pid, 'SIGKILL') } catch { /* Already exited. */ }
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await finished
    }
  })

  it.each(['error', 'exit'] as const)('logs conveys the tail %s in its exit result', async (failure) => {
    const { fixture } = setupCliHome(home)
    mkdirSync(join(home, 'logs'))
    writeFileSync(logPath(home), 'unused\n')
    writeFixture(home, { ...fixture, ...(failure === 'error' ? { tailError: true } : { tailCode: 23 }) })
    expect(await publicCli(home, 'logs')).toEqual({ code: failure === 'error' ? 1 : 23, signal: null, stdout: '', stderr: failure === 'error' ? 'orcapod logs: isolated tail unavailable\n' : '' })
    expect(execCalls(home).filter((call) => call.type === 'spawn').map((call) => [call.file, call.args])).toEqual([['tail', ['-n', '200', logPath(home)]]])
  })
})

describe('G1: incident recovery command rejection and additional evidence', () => {
  it('rerun rejects a recovery child', async () => {
    saveState(home, { ...state, runs: [{ ...state.runs[0], recovery: { sourceRunId: state.runs[1].id, stage: 'prepare', evidence: [] } }] })
    expect(await orcapod('rerun', '3f9a1c')).toEqual({ code: 1, stdout: '', stderr: 'an incident run cannot be rerun. Check the original run with orcapod incident\n' })
    expect(readRequests(home)).toEqual([])
  })

  it('investigate trims evidence that differs from the previous one and requests it as a single item', async () => {
    const changed = { ...state, runs: [{ ...state.runs[0], incident: { ...openIncident('2026-10-24T00:00:00.000Z'), status: 'blocked' as const, tasks: ['previous'], evidence: ['old evidence'] } }] }
    saveState(home, changed)
    const result = await orcapod('investigate', '3f9a1c', '--evidence', '  new evidence  ')
    const requests = readRequests(home)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ request: { type: 'investigate', runId: changed.runs[0].id, evidence: 'new evidence' } })
    expect(result).toEqual({ code: 0, stdout: `investigation request placed: ${requests[0].file} (the original work is not rerun)\n`, stderr: DAEMON_STOPPED_WARNING })
    expect(loadState(home)).toEqual(changed)
  })

  it.each([
    { status: 'blocked', evidence: ' same evidence ', error: 'a new investigation needs added evidence different from the previous one' },
    { status: 'investigating', evidence: 'new evidence', error: 'cannot start an investigation for an incident that is under investigation, being applied or resolved' },
    { status: 'resolved', evidence: 'new evidence', error: 'cannot start an investigation for an incident that is under investigation, being applied or resolved' },
    { status: 'blocked', evidence: 'x'.repeat(16001), error: 'added evidence must be 16000 characters or fewer' },
  ] as const)('investigate rejects $status / $error and creates no request', async ({ status, evidence, error }) => {
    const changed = { ...state, runs: [{ ...state.runs[0], incident: { ...openIncident('2026-10-24T00:00:00.000Z'), status, tasks: ['previous'], evidence: ['same evidence'] } }] }
    saveState(home, changed)
    expect(await orcapod('investigate', '3f9a1c', '--evidence', evidence)).toEqual({ code: 1, stdout: '', stderr: `orcapod investigate: ${error}\n` })
    expect(readRequests(home)).toEqual([])
    expect(loadState(home)).toEqual(changed)
  })

  it('approve rejects a proposal for a repository that is not allowed and creates no request', async () => {
    const { projectPath } = setupCliHome(home)
    const outside = join(home, 'outside')
    execFileSync('git', ['init', '-q', outside])
    const body = { summary: 'fix', cause: 'cause', evidence: ['evidence'], changes: [{ path: outside, head: 'a'.repeat(40), summary: 'not allowed' }], validation: ['checked'], actions: ['apply'], risks: [] }
    const revision = proposalRevision(body)
    const changed = { ...state, runs: [{ ...state.runs[0], target: { ...state.runs[0].target, path: projectPath }, incident: { ...openIncident('2026-10-24T00:00:00.000Z'), status: 'awaiting_approval' as const, proposal: { body, revision } } }] }
    saveState(home, changed)
    expect(await publicCli(home, 'approve', '3f9a1c', revision)).toEqual({ code: 1, signal: null, stdout: '', stderr: `orcapod approve: change target is not an allowed repository: ${outside}\n` })
    expect(readRequests(home)).toEqual([])
    expect(loadState(home)).toEqual(changed)
  })
})

describe('SPEC-ENGLISH-OUTPUT-001 conditions: the CLI says nothing in Japanese and keeps its exit codes', () => {
  const AT = '2026-10-23T00:20:00.000Z'

  function japaneseLines(output: { stdout: string; stderr: string }): string[] {
    return `${output.stdout}${output.stderr}`.split('\n').filter((line) => JAPANESE.test(line))
  }

  function everyStatusState(): State {
    const base = run('20261023-0900-aaaaaa')
    const proposalBody = { summary: 'align operations', cause: 'documents disagree', evidence: ['checked the code'], changes: [], validation: ['unit tests passed'], actions: ['align the documents and verify'], risks: ['database not verified'] }
    const failedWith = (id: string, incident: Run['incident'], reason = 'AI reported failed: tests do not pass'): Run => ({ ...base, id, phase: { kind: 'failed', at: AT, reason, tabClosed: false }, ...(incident === undefined ? {} : { incident }) })
    const open = openIncident(AT)
    return {
      ...state,
      pending: [{ ruleKey: '["todos","issue","impl"]', project: 'todos', items: [{ project: 'todos', repo: 'taylor/todos', target: 'issue', number: 9, title: 'Pending work', url: 'https://github.com/taylor/todos/issues/9', labels: ['impl'], author: { login: 'taylor', bot: false, association: 'OWNER' } }], fireAt: '2026-10-23T01:00:00.000Z' }],
      runs: [
        { ...base, id: '20261023-0901-a00001', startedAt: null, orca: null, phase: { kind: 'queued', since: AT }, history: [] },
        { ...base, id: '20261023-0902-a00002', startedAt: null, orca: null, phase: { kind: 'launching', since: AT }, history: [] },
        { ...base, id: '20261023-0903-a00003', phase: { kind: 'running', agent: 'working', agentSince: AT, closeAttempts: 0 }, startedAt: AT },
        { ...base, id: '20261023-0904-a00004', phase: { kind: 'done', at: AT, summary: 'merged', tabClosed: true } },
        { ...base, id: '20261023-0905-a00005', phase: { kind: 'aborted', at: AT, reason: 'pane and tab disappeared' } },
        failedWith('20261023-0906-a00006', undefined, 'launch failed: no_pane_key'),
        failedWith('20261023-0907-a00007', open),
        failedWith('20261023-0908-a00008', { ...open, status: 'investigating', tasks: ['20261023-0950-b00001'] }),
        failedWith('20261023-0909-a00009', { ...open, status: 'awaiting_approval', proposal: { body: proposalBody, revision: proposalRevision(proposalBody) } }),
        failedWith('20261023-0910-a0000a', { ...open, status: 'applying', tasks: ['20261023-0950-b00001'], proposal: { body: proposalBody, revision: proposalRevision(proposalBody) }, approvedRevision: proposalRevision(proposalBody) }),
        failedWith('20261023-0911-a0000b', { ...open, status: 'blocked', reason: 'investigation limit of 3 reached; review the evidence and proposals' }),
        failedWith('20261023-0912-a0000c', { ...open, status: 'resolved' }),
      ],
    }
  }

  it('A1-2: usage, validate with a broken config, status and status --history over every phase and incident status, and incident <id> for every incident status print no Japanese', async () => {
    const outputs: { stdout: string; stderr: string }[] = []
    setupCliHome(home)
    outputs.push(await publicCli(home))
    outputs.push(await publicCli(home, 'status'))
    saveState(home, everyStatusState())
    const status = await publicCli(home, 'status')
    const history = await publicCli(home, 'status', '--history')
    outputs.push(status, history)
    expect([status.code, status.stderr, history.code, history.stderr]).toEqual([0, '', 0, ''])
    expect(status.stdout.split('\n').length).toBeGreaterThan(10)
    for (const id of ['a00001', 'a00002', 'a00003', 'a00004', 'a00005', 'a00006', 'a00007', 'a00008', 'a00009', 'a0000a', 'a0000b', 'a0000c']) expect(history.stdout).toContain(id)
    const incidentCodes: (number | null)[] = []
    for (const suffix of ['a00006', 'a00007', 'a00008', 'a00009', 'a0000a', 'a0000b', 'a0000c', 'a00004']) {
      const shown = await publicCli(home, 'incident', suffix)
      incidentCodes.push(shown.code)
      outputs.push(shown)
    }
    expect(incidentCodes).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    const { config } = setupCliHome(home)
    writeFileSync(configPath(home), JSON.stringify({ ...config, version: 2 }))
    outputs.push(await publicCli(home, 'validate'))
    expect(outputs.length).toBeGreaterThanOrEqual(13)
    expect(outputs.flatMap(japaneseLines)).toEqual([])
  })

  it('A1-2: doctor with Orca stopped, with gh missing, and with a broken config prints no Japanese and exits 1', async () => {
    const { config, fixture } = setupCliHome(home)
    const outputs: { code: number | null; stdout: string; stderr: string }[] = []
    writeFixture(home, { ...fixture, orcaStopped: true })
    outputs.push(await publicCli(home, 'doctor'))
    writeFixture(home, { ...fixture, ghError: true })
    outputs.push(await publicCli(home, 'doctor'))
    writeFixture(home, fixture)
    writeFileSync(configPath(home), JSON.stringify({ ...config, version: 2 }))
    outputs.push(await publicCli(home, 'doctor'))
    expect(outputs.map(({ code }) => code)).toEqual([1, 1, 1])
    expect(outputs.flatMap(japaneseLines)).toEqual([])
  })

  it('A9-1: with an NG the exit code is 1 and every line of doctor starts with OK, NG or WARN in its fixed 4-column form', async () => {
    const { fixture } = setupCliHome(home)
    for (const broken of [{ orcaStopped: true }, { ghError: true }]) {
      writeFixture(home, { ...fixture, ...broken })
      const result = await publicCli(home, 'doctor')
      const lines = result.stdout.trim().split('\n')
      expect([result.code, result.stderr]).toEqual([1, ''])
      expect(lines.some((line) => line.startsWith('NG   '))).toBe(true)
      expect(lines.filter((line) => !/^(OK {2}|NG {2}|WARN) /.test(line))).toEqual([])
    }
  })

  it.each([[[]], [['unknown-command']], [['rerun']]])('A3-4: argument errors %j exit 1 and write the usage to stderr, nothing to stdout', async (args) => {
    setupCliHome(home)
    const result = await publicCli(home, ...args)
    expect([result.code, result.stdout]).toEqual([1, ''])
    expect(result.stderr).toMatch(/Usage:/)
  })

  it('A3-4: validate with a broken config exits 1, validate with a good config exits 0', async () => {
    const { config } = setupCliHome(home)
    expect((await publicCli(home, 'validate')).code).toBe(0)
    writeFileSync(configPath(home), JSON.stringify({ ...config, version: 2 }))
    expect((await publicCli(home, 'validate')).code).toBe(1)
  })
})
