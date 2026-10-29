import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig, ruleKey } from '../src/config.ts'
import { buildMonitorModel, configViewOf, daemonHealthOf } from '../src/monitor-model.ts'
import type { ConfigView, MonitorInput, MonitorModel, Row, SectionId } from '../src/monitor-model.ts'
import { loadState } from '../src/state.ts'
import type { Config, ConfigResult, Item, Project, Rule, Run, State } from '../src/types.ts'

const NOW = '2026-10-23T01:00:00.000Z'
const HOME = '/Users/me/git/orcapod'
const SHA = 'a'.repeat(64)

let originalTz: string | undefined

beforeAll(() => {
  originalTz = process.env.TZ
  process.env.TZ = 'Asia/Tokyo'
})

afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
})

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orcapod-monitor-model-'))
  dirs.push(dir)
  return dir
}

function secondsBefore(seconds: number): string {
  return new Date(Date.parse(NOW) - seconds * 1000).toISOString()
}

const featureRule: Rule = { target: 'issue', label: 'impl', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 5, enabled: true, bootstrap: 'skip' }
const dependabotRule: Rule = { target: 'pr', label: 'dependencies', kind: 'dependabot', ai: 'codex', batch: 'together', delayMinutes: 30, enabled: true, bootstrap: 'skip' }

function project(overrides: Partial<Project>): Project {
  return { name: 'todos', path: '/Users/me/git/todos', repo: 'taylor/todos', githubAccount: 'taylor', enabled: true, authors: ['OWNER'], bots: ['dependabot[bot]'], rules: [featureRule, dependabotRule], ...overrides }
}

const config: Config = {
  settings: { maxConcurrentPerProject: 2, launch: { claude: 'claude', codex: 'codex' }, notify: { desktop: true, waitingMinutes: 10, maxRunMinutes: 120, queuedMinutes: 5 } },
  kinds: [{ id: 'feature', name: 'Feature' }, { id: 'dependabot', name: 'Dependabot update' }],
  projects: [
    project({}),
    project({ name: 'catalog', path: '/Users/me/git/catalog', repo: 'acme-corp/catalog', githubAccount: 'acme-developer', rules: [featureRule] }),
    project({ name: 'old', path: '/Users/me/git/old', repo: 'taylor/old', enabled: false, rules: [featureRule] }),
  ],
  prompts: new Map([['feature.claude', 'x']]),
}

const runningConfig: ConfigView = { kind: 'running', config, loadedAt: secondsBefore(3600) }

function item(number: number, target: Item['target'] = 'issue'): Item {
  return { project: 'todos', repo: 'taylor/todos', target, number, title: `Title ${number}`, url: `https://github.com/taylor/todos/issues/${number}`, labels: ['impl'], author: { login: 'taylor', bot: false, association: 'OWNER' } }
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
    configStatus: { loadedAt: secondsBefore(3600), sha256: SHA, error: null },
    daemonInfo: { pid: 4242, startedAt: secondsBefore(7200), lastCycleAt: secondsBefore(3), lastCycleError: null, orcaVersion: '1.4.217', cycleSeconds: 20 },
    ...overrides,
  }
}

function modelOf(state: State | null, overrides: Partial<MonitorInput> = {}): MonitorModel {
  return buildMonitorModel({ home: HOME, state, stateError: null, stateMtime: secondsBefore(3), daemonPid: 4242, lockError: null, config: runningConfig, now: NOW, ...overrides })
}

function rowsOf(model: MonitorModel, id: SectionId): Row[] {
  const section = model.sections.find((candidate) => candidate.id === id)
  if (section === undefined) throw new Error(`no ${id} section`)
  return section.rows
}

function titleOf(model: MonitorModel, id: SectionId): string {
  return model.sections.find((candidate) => candidate.id === id)?.title ?? ''
}

function sectionsHolding(model: MonitorModel, runId: string): SectionId[] {
  return model.sections.flatMap((section) => section.rows.filter((row) => row.ref?.kind === 'run' && row.ref.runId === runId).map(() => section.id))
}

function cellsOf(row: Row): Record<string, string> {
  return Object.fromEntries(row.cells.map((cell) => [cell.column, cell.text]))
}

function okDisk(sha256: string = SHA): ConfigResult {
  return { ok: true, config, sha256 }
}

const brokenDisk: ConfigResult = { ok: false, errors: ['config.yaml: not valid YAML (Unexpected scalar)', 'projects[0].name: required'], unknownGithubAccounts: [] }

describe('daemonHealthOf', () => {
  it.each([
    ['no state.json → never', null, 4242, 20, NOW, { kind: 'never' }],
    ['pid is dead → stopped', secondsBefore(5), null, 20, NOW, { kind: 'stopped', updatedAt: secondsBefore(5) }],
    ['A46: pid is alive but state.json has not been updated for 60 seconds (3 cycles) → stale', secondsBefore(60), 4242, 20, NOW, { kind: 'stale', pid: 4242, updatedAt: secondsBefore(60) }],
    ['1 millisecond short of 3 cycles → alive', '2026-10-23T00:59:00.001Z', 4242, 20, NOW, { kind: 'alive', pid: 4242, updatedAt: '2026-10-23T00:59:00.001Z' }],
    ['with a 30-second cycle, 89 seconds ago is alive', secondsBefore(89), 4242, 30, NOW, { kind: 'alive', pid: 4242, updatedAt: secondsBefore(89) }],
    ['with a 30-second cycle, 90 seconds ago is stale', secondsBefore(90), 4242, 30, NOW, { kind: 'stale', pid: 4242, updatedAt: secondsBefore(90) }],
  ])('%s', (_name, mtime, pid, cycleSeconds, now, expected) => {
    expect(daemonHealthOf(mtime, pid, cycleSeconds, now)).toEqual(expected)
  })

  it('A46: when daemonInfo is null (a 001 daemon), it is treated as a 20-second cycle and stale is shown in attention after 60 seconds', () => {
    const model = modelOf(stateWith({ daemonInfo: null }), { stateMtime: secondsBefore(60) })
    expect(rowsOf(model, 'attention').map((row) => cellsOf(row).note)).toEqual(['daemon possibly stopped (pid 4242, updated 1m ago)'])
    expect(model.header[1]).toEqual({ text: 'daemon: possibly stopped pid 4242 (updated 1m ago)', alert: true })
  })
})

describe('configViewOf', () => {
  const CONFIG_YAML = [
    'version: 1',
    'kinds:',
    '  - id: feature',
    '    name: Feature',
    'projects:',
    '  - name: todos',
    '    path: /Users/me/git/todos',
    '    repo: taylor/todos',
    '    githubAccount: not-in-gh',
    '    rules:',
    '      - { target: issue, label: impl, kind: feature, ai: claude, batch: each, delayMinutes: 5 }',
    '',
  ].join('\n')

  function diskHome(): string {
    const home = tempHome()
    writeFileSync(join(home, 'config.yaml'), CONFIG_YAML)
    mkdirSync(join(home, 'prompts'))
    writeFileSync(join(home, 'prompts', 'feature.claude.md'), '{{repo}}')
    return home
  }

  it('A32: running when the sha256 of the daemon equals that of the disk and error is null; unreflected once one newline is appended to the disk content', () => {
    const home = diskHome()
    const before = loadConfig(home, { ghAccounts: 'unchecked' })
    if (!before.ok) throw new Error(before.errors.join('\n'))
    const status = { loadedAt: secondsBefore(600), sha256: before.sha256, error: null }
    expect(configViewOf(before, status)).toEqual({ kind: 'running', config: before.config, loadedAt: secondsBefore(600) })

    appendFileSync(join(home, 'config.yaml'), '\n')
    const after = loadConfig(home, { ghAccounts: 'unchecked' })
    if (!after.ok) throw new Error(after.errors.join('\n'))
    expect(configViewOf(after, status)).toEqual({ kind: 'unreflected', disk: after.config, diskError: null, status })
  })

  it('A34: when the daemon rejects an unregistered account (error present), it is unreflected even if sha256 matches and the monitor can read the configuration', () => {
    const home = diskHome()
    const disk = loadConfig(home, { ghAccounts: 'unchecked' })
    if (!disk.ok) throw new Error(disk.errors.join('\n'))
    const status = { loadedAt: secondsBefore(600), sha256: disk.sha256, error: 'projects[0].githubAccount: not-in-gh is not logged in to gh' }
    const view = configViewOf(disk, status)
    expect(view).toEqual({ kind: 'unreflected', disk: disk.config, diskError: null, status })
    const model = modelOf(stateWith({}), { config: view })
    expect(model.header).toContainEqual({ text: 'config not applied (daemon runs the config loaded 10-23 09:50; error: projects[0].githubAccount: not-in-gh is not logged in to gh)', alert: true })
    expect(model.configLines.slice(0, 3)).toEqual(['Config not applied', 'Daemon load error:', '  projects[0].githubAccount: not-in-gh is not logged in to gh'])
  })

  it('A33: unknown when configStatus is null (the disk configuration is kept as is)', () => {
    expect(configViewOf(okDisk(), null)).toEqual({ kind: 'unknown', disk: config, diskError: null })
    expect(configViewOf(brokenDisk, null)).toEqual({ kind: 'unknown', disk: null, diskError: 'config.yaml: not valid YAML (Unexpected scalar)\nprojects[0].name: required' })
  })

  it('A33: when the disk configuration is broken, it is unreflected, and the top of the configuration view shows the parse error, the daemon load time, and the rule keys in effect', () => {
    const status = { loadedAt: secondsBefore(3600), sha256: SHA, error: 'config.yaml: not valid YAML (Unexpected scalar)\nprojects[0].name: required' }
    const view = configViewOf(brokenDisk, status)
    expect(view).toEqual({ kind: 'unreflected', disk: null, diskError: 'config.yaml: not valid YAML (Unexpected scalar)\nprojects[0].name: required', status })
    const model = modelOf(stateWith({ watchedRules: ['["todos","issue","impl"]', '["catalog","issue","impl"]'] }), { config: view })
    expect(model.configLines).toEqual([
      'Config not applied',
      'Daemon load error:',
      '  config.yaml: not valid YAML (Unexpected scalar)',
      '  projects[0].name: required',
      'Daemon runs the config loaded at 10-23 09:00',
      'Rule keys in effect:',
      '  ["todos","issue","impl"]',
      '  ["catalog","issue","impl"]',
    ])
  })

  it('when only the disk content differs (no error), shows that it will be loaded in the next cycle, together with the disk configuration', () => {
    const view = configViewOf(okDisk('b'.repeat(64)), { loadedAt: secondsBefore(3600), sha256: SHA, error: null })
    const lines = modelOf(stateWith({}), { config: view }).configLines
    expect(lines.slice(0, 7)).toEqual([
      'Config not applied',
      'config.yaml on disk differs from what the daemon loaded (the daemon loads it next cycle)',
      'Daemon runs the config loaded at 10-23 09:00',
      'Rule keys in effect:',
      '  none',
      '',
      'Config on disk (not applied):',
    ])
  })
})

describe('buildMonitorModel: header and configuration view', () => {
  it('shows the running daemon, the Orca version, the GitHub healthy count, the configuration in effect, and the home in the header', () => {
    const model = modelOf(stateWith({ lastPolledAt: { todos: secondsBefore(12), catalog: secondsBefore(12) } }))
    expect(model.header).toEqual([
      { text: 'orcapod monitor', alert: false },
      { text: 'daemon: running pid 4242 (updated 3s ago)', alert: false },
      { text: 'Orca 1.4.217', alert: false },
      { text: 'GitHub: 2 healthy', alert: false },
      { text: 'config loaded 10-23 09:00 OK', alert: false },
      { text: `home ${HOME}`, alert: false },
    ])
    expect(model.neverStarted).toBe(false)
    expect(model.home).toBe(HOME)
  })

  it('warning items (monitoring error, Orca outage, state load error) follow the daemon item directly, and the version shows "version unknown" when it cannot be obtained', () => {
    const state = stateWith({
      projectErrors: { catalog: { since: secondsBefore(300), message: 'HTTP 404: Not Found' } },
      orcaOutageSince: secondsBefore(120),
      daemonInfo: { pid: 4242, startedAt: secondsBefore(7200), lastCycleAt: secondsBefore(3), lastCycleError: null, orcaVersion: null, cycleSeconds: 20 },
    })
    expect(modelOf(state, { stateError: 'cannot read state.json: corrupt' }).header).toEqual([
      { text: 'orcapod monitor', alert: false },
      { text: 'daemon: running pid 4242 (updated 3s ago)', alert: false },
      { text: 'Orca: unreachable since 10-23 09:58', alert: true },
      { text: 'GitHub: 1 healthy / watch error catalog', alert: true },
      { text: 'cannot read state.json: corrupt', alert: true },
      { text: 'Orca version unknown', alert: false },
      { text: 'config loaded 10-23 09:00 OK', alert: false },
      { text: `home ${HOME}`, alert: false },
    ])
  })

  it('without state.json it is neverStarted with no sections, and the header shows only that the daemon has never run and the configuration status', () => {
    const model = modelOf(null, { stateMtime: null, daemonPid: null, config: configViewOf(okDisk(), null) })
    expect(model.neverStarted).toBe(true)
    expect(model.sections).toEqual([])
    expect(model.history).toEqual([])
    expect(model.header).toEqual([
      { text: 'orcapod monitor', alert: false },
      { text: 'daemon: never started', alert: true },
      { text: 'config status unknown', alert: false },
      { text: `home ${HOME}`, alert: false },
    ])
    expect(model.configLines.slice(0, 4)).toEqual(['Config status unknown (the daemon is the 001 version or has never run)', '', 'Config on disk:', 'settings:'])
  })

  it('the configuration view in effect shows settings, kinds, and per project the githubAccount / authors / bots / rules and whether each prompt exists', () => {
    expect(modelOf(stateWith({})).configLines).toEqual([
      'Config in effect (loaded 10-23 09:00)',
      '',
      'settings:',
      '  maxConcurrentPerProject: 2',
      '  launch.claude: claude',
      '  launch.codex: codex',
      '  notify: desktop on, waitingMinutes 10, maxRunMinutes 120, queuedMinutes 5',
      'kinds:',
      '  feature: Feature',
      '  dependabot: Dependabot update',
      'projects:',
      '  todos  taylor/todos  /Users/me/git/todos',
      '    githubAccount: taylor',
      '    authors: OWNER',
      '    bots: dependabot[bot]',
      '    rules:',
      '      issue/impl → feature claude batch each delay 5m bootstrap skip  prompts/feature.claude.md present',
      '      pr/dependencies → dependabot codex batch together delay 30m bootstrap skip  prompts/dependabot.codex.md missing',
      '  catalog  acme-corp/catalog  /Users/me/git/catalog',
      '    githubAccount: acme-developer',
      '    authors: OWNER',
      '    bots: dependabot[bot]',
      '    rules:',
      '      issue/impl → feature claude batch each delay 5m bootstrap skip  prompts/feature.claude.md present',
      '  old (disabled)  taylor/old  /Users/me/git/old',
      '    githubAccount: taylor',
      '    authors: OWNER',
      '    bots: dependabot[bot]',
      '    rules:',
      '      issue/impl → feature claude batch each delay 5m bootstrap skip  prompts/feature.claude.md present',
    ])
  })
})

describe('buildMonitorModel: attention', () => {
  it('A15: failed stays in attention even after the tab is closed and points to checking the original problem', () => {
    const left = runWith({ id: '20261023-0900-7a44f0', phase: { kind: 'failed', at: secondsBefore(300), reason: 'AI reported failed: type error', tabClosed: false } })
    const closed = runWith({ id: '20261023-0800-c0ffee', phase: { kind: 'failed', at: secondsBefore(900), reason: 'result.json is invalid', tabClosed: true } })
    const model = modelOf(stateWith({ runs: [left, closed] }))
    expect(sectionsHolding(model, left.id)).toEqual(['attention'])
    expect(sectionsHolding(model, closed.id)).toEqual(['attention'])
    expect(rowsOf(model, 'attention').map((row) => row.hint)).toEqual(['→ orcapod incident 7a44f0', '→ orcapod incident c0ffee'])
    expect(titleOf(model, 'attention')).toBe('Attention 2')
  })

  it('A18: a starting run the daemon has not yet judged as stalled stays in running even after 10 minutes; with a starting-stall mark it goes to attention and points to the trust dialog', () => {
    const starting = runWith({ startedAt: secondsBefore(600), phase: { kind: 'starting', since: secondsBefore(600) } })
    const unjudged = modelOf(stateWith({ runs: [starting] }))
    expect(sectionsHolding(unjudged, starting.id)).toEqual(['active'])
    expect(titleOf(unjudged, 'attention')).toBe('Attention none')

    const stalled = modelOf(stateWith({ runs: [{ ...starting, notified: ['starting-stall'] }] }))
    expect(sectionsHolding(stalled, starting.id)).toEqual(['attention'])
    const [row] = rowsOf(stalled, 'attention')
    expect(row.hint).toBe('→ accept the trust dialog in the Orca tab')
    expect(cellsOf(row)).toEqual({ mark: '!', id: '3f9a1c', project: 'todos', title: '#123 Feature', phase: 'starting', note: 'slow to start', lastMessage: 'last: —', elapsed: '10m' })
  })

  it('A19: queued goes to attention only by the daemon mark (queued) and does not use the threshold even when the disk configuration is broken; without the mark it goes to pending/queue', () => {
    const queued = runWith({ startedAt: null, phase: { kind: 'queued', since: secondsBefore(600) } })
    const broken = configViewOf(brokenDisk, { loadedAt: secondsBefore(3600), sha256: SHA, error: 'config.yaml: not valid YAML' })

    const stalled = modelOf(stateWith({ runs: [{ ...queued, notified: ['queued'] }] }), { config: broken })
    expect(sectionsHolding(stalled, queued.id)).toEqual(['attention'])
    const [row] = rowsOf(stalled, 'attention')
    expect(row.hint).toBe('→ orcapod logs')
    expect(cellsOf(row)).toEqual({ mark: '!', id: '3f9a1c', project: 'todos', title: '#123 Feature', phase: 'queued', note: 'queue stalled', elapsed: '10m' })

    const unjudged = modelOf(stateWith({ runs: [queued] }), { config: broken })
    expect(sectionsHolding(unjudged, queued.id)).toEqual(['waiting'])
  })

  it('A20: even when the agent is working, waitingSince (question tool) puts it in attention prompting an answer; even when the agent is waiting, without waitingSince it stays running', () => {
    const asking = runWith({ id: '20261023-0910-1b2c3d', project: 'catalog', phase: { kind: 'running', agent: 'working', agentSince: secondsBefore(600), waitingSince: secondsBefore(240), closeAttempts: 0 } })
    const waitingAgent = runWith({ id: '20261023-0911-2c3d4e', phase: { kind: 'running', agent: 'waiting', agentSince: secondsBefore(30), closeAttempts: 0 } })
    const model = modelOf(stateWith({ runs: [asking, waitingAgent] }))
    expect(sectionsHolding(model, asking.id)).toEqual(['attention'])
    expect(sectionsHolding(model, waitingAgent.id)).toEqual(['active'])
    const [row] = rowsOf(model, 'attention')
    expect(row.hint).toBe('→ answer in the Orca tab')
    expect(cellsOf(row)).toEqual({ mark: '?', id: '1b2c3d', project: 'catalog', title: '#123 Feature', phase: 'running/working', note: 'waiting for input', lastMessage: 'last: —', elapsed: '4m' })
  })

  it('A21: loading a 001-shaped state.json (failed without tabClosed, orca present / null) with loadState shows both in attention and the header shows version unknown (001)', () => {
    const home = tempHome()
    mkdirSync(join(home, 'state'))
    const run001 = (id: string, orca: Run['orca']): unknown => ({
      ...runWith({ id, orca }),
      phase: { kind: 'failed', at: secondsBefore(600), reason: 'result.json is invalid' },
    })
    writeFileSync(join(home, 'state', 'state.json'), JSON.stringify({
      version: 1, processed: [], pending: [], watchedRules: [], lastPolledAt: {}, projectErrors: {}, orcaOutageSince: null, consumedRequests: [],
      runs: [
        run001('20261023-0800-aaaaaa', { handle: 'term-1', tabId: 'tab-1', paneKey: 'pane-1', ptyId: 'pty-1' }),
        run001('20261023-0801-bbbbbb', null),
      ],
    }))
    const model = modelOf(loadState(home))
    expect(rowsOf(model, 'attention').map((row) => row.hint)).toEqual(['→ orcapod incident aaaaaa', '→ orcapod incident bbbbbb'])
    expect(rowsOf(model, 'recent')).toEqual([])
    expect(model.header).toContainEqual({ text: 'Orca version unknown (daemon is the 001 version)', alert: false })
  })

  it('A22: shows the monitoring error of a project removed from the configuration and the failure of the previous cycle in attention', () => {
    const state = stateWith({
      projectErrors: { old_gone: { since: secondsBefore(7200), message: 'folder not found: /Users/me/git/old_gone' } },
      daemonInfo: { pid: 4242, startedAt: secondsBefore(7200), lastCycleAt: secondsBefore(3), lastCycleError: { at: secondsBefore(23), message: 'EACCES: permission denied' }, orcaVersion: '1.4.217', cycleSeconds: 20 },
    })
    expect(rowsOf(modelOf(state), 'attention')).toEqual([
      {
        ref: { kind: 'notice', key: 'project-error:old_gone' },
        cells: [{ column: 'mark', text: '!' }, { column: 'id', text: '-' }, { column: 'project', text: 'old_gone' }, { column: 'title', text: 'watch error' }, { column: 'note', text: 'folder not found: /Users/me/git/old_gone (since 2h 0m ago)' }],
        hint: '→ orcapod logs',
      },
      {
        ref: { kind: 'notice', key: 'cycle-error' },
        cells: [{ column: 'mark', text: '!' }, { column: 'id', text: '-' }, { column: 'project', text: 'daemon' }, { column: 'title', text: 'cycle failed' }, { column: 'note', text: 'daemon cycle failed (10-23 09:59): EACCES: permission denied' }],
        hint: '→ orcapod logs',
      },
    ])
  })

  it('shows the Orca outage and the daemon stop in attention', () => {
    const model = modelOf(stateWith({ orcaOutageSince: secondsBefore(120) }), { daemonPid: null, stateMtime: secondsBefore(300) })
    expect(rowsOf(model, 'attention').map((row) => [row.ref, cellsOf(row).project, cellsOf(row).title, cellsOf(row).note])).toEqual([
      [{ kind: 'notice', key: 'orca-outage' }, 'Orca', 'unreachable', 'since 10-23 09:58'],
      [{ kind: 'notice', key: 'daemon-stopped' }, 'daemon', 'stopped', 'daemon: stopped (updated 5m ago)'],
    ])
  })
})

describe('buildMonitorModel: section exclusivity and ordering', () => {
  it('A14: a running run waiting for input appears in attention as a single row even when the project has a monitoring error, and the monitoring error also appears as a separate row and in the projects section', () => {
    const asking = runWith({ phase: { kind: 'running', agent: 'waiting', agentSince: secondsBefore(60), waitingSince: secondsBefore(60), closeAttempts: 0 } })
    const model = modelOf(stateWith({ runs: [asking], projectErrors: { todos: { since: secondsBefore(60), message: 'HTTP 502' } } }))
    expect(sectionsHolding(model, asking.id)).toEqual(['attention'])
    expect(rowsOf(model, 'attention').map((row) => [row.ref, cellsOf(row).project, cellsOf(row).title])).toEqual([
      [{ kind: 'run', runId: asking.id }, 'todos', '#123 Feature'],
      [{ kind: 'notice', key: 'project-error:todos' }, 'todos', 'watch error'],
    ])
    expect(cellsOf(rowsOf(model, 'projects')[0]).note).toBe('taylor  not polled yet  watch error HTTP 502')
  })

  it('A16: building the same run as queued (marked) → starting → running makes it appear in exactly one section in each model', () => {
    const base = runWith({ startedAt: null, notified: ['queued'], phase: { kind: 'queued', since: secondsBefore(900) } })
    const phases: Run[] = [
      base,
      { ...base, notified: [], startedAt: secondsBefore(30), phase: { kind: 'starting', since: secondsBefore(30) } },
      { ...base, notified: [], startedAt: secondsBefore(30), phase: { kind: 'running', agent: 'working', agentSince: secondsBefore(5), closeAttempts: 0 } },
    ]
    expect(phases.map((run) => sectionsHolding(modelOf(stateWith({ runs: [run] })), run.id))).toEqual([['attention'], ['active'], ['active']])
  })

  it('A17: a manual running run and a queued run whose rule was removed from the configuration each appear in exactly one section', () => {
    const manual = runWith({ id: '20261023-0920-aaaaaa', manual: true })
    const orphan = runWith({ id: '20261023-0921-bbbbbb', rule: { ...featureRule, label: 'removed' }, startedAt: null, phase: { kind: 'queued', since: secondsBefore(60) } })
    const model = modelOf(stateWith({ runs: [manual, orphan] }))
    expect(sectionsHolding(model, manual.id)).toEqual(['active'])
    expect(sectionsHolding(model, orphan.id)).toEqual(['waiting'])
    expect(cellsOf(rowsOf(model, 'active')[0]).note).toBe('manual')
  })

  it('running rows carry elapsed time and the last response (— for Codex), and the heading shows per project running / limit including runs in attention', () => {
    const model = modelOf(stateWith({
      runs: [
        runWith({ lastMessage: 'adding tests and creating a PR' }),
        runWith({ id: '20261023-0918-4d5e6f', rule: dependabotRule, kindName: 'Dependabot update', items: [item(1, 'pr'), item(2, 'pr')], startedAt: secondsBefore(90), lastMessage: 'ignored' }),
        runWith({ id: '20261023-0919-1b2c3d', project: 'catalog', phase: { kind: 'running', agent: 'blocked', agentSince: secondsBefore(60), waitingSince: secondsBefore(60), closeAttempts: 0 } }),
        runWith({ id: '20261023-0920-0a0b0c', startedAt: null, phase: { kind: 'launching', since: secondsBefore(15) } }),
      ],
    }))
    expect(titleOf(model, 'active')).toBe('Running 3 (todos 3/2, catalog 1/2)')
    expect(rowsOf(model, 'active').map(cellsOf)).toEqual([
      { id: '3f9a1c', project: 'todos', title: '#123 Feature', phase: 'running/working', elapsed: '24m', lastMessage: 'last: adding tests and creating a PR' },
      { id: '4d5e6f', project: 'todos', title: 'Dependabot update ×2', phase: 'running/working', elapsed: '1m', lastMessage: 'last: —' },
      { id: '0a0b0c', project: 'todos', title: '#123 Feature', phase: 'launching', elapsed: '15s', lastMessage: 'last: —' },
    ])
  })

  it('pending/queue lists queued runs first, then pending entries in order of earliest launch, and shows remaining time, expiry, the batching mode, and rules removed from the configuration', () => {
    const model = modelOf(stateWith({
      runs: [runWith({ id: '20261023-0930-9c01de', project: 'catalog', startedAt: null, bypassLimit: true, phase: { kind: 'queued', since: secondsBefore(180) } })],
      pending: [
        { ruleKey: '["todos","issue","urgent"]', project: 'todos', items: [item(5)], fireAt: secondsBefore(-600) },
        { ruleKey: '["todos","pr","dependencies"]', project: 'todos', items: [item(1, 'pr'), item(2, 'pr')], fireAt: secondsBefore(-270) },
        { ruleKey: '["todos","issue","impl"]', project: 'todos', items: [item(7)], fireAt: secondsBefore(5) },
      ],
    }))
    expect(titleOf(model, 'waiting')).toBe('Pending / queue 4')
    expect(rowsOf(model, 'waiting').map((row) => [row.ref, cellsOf(row)])).toEqual([
      [{ kind: 'run', runId: '20261023-0930-9c01de' }, { id: '9c01de', project: 'catalog', title: '#123 Feature', phase: 'queued', elapsed: '3m', note: '--now' }],
      [{ kind: 'pending', ruleKey: '["todos","issue","impl"]' }, { id: '-', project: 'todos', title: 'issue/impl', phase: 'pending 1 item', elapsed: 'due (launches next cycle)' }],
      [{ kind: 'pending', ruleKey: '["todos","pr","dependencies"]' }, { id: '-', project: 'todos', title: 'pr/dependencies', phase: 'pending 2 items', elapsed: 'launches in 4m', note: 'batched' }],
      [{ kind: 'pending', ruleKey: '["todos","issue","urgent"]' }, { id: '-', project: 'todos', title: '["todos","issue","urgent"]', phase: 'pending 1 item', elapsed: 'launches in 10m', note: 'rule not in config, dropped when due' }],
    ])
  })

  it('recent results are done / aborted, unresolved failed stays in attention even after the tab is closed, and the history lists everything', () => {
    const model = modelOf(stateWith({
      runs: [
        runWith({ id: 'r-aaaaa1', phase: { kind: 'aborted', at: secondsBefore(1200), reason: 'orcapod stop' } }),
        runWith({ id: 'r-aaaaa2', phase: { kind: 'done', at: secondsBefore(300), summary: 'created PR #130', tabClosed: false } }),
        runWith({ id: 'r-aaaaa3', phase: { kind: 'failed', at: secondsBefore(600), reason: 'result.json is invalid', tabClosed: true } }),
        runWith({ id: 'r-aaaaa4', phase: { kind: 'failed', at: secondsBefore(60), reason: 'launch failed: spawn error', tabClosed: false, launchFailed: true } }),
      ],
    }))
    expect(rowsOf(model, 'recent').map((row) => cellsOf(row).phase)).toEqual([
      'done 10-23 09:55 "created PR #130" (tab remains)',
      'aborted 10-23 09:40 (orcapod stop)',
    ])
    expect(model.history.map((row) => row.ref)).toEqual([
      { kind: 'run', runId: 'r-aaaaa4' },
      { kind: 'run', runId: 'r-aaaaa2' },
      { kind: 'run', runId: 'r-aaaaa3' },
      { kind: 'run', runId: 'r-aaaaa1' },
    ])
  })

  it('the projects section shows every rule in the configuration one row each, with the account, last polling, disabled flag, and a rule summary', () => {
    const model = modelOf(stateWith({ lastPolledAt: { todos: secondsBefore(12) } }))
    expect(titleOf(model, 'projects')).toBe('Projects 3 / rules 4 (c for full config)')
    expect(rowsOf(model, 'projects').map((row) => [row.ref, cellsOf(row)])).toEqual([
      [{ kind: 'project', name: 'todos', ruleKey: ruleKey('todos', featureRule) }, { project: 'todos', note: 'taylor  poll 12s ago', rules: 'issue/impl→feature claude 5m' }],
      [{ kind: 'project', name: 'todos', ruleKey: ruleKey('todos', dependabotRule) }, { project: 'todos', note: 'taylor  poll 12s ago', rules: 'pr/dependencies→dependabot codex together 30m' }],
      [{ kind: 'project', name: 'catalog', ruleKey: ruleKey('catalog', featureRule) }, { project: 'catalog', note: 'acme-developer  not polled yet', rules: 'issue/impl→feature claude 5m' }],
      [{ kind: 'project', name: 'old', ruleKey: ruleKey('old', featureRule) }, { project: 'old', note: 'taylor  disabled', rules: 'issue/impl→feature claude 5m' }],
    ])
  })

  it('when the configuration cannot be read, the projects section is built from the keys of lastPolledAt and projectErrors, and the limit is ?', () => {
    const model = modelOf(stateWith({
      runs: [runWith({})],
      lastPolledAt: { todos: secondsBefore(75) },
      projectErrors: { gone: { since: secondsBefore(60), message: 'folder not found' } },
    }), { config: configViewOf(brokenDisk, null) })
    expect(rowsOf(model, 'projects').map(cellsOf)).toEqual([
      { project: 'todos', note: 'poll 1m ago' },
      { project: 'gone', note: 'not polled yet  watch error folder not found' },
    ])
    expect(titleOf(model, 'active')).toBe('Running 1 (todos 1/?)')
  })
})
