import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { formatDoctorLine, judgeDoctor, runDoctor } from '../src/doctor.ts'
import type { DoctorDeps, DoctorFacts } from '../src/doctor.ts'
import { OrcaError } from '../src/orca.ts'
import { claudeConfigPath, codexConfigPath } from '../src/paths.ts'
import type { Config, ConfigResult, OrcaClient, Project, Rule } from '../src/types.ts'

const STOCK_PATH = '/Users/me/git/todos'
const claudeRule: Rule = { target: 'issue', label: 'impl', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 5, enabled: true, bootstrap: 'skip' }
const codexRule: Rule = { ...claudeRule, label: 'fix', ai: 'codex' }

function project(overrides: Partial<Project> = {}): Project {
  return { name: 'todos', path: STOCK_PATH, repo: 'taylor/todos', githubAccount: 'taylor', enabled: true, authors: ['OWNER'], bots: [], rules: [claudeRule], ...overrides }
}

function configWith(projects: Project[]): ConfigResult {
  const config: Config = {
    settings: { maxConcurrentPerProject: 2, launch: { claude: 'claude --dangerously-skip-permissions', codex: 'codex' }, notify: { desktop: true, waitingMinutes: 10, maxRunMinutes: 120, queuedMinutes: 30 } },
    kinds: [{ id: 'feature', name: 'Feature' }],
    projects,
    prompts: new Map([['feature.claude', '{{items}}']]),
  }
  return { ok: true, config, sha256: '09bfcc6a14b83e2192b8673677725c84883ee9cd0c70e45c9ec09daa8f2b2847' }
}

function facts(overrides: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    orca: { ok: true, value: { running: true, version: '1.4.217' } },
    hooks: { ok: true, value: { enabled: true, agents: { claude: 'installed', codex: 'not_installed' } } },
    ghAccounts: { ok: true, value: ['taylor', 'acme-developer'] },
    config: configWith([project()]),
    pathErrors: [],
    commands: [{ ai: 'claude', command: 'claude', found: '/Users/me/.local/bin/claude' }, { ai: 'codex', command: 'codex', found: '/Users/me/.local/bin/codex' }],
    registeredPaths: { ok: true, value: [STOCK_PATH] },
    isPrivate: { todos: { ok: true, value: true } },
    claudeConfig: JSON.stringify({ projects: { [STOCK_PATH]: { hasTrustDialogAccepted: true } } }),
    codexConfig: null,
    projectClaudeSettings: { todos: null },
    daemonPid: 4242,
    ...overrides,
  }
}

function judged(input: DoctorFacts): string[] {
  return judgeDoctor(input).map(formatDoctorLine)
}

describe('judgeDoctor', () => {
  it('when everything is in place, yields only OK lines and checks only the hooks and trust of the AIs used by rules', () => {
    expect(judged(facts())).toEqual([
      'OK   Orca: running (version 1.4.217)',
      'OK   hooks: claude installed',
      'OK   gh: accounts taylor, acme-developer',
      'OK   claude: /Users/me/.local/bin/claude',
      'OK   codex: /Users/me/.local/bin/codex',
      'OK   config: projects 1 / rules 1 / prompts 1',
      'OK   todos: githubAccount taylor is in gh',
      'OK   todos: registered in Orca',
      'OK   todos: taylor/todos is private',
      'OK   todos: folder trust is accepted in claude',
      'OK   daemon: running (pid 4242)',
    ])
  })

  it('when Orca, hooks and gh are unusable and the configuration is broken, lists NG lines, skips per-project checks, and treats both AIs as in use', () => {
    expect(judged(facts({
      orca: { ok: false, error: 'exec_failed: orca status: spawn ENOENT' },
      hooks: { ok: false, error: 'exec_failed: orca agent hooks status: spawn ENOENT' },
      ghAccounts: { ok: false, error: 'cannot run gh auth status: spawn gh ENOENT' },
      config: { ok: false, errors: ['projects[0].githubAccount: "taylor" is not an account in gh auth status (choices: none)', 'prompts/feature.claude.md: missing (referenced by projects[0].rules[0])'], unknownGithubAccounts: ['taylor'] },
      commands: [{ ai: 'claude', command: 'claude', found: null }, { ai: 'codex', command: 'codex', found: null }],
      registeredPaths: { ok: false, error: 'exec_failed: orca repo list: spawn ENOENT' },
      isPrivate: {},
      daemonPid: null,
    }))).toEqual([
      'NG   Orca: not responding (exec_failed: orca status: spawn ENOENT)',
      'NG   hooks: cannot read the state (exec_failed: orca agent hooks status: spawn ENOENT)',
      'NG   gh: cannot read accounts (cannot run gh auth status: spawn gh ENOENT)',
      'NG   claude: claude is not on PATH (including ~/.local/bin and /opt/homebrew/bin)',
      'NG   codex: codex is not on PATH (including ~/.local/bin and /opt/homebrew/bin)',
      'NG   config: projects[0].githubAccount: "taylor" is not an account in gh auth status (choices: none)',
      'NG   config: prompts/feature.claude.md: missing (referenced by projects[0].rules[0])',
      'WARN daemon: not running (start it with orcapod start)',
    ])
  })

  it('Orca not running, the global hooks switch disabled, no gh account, and an unused AI that is missing', () => {
    expect(judged(facts({
      orca: { ok: true, value: { running: false, version: null } },
      hooks: { ok: true, value: { enabled: false, agents: { claude: 'installed', codex: 'installed' } } },
      ghAccounts: { ok: true, value: [] },
      commands: [{ ai: 'claude', command: 'claude', found: '/Users/me/.local/bin/claude' }, { ai: 'codex', command: 'codex', found: null }],
    })).slice(0, 5)).toEqual([
      'NG   Orca: not running (open Orca)',
      'NG   hooks: Orca hooks are disabled (orca agent hooks on)',
      'NG   gh: no logged-in account (gh auth login)',
      'OK   claude: /Users/me/.local/bin/claude',
      'WARN codex: codex is not on PATH (including ~/.local/bin and /opt/homebrew/bin). Not used by the rules',
    ])
  })

  it('NG when the hooks of an AI used by a rule are not installed; AIs of disabled rules and projects are not checked', () => {
    const projects = [project({ rules: [claudeRule, { ...codexRule, enabled: false }] }), project({ name: 'old', path: '/Users/me/git/old', enabled: false, rules: [codexRule] })]
    expect(judged(facts({ config: configWith(projects), hooks: { ok: true, value: { enabled: true, agents: { claude: 'partial', codex: 'not_installed' } } } }))[1]).toBe('NG   hooks: claude is partial (orca agent hooks on)')
  })

  it('turns an enabled project not registered in Orca, a public repository, an unreadable repository, and path errors into lines', () => {
    const projects = [project(), project({ name: 'catalog', path: '/Users/me/git/catalog', repo: 'acme-corp/catalog', githubAccount: 'acme-developer' })]
    const lines = judged(facts({
      config: configWith(projects),
      pathErrors: ['projects[1].path: "/Users/me/git/catalog" has no .git'],
      registeredPaths: { ok: true, value: ['/Users/me/git/other'] },
      isPrivate: { todos: { ok: true, value: false }, catalog: { ok: false, error: 'gh api repos/acme-corp/catalog failed: gh: Not Found (HTTP 404)' } },
      claudeConfig: JSON.stringify({ projects: { [STOCK_PATH]: { hasTrustDialogAccepted: true }, '/Users/me/git/catalog': { hasTrustDialogAccepted: true } } }),
      projectClaudeSettings: { todos: null, catalog: null },
    }))
    expect(lines.slice(5, -1)).toEqual([
      'OK   config: projects 2 / rules 2 / prompts 1',
      'NG   config: projects[1].path: "/Users/me/git/catalog" has no .git',
      'OK   todos: githubAccount taylor is in gh',
      'NG   todos: /Users/me/git/todos is not registered in Orca (add the folder in Orca)',
      'WARN todos: taylor/todos is a public repository. Writers are limited by authors / bots',
      'OK   todos: folder trust is accepted in claude',
      'OK   catalog: githubAccount acme-developer is in gh',
      'NG   catalog: /Users/me/git/catalog is not registered in Orca (add the folder in Orca)',
      'NG   catalog: cannot read acme-corp/catalog (gh api repos/acme-corp/catalog failed: gh: Not Found (HTTP 404))',
      'OK   catalog: folder trust is accepted in claude',
    ])
  })

  it('when the Orca registration listing is unreadable, yields a single NG line and no per-project registration judgment', () => {
    const lines = judged(facts({ registeredPaths: { ok: false, error: 'exec_failed: orca repo list: timeout' } }))
    expect(lines.slice(6, 9)).toEqual([
      'NG   Orca registration: cannot read the list (exec_failed: orca repo list: timeout)',
      'OK   todos: githubAccount taylor is in gh',
      'OK   todos: taylor/todos is private',
    ])
  })

  it.each([
    ['~/.claude.json is missing', null],
    ['not readable as JSON', '{'],
    ['projects has no entry for the path', JSON.stringify({ projects: { '/Users/me/git/other': { hasTrustDialogAccepted: true } } })],
    ['hasTrustDialogAccepted is false', JSON.stringify({ projects: { [STOCK_PATH]: { hasTrustDialogAccepted: false } } })],
  ])('NG when the claude trust dialog is not accepted (%s)', (_name, claudeConfig) => {
    expect(judged(facts({ claudeConfig })).at(-2)).toBe('NG   todos: folder trust is not accepted in claude (open claude interactively once in /Users/me/git/todos and accept it)')
  })

  it.each([
    ['hooks present and hasTrustDialogHooksAccepted missing', JSON.stringify({ hooks: { Stop: [] } }), false, ['OK   todos: folder trust is accepted in claude', 'WARN todos: .claude/settings.json has hooks, and hooks trust (hasTrustDialogHooksAccepted) is not accepted. Launch may stop at a second dialog']],
    ['hooks present and hasTrustDialogHooksAccepted is true', JSON.stringify({ hooks: { Stop: [] } }), true, ['OK   todos: folder trust is accepted in claude']],
    ['hooks empty', JSON.stringify({ hooks: {} }), false, ['OK   todos: folder trust is accepted in claude']],
    ['settings.json is missing', null, false, ['OK   todos: folder trust is accepted in claude']],
  ])('R7: hooks in the project .claude/settings.json (%s)', (_name, settings, hooksAccepted, expected) => {
    const claudeConfig = JSON.stringify({ projects: { [STOCK_PATH]: { hasTrustDialogAccepted: true, hasTrustDialogHooksAccepted: hooksAccepted } } })
    expect(judged(facts({ claudeConfig, projectClaudeSettings: { todos: settings } })).slice(9, -1)).toEqual(expected)
  })

  it.each([
    ['trusted', `model = "gpt-6"\n\n[projects."/Users/me/git/todos"]\ntrust_level = "trusted"\n`, 'OK   todos: folder trust is accepted in codex'],
    ['single-quoted key', `[projects.'/Users/me/git/todos']\ntrust_level = "trusted"\n`, 'OK   todos: folder trust is accepted in codex'],
    ['untrusted', `[projects."/Users/me/git/todos"]\ntrust_level = "untrusted"\n`, 'NG   todos: folder trust is not accepted in codex (open codex interactively once in /Users/me/git/todos and accept it)'],
    ['only a table for a different path is trusted', `[projects."/Users/me/git/todos/sub"]\ntrust_level = "trusted"\n`, 'NG   todos: folder trust is not accepted in codex (open codex interactively once in /Users/me/git/todos and accept it)'],
    ['trust_level in a later, different table is not counted', `[projects."/Users/me/git/todos"]\nmodel = "x"\n\n[profiles.fast]\ntrust_level = "trusted"\n`, 'NG   todos: folder trust is not accepted in codex (open codex interactively once in /Users/me/git/todos and accept it)'],
  ])('codex trust is read from trust_level in [projects."<path>"] of config.toml (%s)', (_name, codexConfig, expected) => {
    const lines = judged(facts({ config: configWith([project({ rules: [codexRule] })]), hooks: { ok: true, value: { enabled: true, agents: { claude: 'not_installed', codex: 'installed' } } }, codexConfig }))
    expect([lines[1], lines.at(-2)]).toEqual(['OK   hooks: codex installed', expected])
  })

  it('not accepted when the codex config.toml is missing', () => {
    const lines = judged(facts({ config: configWith([project({ rules: [codexRule] })]), codexConfig: null }))
    expect(lines.at(-2)).toBe('NG   todos: folder trust is not accepted in codex (open codex interactively once in /Users/me/git/todos and accept it)')
  })
})

describe('runDoctor', () => {
  let home: string
  let projectPath: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orcapod-doctor-'))
    projectPath = join(home, 'git', 'todos')
    mkdirSync(join(projectPath, '.git'), { recursive: true })
    writeFileSync(join(home, 'config.yaml'), stringify({
      version: 1,
      settings: { launch: { claude: 'claude --dangerously-skip-permissions' } },
      kinds: [{ id: 'feature', name: 'Feature' }],
      projects: [
        { name: 'off', path: join(home, 'git', 'off'), repo: 'taylor/off', githubAccount: 'taylor', enabled: false, rules: [{ target: 'issue', label: 'impl', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 0 }] },
        { name: 'todos', path: projectPath, repo: 'taylor/todos', githubAccount: 'taylor', rules: [{ target: 'issue', label: 'impl', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 0 }] },
      ],
    }))
    mkdirSync(join(home, 'prompts'))
    writeFileSync(join(home, 'prompts', 'feature.claude.md'), '{{items}}\n')
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function orcaWith(calls: string[], overrides: Partial<OrcaClient>): OrcaClient {
    const unused = async (): Promise<never> => {
      throw new Error('not called in this test')
    }
    return {
      status: async () => ({ running: true, version: '1.4.217' }),
      createTerminal: unused,
      listTerminals: unused,
      closeTerminal: unused,
      worktreePs: unused,
      readScreen: unused,
      hooksStatus: async () => ({ enabled: true, agents: { claude: 'installed', codex: 'installed' } }),
      waitExit: unused,
      registeredPaths: async () => [projectPath],
      observe: unused,
      ...Object.fromEntries(Object.entries(overrides).map(([name, method]) => [name, async (...args: unknown[]) => {
        calls.push(`${name} ${JSON.stringify(args)}`)
        return (method as (...a: unknown[]) => Promise<unknown>)(...args)
      }])),
    }
  }

  function depsWith(orca: OrcaClient, readText: (path: string) => string | null = () => null): DoctorDeps {
    return {
      home,
      orca,
      ghAccounts: async () => ['taylor'],
      isPrivate: async () => true,
      findCommand: (command) => `/Users/me/.local/bin/${command}`,
      readText,
      daemonPid: () => null,
    }
  }

  it('judges by reading the configuration, path and trust files of enabled projects (disabled projects are not checked)', async () => {
    const files = new Map([
      [claudeConfigPath(), JSON.stringify({ projects: { [projectPath]: { hasTrustDialogAccepted: true } } })],
      [codexConfigPath(), ''],
      [join(projectPath, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [] } })],
    ])
    const lines = await runDoctor(depsWith(orcaWith([], {}), (path) => files.get(path) ?? null), { probe: false })
    expect(lines.map(formatDoctorLine)).toEqual([
      'OK   Orca: running (version 1.4.217)',
      'OK   hooks: claude installed',
      'OK   gh: accounts taylor',
      'OK   claude: /Users/me/.local/bin/claude',
      'OK   codex: /Users/me/.local/bin/codex',
      'OK   config: projects 2 / rules 2 / prompts 1',
      'NG   config: projects[0].path: "' + join(home, 'git', 'off') + '" does not exist',
      'OK   todos: githubAccount taylor is in gh',
      'OK   todos: registered in Orca',
      'OK   todos: taylor/todos is private',
      'OK   todos: folder trust is accepted in claude',
      'WARN todos: .claude/settings.json has hooks, and hooks trust (hasTrustDialogHooksAccepted) is not accepted. Launch may stop at a second dialog',
      'WARN daemon: not running (start it with orcapod start)',
    ])
  })

  it('--probe calls create → waitExit → close in order on the first enabled project and shows each stage', async () => {
    const calls: string[] = []
    const orca = orcaWith(calls, {
      createTerminal: async () => ({ ref: { handle: 'term_p', tabId: 'tab-p', paneKey: 'tab-p:leaf-p', ptyId: 'pty-p' }, warning: null }),
      waitExit: async () => ({ exited: true }),
      closeTerminal: async () => ({ ptyKilled: true }),
    })
    const lines = await runDoctor(depsWith(orca), { probe: true })
    expect(calls).toEqual([
      `createTerminal [{"worktreePath":"${projectPath}","title":"orcapod probe","command":"bash -c 'echo ORCAPOD_PROBE_OK; sleep 2'; exit"}]`,
      'waitExit ["term_p",20000]',
      'closeTerminal ["term_p"]',
    ])
    expect(lines.slice(-3).map(formatDoctorLine)).toEqual([
      'OK   probe create: opened a tab in todos (handle term_p, paneKey tab-p:leaf-p)',
      'OK   probe wait: the command exited',
      'OK   probe close: closed the tab (ptyKilled: true)',
    ])
  })

  it('--probe closes the tab even when the exit cannot be awaited, and shows the warning and failures', async () => {
    const calls: string[] = []
    const orca = orcaWith(calls, {
      createTerminal: async () => ({ ref: { handle: 'term_p', tabId: 'tab-p', paneKey: 'tab-p:leaf-p', ptyId: '' }, warning: 'surface: background' }),
      waitExit: async () => ({ exited: false }),
      closeTerminal: async () => {
        throw new OrcaError('terminal_handle_stale', 'handle is stale')
      },
    })
    const lines = await runDoctor(depsWith(orca), { probe: true })
    expect(calls.map((call) => call.split(' ')[0])).toEqual(['createTerminal', 'waitExit', 'closeTerminal'])
    expect(lines.slice(-3).map(formatDoctorLine)).toEqual([
      'OK   probe create: opened a tab in todos (handle term_p, paneKey tab-p:leaf-p). Warning: surface: background',
      'NG   probe wait: not exited after 20s',
      'NG   probe close: cannot close the tab (terminal_handle_stale: handle is stale)',
    ])
  })

  it('--probe proceeds to close even when waitExit throws', async () => {
    const calls: string[] = []
    const orca = orcaWith(calls, {
      createTerminal: async () => ({ ref: { handle: 'term_p', tabId: 'tab-p', paneKey: 'tab-p:leaf-p', ptyId: 'pty-p' }, warning: null }),
      waitExit: async () => {
        throw new OrcaError('terminal_not_found', 'no such terminal')
      },
      closeTerminal: async () => ({ ptyKilled: null }),
    })
    const lines = await runDoctor(depsWith(orca), { probe: true })
    expect(lines.slice(-2).map(formatDoctorLine)).toEqual([
      'NG   probe wait: cannot wait for exit (terminal_not_found: no such terminal)',
      'OK   probe close: closed the tab (ptyKilled: null)',
    ])
  })

  it('--probe calls neither waitExit nor close when create fails', async () => {
    const calls: string[] = []
    const orca = orcaWith(calls, {
      createTerminal: async () => {
        throw new OrcaError('no_pane_key', 'terminal create response has no paneKey')
      },
    })
    const lines = await runDoctor(depsWith(orca), { probe: true })
    expect(calls.map((call) => call.split(' ')[0])).toEqual(['createTerminal'])
    expect(formatDoctorLine(lines[lines.length - 1])).toBe('NG   probe create: cannot open a tab in todos (no_pane_key: terminal create response has no paneKey)')
  })

  it('--probe yields NG without calling Orca when the configuration is unreadable', async () => {
    writeFileSync(join(home, 'config.yaml'), 'version: [')
    const calls: string[] = []
    const lines = await runDoctor(depsWith(orcaWith(calls, {})), { probe: true })
    expect(calls).toEqual([])
    expect(formatDoctorLine(lines[lines.length - 1])).toBe('NG   probe: cannot try because the config is unreadable')
  })
})
