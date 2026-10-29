import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareRun } from '../src/launch.ts'
import { configPath, orcapodHome, lockPath, logPath, panePath, promptsDir, requestsDir, resultPath, runsDir, statePath } from '../src/paths.ts'
import { loadState, newRunId } from '../src/state.ts'
import type { Config, Run } from '../src/types.ts'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CLI = join(REPOSITORY_ROOT, 'bin', 'orcapod.js')
const RUN_ID = '20261023-0917-3f9a1c'

let savedHome: string | undefined
let savedCwd: string
let scratch: string

beforeEach(() => {
  savedHome = process.env.ORCAPOD_HOME
  savedCwd = process.cwd()
  delete process.env.ORCAPOD_HOME
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'orcapod-home-')))
})

afterEach(() => {
  process.chdir(savedCwd)
  if (savedHome === undefined) delete process.env.ORCAPOD_HOME
  else process.env.ORCAPOD_HOME = savedHome
  rmSync(scratch, { recursive: true, force: true })
})

function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ORCAPOD_HOME
  return { ...env, ...overrides }
}

describe('P1: the default home is the repository root and does not depend on cwd', () => {
  it('H1: when ORCAPOD_HOME is unset it is the repository root and does not contain ~/.orcapod', () => {
    const home = orcapodHome()
    expect(home).toBe(REPOSITORY_ROOT)
    expect(home.startsWith(join(homedir(), '.orcapod'))).toBe(false)
    expect(home).not.toContain(`${join(homedir(), '.orcapod')}`)
  })

  it('H2: the same value as H1 even when ORCAPOD_HOME is an empty string', () => {
    process.env.ORCAPOD_HOME = ''
    expect(orcapodHome()).toBe(REPOSITORY_ROOT)
  })

  it('H3: the same value as H1 even when cwd is changed to tmpdir', () => {
    process.chdir(scratch)
    expect(orcapodHome()).toBe(REPOSITORY_ROOT)
  })

  function throwawayRepository(): { repo: string; cli: string; cwd: string } {
    const repo = join(scratch, 'repo')
    cpSync(join(REPOSITORY_ROOT, 'bin'), join(repo, 'bin'), { recursive: true })
    cpSync(join(REPOSITORY_ROOT, 'src'), join(repo, 'src'), { recursive: true })
    copyFileSync(join(REPOSITORY_ROOT, 'package.json'), join(repo, 'package.json'))
    symlinkSync(join(REPOSITORY_ROOT, 'node_modules'), join(repo, 'node_modules'), 'dir')
    const cwd = join(scratch, 'cwd')
    mkdirSync(cwd)
    return { repo, cli: join(repo, 'bin', 'orcapod.js'), cwd }
  }

  it('H4: running logs with cwd set to a temporary directory and no ORCAPOD_HOME makes the "no logs" message point to logs/orcapod.log directly under the repository', () => {
    const { repo, cli, cwd } = throwawayRepository()
    const result = spawnSync(process.execPath, [cli, 'logs'], { cwd, env: childEnv({}), encoding: 'utf8' })
    expect([result.status, result.signal, result.error, result.stdout, result.stderr]).toEqual([1, null, undefined, '', `no log: ${join(repo, 'logs', 'orcapod.log')}\n`])
  })

  it('extra H4a: even when bin/orcapod.js is launched through a symbolic link, the home is the root of the real repository', () => {
    const { repo, cli, cwd } = throwawayRepository()
    const link = join(cwd, 'orcapod-link.js')
    symlinkSync(cli, link)
    const result = spawnSync(process.execPath, [link, 'logs'], { cwd, env: childEnv({}), encoding: 'utf8' })
    expect([result.status, result.signal, result.error, result.stdout, result.stderr]).toEqual([1, null, undefined, '', `no log: ${join(repo, 'logs', 'orcapod.log')}\n`])
  })

  it('extra H4b: even when bin/orcapod.js is launched by a relative path, the home is the repository root', () => {
    const { repo, cli, cwd } = throwawayRepository()
    const result = spawnSync(process.execPath, [relative(cwd, cli), 'logs'], { cwd, env: childEnv({}), encoding: 'utf8' })
    expect([result.status, result.signal, result.error, result.stdout, result.stderr]).toEqual([1, null, undefined, '', `no log: ${join(repo, 'logs', 'orcapod.log')}\n`])
  })

  it('extra H4c: a CLI launched with a relative ORCAPOD_HOME prints an absolute path based on the launch cwd', () => {
    const result = spawnSync(process.execPath, [CLI, 'logs'], { cwd: scratch, env: childEnv({ ORCAPOD_HOME: 'rel/h' }), encoding: 'utf8' })
    expect([result.status, result.signal, result.error, result.stdout, result.stderr]).toEqual([1, null, undefined, '', `no log: ${join(scratch, 'rel/h/logs/orcapod.log')}\n`])
  })

  it('H5: passing the default home to the path functions used by each subcommand yields only paths under the repository root', () => {
    const home = orcapodHome()
    const paths = [configPath(home), promptsDir(home), statePath(home), requestsDir(home), lockPath(home), runsDir(home), logPath(home), resultPath(home, RUN_ID), panePath(home, RUN_ID)]
    for (const path of paths) {
      const rel = relative(REPOSITORY_ROOT, path)
      expect([path, rel.startsWith('..'), isAbsolute(rel)]).toEqual([path, false, false])
    }
  })
})

describe('P1: a run ID in state.json cannot point outside runs/', () => {
  function writeState(runs: unknown[]): string {
    const home = join(scratch, 'h')
    mkdirSync(join(home, 'state'), { recursive: true })
    const base = { version: 1, processed: [], pending: [], runs, watchedRules: [], lastPolledAt: {}, projectErrors: {}, orcaOutageSince: null, consumedRequests: [] }
    writeFileSync(statePath(home), JSON.stringify(base))
    return home
  }

  it('H6: loadState throws an Error when runs[0].id is ../../outside', () => {
    expect(() => loadState(writeState([run({ id: '../../outside' })]))).toThrow(Error)
  })

  it.each([
    ['../src'],
    ['run-a'],
    [''],
    ['20261023-0917-3F9A1C'],
    ['20261023-0917-3f9a1'],
    [`20261023-0917-${'a'.repeat(41)}`],
    ['20261023-0917-3f9a1c/x'],
  ])('H7: loadState throws an Error when runs[0].id is %j', (id) => {
    expect(() => loadState(writeState([run({ id })]))).toThrow(Error)
  })

  it.each([
    ['6 characters without collision', new Set<string>()],
    ['7 characters after a collision', new Set(['20261023-0917-ae2ce7'])],
    ['8 characters after a collision', new Set(['20261023-0917-ae2ce7', '20261023-0917-ae2ce7b'])],
  ])('H8: loadState accepts a state.json containing an ID made by newRunId (%s)', (_name, existing) => {
    const id = newRunId('2026-10-23T09:17:42.123Z', '["todos","issue","impl"]|123|0', existing)
    const loaded = loadState(writeState([run({ id })]))
    expect(loaded.runs.map((r) => r.id)).toEqual([id])
  })

  it('extra H8a: an ID of 40 hex characters (the upper limit) is accepted', () => {
    const id = `20261023-0917-${'f'.repeat(40)}`
    expect(loadState(writeState([run({ id })])).runs.map((r) => r.id)).toEqual([id])
  })
})

describe('P2: generated files under the default home are not tracked by git', () => {
  function checkIgnore(paths: string[]): { status: number; ignored: string[] } {
    const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: REPOSITORY_ROOT, input: paths.join('\n'), encoding: 'utf8' })
    if (result.error !== undefined) throw new Error(`git check-ignore failed to start: ${result.error.message}`)
    if (result.status !== 0 && result.status !== 1) throw new Error(`git check-ignore failed: status=${result.status} stderr=${result.stderr}`)
    return { status: result.status, ignored: result.stdout.split('\n').filter((line) => line !== '') }
  }

  it('H10: every file name under config.yaml, prompts, state, runs, and logs is ignored (exit code 0)', () => {
    const paths = ['config.yaml', 'prompts/a.md', 'prompts/feature.claude.md', 'prompts/dependabot.claude.md', 'state/state.json', 'state/requests/x.json', 'state/daemon.lock.123.tmp', `runs/${RUN_ID}/result.json`, 'logs/orcapod.log', 'logs/extra.log']
    expect(checkIgnore(paths)).toEqual({ status: 0, ignored: paths })
  })

  it('H11: the shipped files src/paths.ts, test/paths.test.ts, CLAUDE.md, README.md, and examples/ are not ignored (exit code 1)', () => {
    expect(checkIgnore(['src/paths.ts', 'test/paths.test.ts', 'CLAUDE.md', 'README.md', 'examples/config.yaml', 'examples/prompts/feature.claude.md', 'examples/prompts/dependabot.claude.md'])).toEqual({ status: 1, ignored: [] })
  })

  it('H12: same-named entries in subdirectories (src/state/x.ts, test/logs/a.ts, src/config.yaml) are not ignored (exit code 1)', () => {
    expect(checkIgnore(['src/state/x.ts', 'test/logs/a.ts', 'src/config.yaml'])).toEqual({ status: 1, ignored: [] })
  })

  it('extra H12a: checkIgnore throws an exception when git check-ignore terminates abnormally (exit code 128)', () => {
    const before = process.env.GIT_CONFIG_COUNT
    process.env.GIT_CONFIG_COUNT = '1'
    try {
      expect(() => checkIgnore(['config.yaml'])).toThrow(/status=128/)
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_COUNT
      else process.env.GIT_CONFIG_COUNT = before
    }
  })
})

describe('P3: a non-empty ORCAPOD_HOME is used as its absolute path', () => {
  it('H13: a trailing slash is dropped', () => {
    process.env.ORCAPOD_HOME = '/tmp/orcapod-test-home/'
    expect(orcapodHome()).toBe('/tmp/orcapod-test-home')
  })

  it('H14: a relative path becomes an absolute path based on cwd', () => {
    process.env.ORCAPOD_HOME = 'sandbox/h'
    expect(orcapodHome()).toBe(resolve(process.cwd(), 'sandbox/h'))
  })

  it('H15: a whitespace-only value does not fall back to the default and is the resolved value', () => {
    process.env.ORCAPOD_HOME = '  '
    expect(orcapodHome()).toBe(resolve('  '))
    expect(orcapodHome()).not.toBe(REPOSITORY_ROOT)
  })

  it('H16: specifying the repository root itself yields that value', () => {
    process.env.ORCAPOD_HOME = REPOSITORY_ROOT
    expect(orcapodHome()).toBe(REPOSITORY_ROOT)
  })
})

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    project: 'todos',
    target: { path: '/p', repo: 'alice/todos', githubAccount: 'taylor' },
    rule: { target: 'issue', label: 'impl', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 5, enabled: true, bootstrap: 'skip' },
    kindName: 'Feature',
    items: [],
    createdAt: '2026-10-23T00:12:00.000Z',
    startedAt: null,
    phase: { kind: 'launching', since: '2026-10-23T00:17:00.000Z' },
    history: [],
    orca: null,
    notified: [],
    bypassLimit: false,
    manual: false,
    lastMessage: null,
    ...overrides,
  }
}

function config(): Config {
  return {
    settings: {
      maxConcurrentPerProject: 2,
      launch: { claude: 'claude', codex: 'codex' },
      notify: { desktop: true, waitingMinutes: 10, maxRunMinutes: 120, queuedMinutes: 30 },
    },
    kinds: [{ id: 'feature', name: 'Feature' }],
    projects: [],
    prompts: new Map([['feature.claude', 'x\n']]),
  }
}

describe('P4: generated paths are absolute and do not depend on cwd', () => {
  function prepareUnderRelativeHome(): { dirA: string; home: string; command: string; launchScript: string } {
    const dirA = join(scratch, 'A')
    mkdirSync(dirA)
    process.chdir(dirA)
    process.env.ORCAPOD_HOME = 'rel'
    const home = orcapodHome()
    const { command, launchScript } = prepareRun(home, run(), config())
    return { dirA, home, command, launchScript }
  }

  it('H17: with cwd=A and a relative ORCAPOD_HOME, every path in the generated launch.sh and in the command to Orca is an absolute path under A/rel', () => {
    const { dirA, home, command, launchScript } = prepareUnderRelativeHome()
    const dir = join(dirA, 'rel', 'runs', RUN_ID)
    expect(home).toBe(join(dirA, 'rel'))
    expect(launchScript).toBe(join(dir, 'launch.sh'))
    expect(command).toBe(`bash '${dir}/launch.sh'`)
    const script = readFileSync(launchScript, 'utf8')
    expect(script).toContain(`> '${dir}/pane.json'`)
    expect(script).toContain(`"$(cat '${dir}/prompt.md')"`)
    expect(readFileSync(join(dir, 'prompt.md'), 'utf8')).toContain(`${dir}/result.json`)
    const homePaths = [...script.matchAll(/'([^']*\/(?:pane\.json|prompt\.md|result\.json|launch\.sh))'/g)].map((m) => m[1])
    expect(homePaths.length).toBeGreaterThan(0)
    for (const path of homePaths) expect(path.startsWith(`${dirA}/rel/`)).toBe(true)
  })

  it('H18: after H17, resultPath and panePath stay under A/rel even after moving to another directory B', () => {
    const { dirA, home, launchScript } = prepareUnderRelativeHome()
    const before = { result: resultPath(home, RUN_ID), pane: panePath(home, RUN_ID), script: readFileSync(launchScript, 'utf8') }
    const dirB = join(scratch, 'B')
    mkdirSync(dirB)
    process.chdir(dirB)
    expect(resultPath(home, RUN_ID)).toBe(before.result)
    expect(panePath(home, RUN_ID)).toBe(before.pane)
    expect(before.result.startsWith(`${dirA}/rel/`)).toBe(true)
    expect(before.pane.startsWith(`${dirA}/rel/`)).toBe(true)
    expect(readFileSync(launchScript, 'utf8')).toBe(before.script)
  })
})

describe('lint targets', () => {
  it('H19: the ignores of eslint.config.js include prompts/**, state/**, runs/**, and logs/** but not src/** or test/**', async () => {
    const mod = await import(pathToFileURL(join(REPOSITORY_ROOT, 'eslint.config.js')).href) as { default: { ignores?: string[] }[] }
    const ignores = mod.default.flatMap((entry) => entry.ignores ?? [])
    expect(ignores).toEqual(expect.arrayContaining(['prompts/**', 'state/**', 'runs/**', 'logs/**']))
    expect(ignores).not.toContain('src/**')
    expect(ignores).not.toContain('test/**')
  })
})
