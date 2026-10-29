import { describe, expect, it } from 'vitest'
import { parseIssues } from '../src/github.ts'
import { buildMonitorModel } from '../src/monitor-model.ts'
import { applyClose, applyLaunch, tick } from '../src/tick.ts'
import { JAPANESE } from './helpers/japanese.ts'
import type { AgentObservation, AgentState, Config, Effect, HooksState, Item, Observations, OrcaRef, Project, Rule, Run, State, TerminalObservation } from '../src/types.ts'

const T0 = '2026-10-23T00:00:00.000Z'
const PATH = '/Users/alice/git/todos'
const IMPL: Rule = { target: 'issue', label: 'impl', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 5, enabled: true, bootstrap: 'skip' }
const IMPL_KEY = '["todos","issue","impl"]'
const DEPS: Rule = { target: 'pr', label: 'dependencies', kind: 'dependabot', ai: 'claude', batch: 'together', delayMinutes: 5, enabled: true, bootstrap: 'skip' }
const DEPS_KEY = '["todos","pr","dependencies"]'
const REF: OrcaRef = { handle: 'term_a', tabId: 'tab-a', paneKey: 'tab-a:leaf-a', ptyId: 'pty-a' }
const TERMINAL: TerminalObservation = { handle: 'term_a', tabId: 'tab-a', leafId: 'leaf-a', ptyId: 'pty-a', orphaned: false, title: '#123 Feature' }
const LABEL = 'run-a "#123 Feature"'

function at(minutes: number, seconds = 0): string {
  return new Date(Date.parse(T0) + minutes * 60_000 + seconds * 1000).toISOString()
}

function projectWith(overrides: Partial<Project> = {}): Project {
  return { name: 'todos', path: PATH, repo: 'alice/todos', githubAccount: 'taylor', enabled: true, authors: ['OWNER', 'MEMBER', 'COLLABORATOR'], bots: ['dependabot[bot]'], rules: [IMPL], ...overrides }
}

function configWith(projects: Project[] = [projectWith()], maxConcurrentPerProject = 2): Config {
  return {
    settings: {
      maxConcurrentPerProject,
      launch: { claude: 'claude --dangerously-skip-permissions', codex: 'codex --dangerously-bypass-approvals-and-sandbox' },
      notify: { desktop: true, waitingMinutes: 10, maxRunMinutes: 120, queuedMinutes: 30 },
    },
    kinds: [{ id: 'feature', name: 'Feature' }, { id: 'dependabot', name: 'Dependabot' }],
    projects,
    prompts: new Map([['feature.claude', '{{items}}'], ['dependabot.claude', '{{items}}']]),
  }
}

function issue(number: number, overrides: Partial<Item> = {}): Item {
  return {
    project: 'todos',
    repo: 'alice/todos',
    target: 'issue',
    number,
    title: `Title ${number}`,
    url: `https://github.com/alice/todos/issues/${number}`,
    labels: ['impl'],
    author: { login: 'alice', bot: false, association: 'OWNER' },
    ...overrides,
  }
}

function pr(number: number, author: Item['author'] = { login: 'alice', bot: false, association: 'OWNER' }): Item {
  return issue(number, { target: 'pr', url: `https://github.com/alice/todos/pull/${number}`, labels: ['dependencies'], author })
}

function stateWith(overrides: Partial<State> = {}): State {
  return { version: 1, processed: [], pending: [], runs: [], watchedRules: [IMPL_KEY], lastPolledAt: {}, projectErrors: {}, orcaOutageSince: null, consumedRequests: [], configStatus: null, daemonInfo: null, ...overrides }
}

interface OrcaView { agents?: AgentObservation[]; terminals?: TerminalObservation[]; complete?: boolean; hooks?: { enabled: boolean; agents: Record<'claude' | 'codex', HooksState> } | null }

function seen(view: OrcaView = {}): Observations['orca'] {
  const { agents = [], terminals = [TERMINAL], complete = true, hooks = null } = view
  return { ok: true, agents: new Map([[PATH, agents]]), terminals: new Map([[PATH, { terminals, complete }]]), hooks }
}

function obsAt(now: string, overrides: Partial<Observations> = {}): Observations {
  return { now, config: configWith(), github: {}, orca: { ok: true, agents: new Map(), terminals: new Map(), hooks: null }, results: {}, panes: {}, requests: [], ...overrides }
}

function agent(state: AgentState, stateSince: string, extra: Partial<AgentObservation> = {}): AgentObservation {
  return { paneKey: 'tab-a:leaf-a', state, stateSince, agentType: 'claude', toolName: null, lastAssistantMessage: null, ...extra }
}

function runWith(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-a',
    project: 'todos',
    target: { path: PATH, repo: 'alice/todos', githubAccount: 'taylor' },
    rule: IMPL,
    kindName: 'Feature',
    items: [issue(123)],
    createdAt: T0,
    startedAt: T0,
    phase: { kind: 'running', agent: 'working', agentSince: T0, closeAttempts: 0 },
    history: [],
    orca: REF,
    notified: [],
    bypassLimit: false,
    manual: false,
    lastMessage: null,
    ...overrides,
  }
}

function queuedRun(id: string, createdAt: string, overrides: Partial<Run> = {}): Run {
  return runWith({ id, createdAt, startedAt: null, phase: { kind: 'queued', since: createdAt }, history: [{ kind: 'queued', at: createdAt }], orca: null, ...overrides })
}

function resultFile(status: string, summary = 'Created PR #130'): string {
  return JSON.stringify({ status, summary, links: ['https://github.com/alice/todos/pull/130'] })
}

function onlyRun(state: State): Run {
  expect(state.runs).toHaveLength(1)
  return state.runs[0]
}

describe('detect', () => {
  it('a rule\'s authors only narrow the project\'s allowance, and dependency PRs are still detected from bots only as before', () => {
    const config = configWith([projectWith({ rules: [{ ...IMPL, label: '*', batch: 'together', bootstrap: 'process' }, { ...DEPS, authors: [], bootstrap: 'process' }] })])
    const { state } = tick(stateWith({ watchedRules: [] }), obsAt(T0, { config, github: { todos: { ok: true, items: [issue(1, { labels: [] }), pr(2), pr(3, { login: 'dependabot[bot]', bot: true, association: 'NONE' })] } } }))
    expect(state.pending.map((p) => p.items.map((i) => i.number))).toEqual([[1], [3]])
    const cannotWiden = configWith([projectWith({ authors: [], rules: [{ ...IMPL, label: '*', authors: ['OWNER'], bootstrap: 'process' }] })])
    const denied = tick(stateWith({ watchedRules: [] }), obsAt(T0, { config: cannotWiden, github: { todos: { ok: true, items: [issue(1)] } } }))
    expect(denied.state.pending).toEqual([])
    expect(denied.state.processed).toEqual([])
  })

  it.each(['pending', 'queued'] as const)('narrowing a rule\'s authors stops launching without relying on the past allowance in %s', (stage) => {
    const rule: Rule = { ...IMPL, label: '*', batch: 'together', bootstrap: 'process', delayMinutes: stage === 'pending' ? 5 : 0 }
    const config = configWith([projectWith({ rules: [rule] })])
    const first = tick(stateWith({ watchedRules: [] }), obsAt(T0, { config, github: { todos: { ok: true, items: [issue(1, { labels: [] })] } }, orca: { ok: false, error: 'offline' } }))
    if (stage === 'pending') expect(first.state.pending).toHaveLength(1)
    else expect(first.state.runs[0].phase.kind).toBe('queued')
    const restricted = configWith([projectWith({ rules: [{ ...rule, authors: [] }] })])
    const fired = tick(first.state, obsAt(at(5), { config: restricted }))
    expect(fired.state.pending).toEqual([])
    expect(fired.effects.filter((e) => e.type === 'launch')).toEqual([])
    if (stage === 'queued') expect(fired.state.runs[0].phase.kind).toBe('aborted')
  })

  it('label *: groups issues with no label or a different label, and excludes PRs and disallowed authors', () => {
    const rule: Rule = { ...IMPL, label: '*', batch: 'together', ai: 'codex', bootstrap: 'process' }
    const config = configWith([projectWith({ rules: [rule] })])
    const items = [issue(1, { labels: [] }), issue(2, { labels: ['bug'] }), pr(3), issue(4, { author: { login: 'stranger', bot: false, association: 'NONE' } })]
    const first = tick(stateWith({ watchedRules: [] }), obsAt(T0, { config, github: { todos: { ok: true, items } } }))
    expect(first.state.pending.map((p) => p.items.map((i) => i.number))).toEqual([[1, 2]])
    expect(first.state.processed.map((p) => p.key)).toEqual(['["todos","issue",1,"*"]', '["todos","issue",2,"*"]'])
    const fired = tick(first.state, obsAt(at(5), { config }))
    expect(fired.state.runs.map((r) => [r.rule.ai, r.items.map((i) => i.number)])).toEqual([['codex', [1, 2]]])
    expect(fired.effects.filter((e) => e.type === 'launch')).toHaveLength(1)
  })

  it('label *: skips existing issues on first watch, extends pending on new arrivals, and does not fire again on a label change', () => {
    const config = configWith([projectWith({ rules: [{ ...IMPL, label: '*', batch: 'together' }] })])
    const poll = (items: Item[]) => ({ todos: { ok: true as const, items } })
    const first = tick(stateWith({ watchedRules: [] }), obsAt(T0, { config, github: poll([issue(1, { labels: [] })]) }))
    expect(first.state.pending).toEqual([])
    expect(first.state.runs).toEqual([])
    const next = tick(first.state, obsAt(at(1), { config, github: poll([issue(1), issue(2, { labels: [] })]) }))
    expect(next.state.pending[0].fireAt).toBe(at(6))
    const more = tick(next.state, obsAt(at(4), { config, github: poll([issue(1), issue(2), issue(3, { labels: ['bug'] })]) }))
    expect(more.state.pending[0].fireAt).toBe(at(9))
    const waiting = tick(more.state, obsAt(at(6), { config }))
    expect(waiting.state.runs).toEqual([])
    const fired = tick(waiting.state, obsAt(at(9), { config }))
    expect(fired.state.runs.map((r) => r.items.map((i) => i.number))).toEqual([[2, 3]])
    const repeated = tick(fired.state, obsAt(at(10), { config, github: poll([issue(1), issue(2, { labels: [] }), issue(3, { labels: [] })]) }))
    expect(repeated.state.pending).toEqual([])
    expect(repeated.state.runs).toHaveLength(1)
  })

  it('label *: does not launch when the author\'s allowance is removed while pending', () => {
    const rule: Rule = { ...IMPL, label: '*', batch: 'together', bootstrap: 'process' }
    const config = configWith([projectWith({ rules: [rule] })])
    const first = tick(stateWith({ watchedRules: [] }), obsAt(T0, { config, github: { todos: { ok: true, items: [issue(1, { labels: [] })] } } }))
    const narrowed = configWith([projectWith({ rules: [rule], authors: [] })])
    const fired = tick(first.state, obsAt(at(5), { config: narrowed }))
    expect(fired.state.pending).toEqual([])
    expect(fired.state.runs).toEqual([])
    expect(fired.effects.filter((e) => e.type === 'launch')).toEqual([])
  })

  it('C1: even when the gh response returns an item with label "Impl " in cycle 1 and "impl" in cycle 2, there is 1 pending item and 1 processed item (input passed through parseIssues)', () => {
    const response = (labelName: string) => [[{ number: 123, title: 'Title 123', html_url: 'https://github.com/alice/todos/issues/123', labels: [{ name: labelName }], user: { login: 'alice', type: 'User' }, author_association: 'OWNER' }]]
    const github = (labelName: string) => ({ todos: { ok: true as const, items: parseIssues(response(labelName), 'todos', 'alice/todos') } })
    const first = tick(stateWith(), obsAt(T0, { github: github('Impl ') }))
    expect(first.state.pending).toEqual([{ ruleKey: IMPL_KEY, project: 'todos', items: [issue(123)], fireAt: '2026-10-23T00:05:00.000Z' }])
    const second = tick(first.state, obsAt(at(1), { github: github('impl') }))
    const third = tick(second.state, obsAt(at(2), { github: github('IMPL') }))
    expect([second.effects, third.effects]).toEqual([[], []])
    expect(third.state.pending).toEqual([{ ruleKey: IMPL_KEY, project: 'todos', items: [issue(123)], fireAt: '2026-10-23T00:05:00.000Z' }])
    expect(third.state.processed).toEqual([{ key: '["todos","issue",123,"impl"]', seenAt: '2026-10-23T00:00:00.000Z' }])
    expect(third.state.runs).toEqual([])
  })

  it('C1: normalizes case and surrounding whitespace of the rule label, and returning the same item in cycle 2 leaves 1 pending and 1 processed', () => {
    const first = tick(stateWith(), obsAt(T0, { config: configWith([projectWith({ rules: [{ ...IMPL, label: ' Impl ' }] })]), github: { todos: { ok: true, items: [issue(123)] } } }))
    expect(first.effects).toEqual([{ type: 'log', level: 'info', message: 'detected todos / issue / impl: #123 → launches at 2026-10-23T00:05:00.000Z' }])
    const second = tick(first.state, obsAt(at(1), { github: { todos: { ok: true, items: [issue(123)] } } }))
    expect(second.effects).toEqual([])
    expect(second.state.processed).toEqual([{ key: '["todos","issue",123,"impl"]', seenAt: '2026-10-23T00:00:00.000Z' }])
    expect(second.state.pending).toEqual([{ ruleKey: '["todos","issue","impl"]', project: 'todos', items: [issue(123)], fireAt: '2026-10-23T00:05:00.000Z' }])
    expect(second.state.watchedRules).toEqual(['["todos","issue","impl"]'])
  })

  it('C2: returning the same item to a rule with delay 0 for 3 consecutive cycles creates only 1 run', () => {
    const config = configWith([projectWith({ rules: [{ ...IMPL, delayMinutes: 0 }] })])
    const polled = { todos: { ok: true as const, items: [issue(123)] } }
    const first = tick(stateWith(), obsAt(T0, { config, github: polled }))
    expect(first.effects).toEqual([
      { type: 'log', level: 'info', message: 'detected todos / issue / impl: #123 → launches at 2026-10-23T00:00:00.000Z' },
      { type: 'launch', runId: '20261023-0000-cc57bf' },
    ])
    const second = tick(first.state, obsAt(at(1), { config, github: polled }))
    const third = tick(second.state, obsAt(at(2), { config, github: polled }))
    expect(second.effects).toEqual([])
    expect(third.effects).toEqual([])
    expect(third.state.runs.map((r) => [r.id, r.phase.kind])).toEqual([['20261023-0000-cc57bf', 'launching']])
  })

  it('C3: when one item matches 2 rules, 2 runs are created', () => {
    const urgent: Rule = { ...IMPL, label: 'urgent', delayMinutes: 0 }
    const config = configWith([projectWith({ rules: [{ ...IMPL, delayMinutes: 0 }, urgent] })])
    const { state } = tick(stateWith({ watchedRules: [IMPL_KEY, '["todos","issue","urgent"]'] }), obsAt(T0, { config, github: { todos: { ok: true, items: [issue(123, { labels: ['impl', 'urgent'] })] } } }))
    expect(state.runs.map((r) => [r.id, r.rule.label, r.items.map((i) => i.number)])).toEqual([
      ['20261023-0000-cc57bf', 'impl', [123]],
      ['20261023-0000-f5df1a', 'urgent', [123]],
    ])
    expect(state.processed.map((p) => p.key)).toEqual(['["todos","issue",123,"impl"]', '["todos","issue",123,"urgent"]'])
  })

  it('C4: for a rule watched for the first time with bootstrap skip, 3 matches are marked processed and nothing is launched', () => {
    const { state, effects } = tick(stateWith({ watchedRules: [] }), obsAt(T0, { github: { todos: { ok: true, items: [issue(1), issue(2), issue(3)] } } }))
    expect(effects).toEqual([{ type: 'log', level: 'info', message: 'first watch of todos / issue / impl: 3 matched, marked as processed' }])
    expect(state.runs).toEqual([])
    expect(state.pending).toEqual([])
    expect(state.processed.map((p) => p.key)).toEqual(['["todos","issue",1,"impl"]', '["todos","issue",2,"impl"]', '["todos","issue",3,"impl"]'])
    expect(state.watchedRules).toEqual(['["todos","issue","impl"]'])
  })

  it('C4: for a rule watched for the first time with bootstrap process, all 3 enter pending', () => {
    const config = configWith([projectWith({ rules: [{ ...IMPL, bootstrap: 'process' }] })])
    const { state, effects } = tick(stateWith({ watchedRules: [] }), obsAt(T0, { config, github: { todos: { ok: true, items: [issue(1), issue(2), issue(3)] } } }))
    expect(effects).toEqual([{ type: 'log', level: 'info', message: 'detected todos / issue / impl: #1,#2,#3 → launches at 2026-10-23T00:05:00.000Z' }])
    expect(state.pending).toEqual([{ ruleKey: '["todos","issue","impl"]', project: 'todos', items: [issue(1), issue(2), issue(3)], fireAt: '2026-10-23T00:05:00.000Z' }])
    expect(state.watchedRules).toEqual(['["todos","issue","impl"]'])
  })

  it('C5: an already processed item does not fire when its label is removed and re-added', () => {
    const start = stateWith({ processed: [{ key: '["todos","issue",123,"impl"]', seenAt: T0 }] })
    const gone = tick(start, obsAt(at(1), { github: { todos: { ok: true, items: [issue(123, { labels: [] })] } } }))
    const back = tick(gone.state, obsAt(at(2), { github: { todos: { ok: true, items: [issue(123)] } } }))
    expect([gone.effects, back.effects]).toEqual([[], []])
    expect(back.state.pending).toEqual([])
    expect(back.state.runs).toEqual([])
    expect(back.state.processed).toEqual([{ key: '["todos","issue",123,"impl"]', seenAt: '2026-10-23T00:00:00.000Z' }])
  })

  it('C6 / C45: an item matching a rule with enabled: false enters neither processed nor pending, and is detected on re-enabling without being treated as first watch', () => {
    const disabled = tick(stateWith(), obsAt(T0, { config: configWith([projectWith({ rules: [{ ...IMPL, enabled: false }] })]), github: { todos: { ok: true, items: [issue(1)] } } }))
    expect(disabled.effects).toEqual([])
    expect(disabled.state.processed).toEqual([])
    expect(disabled.state.pending).toEqual([])
    const enabled = tick(disabled.state, obsAt(at(1), { github: { todos: { ok: true, items: [issue(1), issue(2)] } } }))
    expect(enabled.effects).toEqual([{ type: 'log', level: 'info', message: 'detected todos / issue / impl: #1,#2 → launches at 2026-10-23T00:06:00.000Z' }])
    expect(enabled.state.pending).toEqual([{ ruleKey: '["todos","issue","impl"]', project: 'todos', items: [issue(1), issue(2)], fireAt: '2026-10-23T00:06:00.000Z' }])
  })

  it('C44: only allowed authors (OWNER humans and dependabot) enter pending, and excluded items do not enter processed either', () => {
    const none = issue(2, { author: { login: 'stranger', bot: false, association: 'NONE' } })
    const dependabot = issue(3, { author: { login: 'dependabot[bot]', bot: true, association: 'NONE' } })
    const actions = issue(4, { author: { login: 'github-actions[bot]', bot: true, association: 'NONE' } })
    const first = tick(stateWith(), obsAt(T0, { github: { todos: { ok: true, items: [issue(1), none, dependabot, actions] } } }))
    expect(first.state.pending).toEqual([{ ruleKey: '["todos","issue","impl"]', project: 'todos', items: [issue(1), dependabot], fireAt: '2026-10-23T00:05:00.000Z' }])
    expect(first.state.processed.map((p) => p.key)).toEqual(['["todos","issue",1,"impl"]', '["todos","issue",3,"impl"]'])

    const promoted = issue(2, { author: { login: 'stranger', bot: false, association: 'COLLABORATOR' } })
    const second = tick(first.state, obsAt(at(1), { github: { todos: { ok: true, items: [issue(1), promoted, dependabot, actions] } } }))
    expect(second.effects).toEqual([{ type: 'log', level: 'info', message: 'detected todos / issue / impl: #2 → launches at 2026-10-23T00:06:00.000Z' }])
    expect(second.state.pending).toEqual([{ ruleKey: '["todos","issue","impl"]', project: 'todos', items: [issue(1), dependabot, promoted], fireAt: '2026-10-23T00:06:00.000Z' }])
  })

  it('C44: with authors: [] and bots: [], all items are excluded, and no notification or log is emitted', () => {
    const config = configWith([projectWith({ authors: [], bots: [] })])
    const items = [issue(1), issue(3, { author: { login: 'dependabot[bot]', bot: true, association: 'NONE' } })]
    const { state, effects } = tick(stateWith(), obsAt(T0, { config, github: { todos: { ok: true, items } } }))
    expect(effects).toEqual([])
    expect(state.processed).toEqual([])
    expect(state.pending).toEqual([])
  })

  it('C54: even with authors: [NONE], an item whose association is UNKNOWN is not detected', () => {
    const config = configWith([projectWith({ authors: ['NONE'] })])
    const unknown = issue(1, { author: { login: '', bot: false, association: 'UNKNOWN' } })
    const { state, effects } = tick(stateWith(), obsAt(T0, { config, github: { todos: { ok: true, items: [unknown] } } }))
    expect(effects).toEqual([])
    expect(state.processed).toEqual([])
  })

  it('C22: even when GitHub errors continue for 3 cycles there is 1 notification, and the entry disappears from projectErrors on recovery', () => {
    const failing = { todos: { ok: false as const, error: 'gh api failed: HTTP 401' } }
    const first = tick(stateWith(), obsAt(T0, { github: failing }))
    const second = tick(first.state, obsAt(at(1), { github: failing }))
    const third = tick(second.state, obsAt(at(2), { github: failing }))
    expect(first.effects).toEqual([{ type: 'notify', key: 'project-error:todos', title: 'orcapod: watch error', message: 'todos: gh api failed: HTTP 401' }])
    expect([second.effects, third.effects]).toEqual([[], []])
    expect(third.state.projectErrors).toEqual({ todos: { since: '2026-10-23T00:00:00.000Z', message: 'gh api failed: HTTP 401' } })
    const recovered = tick(third.state, obsAt(at(3), { github: { todos: { ok: true, items: [] } } }))
    expect(recovered.effects).toEqual([{ type: 'log', level: 'info', message: 'watch error cleared: todos' }])
    expect(recovered.state.projectErrors).toEqual({})
  })

  it('X1-6: in parseIssues, an item with user null, an empty login, or no type becomes UNKNOWN and is not detected even with authors: [NONE]', () => {
    const raw = (number: number, user: unknown) => ({ number, title: `Title ${number}`, html_url: `https://github.com/alice/todos/issues/${number}`, labels: [{ name: 'impl' }], user, author_association: 'NONE' })
    const items = parseIssues([[raw(1, null), raw(2, { login: '', type: 'User' }), raw(3, { login: 'ghost' }), raw(4, { login: 'bob', type: 'User' })]], 'todos', 'alice/todos')
    const config = configWith([projectWith({ authors: ['NONE'] })])
    const { state, effects } = tick(stateWith(), obsAt(T0, { config, github: { todos: { ok: true, items } } }))
    expect(effects).toEqual([{ type: 'log', level: 'info', message: 'detected todos / issue / impl: #4 → launches at 2026-10-23T00:05:00.000Z' }])
    expect(state.processed.map((p) => p.key)).toEqual(['["todos","issue",4,"impl"]'])
  })

  it('X1-10: even when the project name is __proto__ / constructor, lastPolledAt and projectErrors go into its own keys and disappear on recovery', () => {
    const named = (name: string) => projectWith({ name, path: `/Users/alice/git/${name}`, repo: `alice/${name}` })
    const config = configWith([named('__proto__'), named('constructor')])
    const failing = { ok: false as const, error: 'HTTP 500' }
    const first = tick(stateWith(), obsAt(T0, { config, github: { ['__proto__']: failing, constructor: failing } }))
    expect(Object.entries(first.state.lastPolledAt)).toEqual([['__proto__', '2026-10-23T00:00:00.000Z'], ['constructor', '2026-10-23T00:00:00.000Z']])
    expect(Object.entries(first.state.projectErrors)).toEqual([['__proto__', { since: '2026-10-23T00:00:00.000Z', message: 'HTTP 500' }], ['constructor', { since: '2026-10-23T00:00:00.000Z', message: 'HTTP 500' }]])
    expect(first.effects).toEqual([
      { type: 'notify', key: 'project-error:__proto__', title: 'orcapod: watch error', message: '__proto__: HTTP 500' },
      { type: 'notify', key: 'project-error:constructor', title: 'orcapod: watch error', message: 'constructor: HTTP 500' },
    ])
    const recovered = tick(first.state, obsAt(at(1), { config, github: { ['__proto__']: { ok: true as const, items: [] }, constructor: { ok: true as const, items: [] } } }))
    expect(recovered.effects).toEqual([
      { type: 'log', level: 'info', message: 'watch error cleared: __proto__' },
      { type: 'log', level: 'info', message: 'first watch of __proto__ / issue / impl: 0 matched, marked as processed' },
      { type: 'log', level: 'info', message: 'watch error cleared: constructor' },
      { type: 'log', level: 'info', message: 'first watch of constructor / issue / impl: 0 matched, marked as processed' },
    ])
    expect(Object.entries(recovered.state.projectErrors)).toEqual([])
  })

  it('X1-10: the unwatched project toString does not pull from the prototype of obs.github, and becomes neither an error nor watched', () => {
    const config = configWith([projectWith({ name: 'toString', path: '/Users/alice/git/toString', repo: 'alice/toString' })])
    const { state, effects } = tick(stateWith({ watchedRules: [] }), obsAt(T0, { config, github: {} }))
    expect([effects, state.lastPolledAt, state.projectErrors, state.watchedRules]).toEqual([[], {}, {}, []])
  })

  it('C51: only projects present in obs.github get lastPolledAt set to now', () => {
    const start = stateWith({ lastPolledAt: { todos: T0, other: T0 } })
    const { state } = tick(start, obsAt(at(1), { github: { todos: { ok: true, items: [] } } }))
    expect(state.lastPolledAt).toEqual({ todos: '2026-10-23T00:01:00.000Z', other: '2026-10-23T00:00:00.000Z' })
  })
})

describe('fire', () => {
  it('C7: with together and a 5-minute delay, detecting 1 item at t0 and 1 at t0+3 minutes makes 1 run with 2 items at t0+8 minutes', () => {
    const config = configWith([projectWith({ rules: [DEPS] })])
    const start = stateWith({ watchedRules: [DEPS_KEY] })
    const t0 = tick(start, obsAt(T0, { config, github: { todos: { ok: true, items: [pr(1)] } } }))
    const t3 = tick(t0.state, obsAt(at(3), { config, github: { todos: { ok: true, items: [pr(1), pr(2)] } } }))
    expect(t3.state.pending).toEqual([{ ruleKey: '["todos","pr","dependencies"]', project: 'todos', items: [pr(1), pr(2)], fireAt: '2026-10-23T00:08:00.000Z' }])
    const t5 = tick(t3.state, obsAt(at(5), { config }))
    expect(t5.effects).toEqual([])
    expect(t5.state.runs).toEqual([])
    const t8 = tick(t5.state, obsAt(at(8), { config }))
    expect(t8.effects).toEqual([{ type: 'launch', runId: '20261023-0008-58ebb6' }])
    expect(t8.state.pending).toEqual([])
    const run = onlyRun(t8.state)
    expect([run.rule, run.kindName, run.items, run.manual, run.phase]).toEqual([DEPS, 'Dependabot', [pr(1), pr(2)], false, { kind: 'launching', since: '2026-10-23T00:08:00.000Z' }])
  })

  it('C8: a new detection arriving in the expiry cycle does not launch and extends fireAt', () => {
    const start = stateWith({
      processed: [{ key: '["todos","issue",1,"impl"]', seenAt: T0 }],
      pending: [{ ruleKey: IMPL_KEY, project: 'todos', items: [issue(1)], fireAt: at(5) }],
    })
    const { state, effects } = tick(start, obsAt(at(5), { github: { todos: { ok: true, items: [issue(1), issue(2)] } } }))
    expect(effects).toEqual([{ type: 'log', level: 'info', message: 'detected todos / issue / impl: #2 → launches at 2026-10-23T00:10:00.000Z' }])
    expect(state.runs).toEqual([])
    expect(state.pending).toEqual([{ ruleKey: '["todos","issue","impl"]', project: 'todos', items: [issue(1), issue(2)], fireAt: '2026-10-23T00:10:00.000Z' }])
  })

  it('C9: delay 0 makes a queued run in the same cycle as detection (no launch because Orca is not visible)', () => {
    const config = configWith([projectWith({ rules: [{ ...IMPL, delayMinutes: 0 }] })])
    const { state } = tick(stateWith(), obsAt(T0, { config, github: { todos: { ok: true, items: [issue(9)] } }, orca: { ok: false, error: 'down' } }))
    const run = onlyRun(state)
    expect([run.id, run.phase, run.history, run.items]).toEqual(['20261023-0000-4223c3', { kind: 'queued', since: '2026-10-23T00:00:00.000Z' }, [{ kind: 'queued', at: '2026-10-23T00:00:00.000Z' }], [issue(9)]])
  })

  it('C10: pending whose fireAt became past due to a restart is launched in the next cycle', () => {
    const start = stateWith({ pending: [{ ruleKey: IMPL_KEY, project: 'todos', items: [issue(1)], fireAt: at(5) }] })
    const { state, effects } = tick(start, obsAt(at(90)))
    expect(effects).toEqual([{ type: 'launch', runId: '20261023-0130-15f3aa' }])
    expect(state.pending).toEqual([])
    expect(onlyRun(state).target).toEqual({ path: '/Users/alice/git/todos', repo: 'alice/todos', githubAccount: 'taylor' })
  })

  it('C32: 2 pending items of each become 2 runs with different IDs in the same cycle', () => {
    const start = stateWith({ pending: [{ ruleKey: IMPL_KEY, project: 'todos', items: [issue(1), issue(2)], fireAt: T0 }] })
    const { state } = tick(start, obsAt(T0))
    expect(state.runs.map((r) => [r.id, r.items.map((i) => i.number)])).toEqual([
      ['20261023-0000-15f3aa', [1]],
      ['20261023-0000-9d5b75', [2]],
    ])
  })

  it('C53: when authors / bots are emptied while pending, no run is created at expiry and the pending is discarded', () => {
    const start = stateWith({ pending: [{ ruleKey: IMPL_KEY, project: 'todos', items: [issue(7)], fireAt: at(5) }] })
    const { state, effects } = tick(start, obsAt(at(6), { config: configWith([projectWith({ authors: [], bots: [] })]) }))
    expect(effects).toEqual([{ type: 'log', level: 'info', message: 'pending ["todos","issue","impl"]: dropped #7 (author no longer allowed)' }])
    expect(state.pending).toEqual([])
    expect(state.runs).toEqual([])
  })

  it('C54: when the configuration repo changes while pending, items of the original repo are discarded at firing', () => {
    const fromA = issue(7, { repo: 'alice/A' })
    const start = stateWith({ pending: [{ ruleKey: IMPL_KEY, project: 'todos', items: [fromA], fireAt: at(5) }] })
    const { state, effects } = tick(start, obsAt(at(6), { config: configWith([projectWith({ repo: 'bob/B' })]) }))
    expect(effects).toEqual([{ type: 'log', level: 'info', message: 'pending ["todos","issue","impl"]: dropped #7 (author no longer allowed)' }])
    expect(state.pending).toEqual([])
    expect(state.runs).toEqual([])
  })

  it('X1-2: when the author of a pending item becomes NONE in the latest response, it is removed at expiry and no run is created', () => {
    const processed = [{ key: '["todos","issue",7,"impl"]', seenAt: T0 }]
    const start = stateWith({ processed, pending: [{ ruleKey: IMPL_KEY, project: 'todos', items: [issue(7)], fireAt: at(5) }] })
    const demoted = issue(7, { author: { login: 'alice', bot: false, association: 'NONE' } })
    const { state, effects } = tick(start, obsAt(at(6), { github: { todos: { ok: true, items: [demoted] } } }))
    expect(effects).toEqual([{ type: 'log', level: 'info', message: 'pending ["todos","issue","impl"]: dropped #7 (author no longer allowed)' }])
    expect([state.pending, state.runs, state.processed]).toEqual([[], [], processed])
  })

  it('X1-2: authors are not changed for a pending item absent from the response or for an item with the same number in another repo', () => {
    const start = stateWith({ pending: [{ ruleKey: IMPL_KEY, project: 'todos', items: [issue(7), issue(8)], fireAt: at(10) }] })
    const otherRepo = issue(7, { repo: 'alice/fork', author: { login: 'mallory', bot: false, association: 'NONE' } })
    const { state } = tick(start, obsAt(at(1), { github: { todos: { ok: true, items: [otherRepo] } } }))
    expect(state.pending).toEqual([{ ruleKey: IMPL_KEY, project: 'todos', items: [issue(7), issue(8)], fireAt: '2026-10-23T00:10:00.000Z' }])
  })

  it('pending of a rule removed from the configuration is discarded with a warn, and pending of a disabled rule is kept', () => {
    const start = stateWith({ pending: [
      { ruleKey: '["todos","issue","gone"]', project: 'todos', items: [issue(1)], fireAt: T0 },
      { ruleKey: IMPL_KEY, project: 'todos', items: [issue(2)], fireAt: T0 },
    ] })
    const { state, effects } = tick(start, obsAt(at(1), { config: configWith([projectWith({ rules: [{ ...IMPL, enabled: false }] })]) }))
    expect(effects).toEqual([{ type: 'log', level: 'warn', message: 'rule ["todos","issue","gone"] is not in the config; dropped pending #1' }])
    expect(state.pending).toEqual([{ ruleKey: '["todos","issue","impl"]', project: 'todos', items: [issue(2)], fireAt: '2026-10-23T00:00:00.000Z' }])
    expect(state.runs).toEqual([])
  })

  it('C49: a project in monitoring error launches neither expired pending nor queued (including bypassLimit), other projects launch, and it launches in the recovery cycle', () => {
    const other = projectWith({ name: 'other', path: '/Users/alice/git/other', repo: 'alice/other' })
    const config = configWith([projectWith(), other])
    const otherItem = issue(5, { project: 'other', repo: 'alice/other' })
    const start = stateWith({
      watchedRules: [IMPL_KEY, '["other","issue","impl"]'],
      processed: [{ key: '["other","issue",5,"impl"]', seenAt: T0 }],
      pending: [
        { ruleKey: IMPL_KEY, project: 'todos', items: [issue(1)], fireAt: T0 },
        { ruleKey: '["other","issue","impl"]', project: 'other', items: [otherItem], fireAt: T0 },
      ],
      runs: [queuedRun('run-q', T0, { bypassLimit: true, manual: true })],
    })
    const missing = { todos: { ok: false as const, error: 'folder not found: /Users/alice/git/todos' }, other: { ok: true as const, items: [otherItem] } }
    const first = tick(start, obsAt(at(1), { config, github: missing }))
    const second = tick(first.state, obsAt(at(2), { config, github: missing }))
    expect(first.effects).toEqual([
      { type: 'notify', key: 'project-error:todos', title: 'orcapod: watch error', message: 'todos: folder not found: /Users/alice/git/todos' },
      { type: 'launch', runId: '20261023-0001-6bce17' },
    ])
    expect(second.effects).toEqual([])
    expect(second.state.pending.map((p) => p.ruleKey)).toEqual(['["todos","issue","impl"]'])
    expect(second.state.runs.map((r) => [r.id, r.project, r.phase.kind])).toEqual([['run-q', 'todos', 'queued'], ['20261023-0001-6bce17', 'other', 'launching']])

    const recovered = tick(second.state, obsAt(at(3), { config, github: { todos: { ok: true, items: [] }, other: { ok: true, items: [otherItem] } } }))
    expect(recovered.effects).toEqual([
      { type: 'log', level: 'info', message: 'watch error cleared: todos' },
      { type: 'launch', runId: 'run-q' },
      { type: 'launch', runId: '20261023-0003-15f3aa' },
    ])
    expect(recovered.state.projectErrors).toEqual({})
    expect(recovered.state.pending).toEqual([])
  })
})

describe('schedule', () => {
  it('C11: with limit 2 and 3 queued, 2 become launching in creation order, and the rest launch in the cycle after one becomes done', () => {
    const start = stateWith({ runs: [queuedRun('run-3', at(2)), queuedRun('run-1', T0), queuedRun('run-2', at(1))] })
    const first = tick(start, obsAt(at(3)))
    expect(first.effects).toEqual([{ type: 'launch', runId: 'run-1' }, { type: 'launch', runId: 'run-2' }])
    expect(first.state.runs.map((r) => [r.id, r.phase])).toEqual([
      ['run-3', { kind: 'queued', since: '2026-10-23T00:02:00.000Z' }],
      ['run-1', { kind: 'launching', since: '2026-10-23T00:03:00.000Z' }],
      ['run-2', { kind: 'launching', since: '2026-10-23T00:03:00.000Z' }],
    ])
    const afterDone = { ...first.state, runs: first.state.runs.map((r) => (r.id === 'run-1' ? { ...r, phase: { kind: 'done' as const, at: at(4), summary: '', tabClosed: true } } : r)) }
    const second = tick(afterDone, obsAt(at(4)))
    expect(second.effects).toEqual([{ type: 'launch', runId: 'run-3' }])
  })

  it('C12: while Orca is not visible, queued is not launched and phase is unchanged, and the outage notification occurs only in the first cycle', () => {
    const start = stateWith({ runs: [queuedRun('run-q', T0), runWith()] })
    const down = { ok: false as const, error: 'orca worktree ps: exec_failed' }
    const first = tick(start, obsAt(at(1), { orca: down }))
    expect(first.effects).toEqual([{ type: 'notify', key: 'orca-outage', title: 'orcapod: Orca unreachable', message: 'orca worktree ps: exec_failed' }])
    expect(first.state.runs).toEqual(start.runs)
    expect(first.state.orcaOutageSince).toBe('2026-10-23T00:01:00.000Z')
    const second = tick(first.state, obsAt(at(2), { orca: down }))
    expect(second.effects).toEqual([])
    expect(second.state.orcaOutageSince).toBe('2026-10-23T00:01:00.000Z')
    const back = tick(second.state, obsAt(at(3), { orca: seen({ agents: [agent('working', T0)] }) }))
    expect(back.state.orcaOutageSince).toBeNull()
    expect(back.effects).toEqual([{ type: 'launch', runId: 'run-q' }, { type: 'log', level: 'info', message: 'reconnected to Orca' }])
  })

  it('C13: a bypassLimit run launches even when limit is 1 and 1 running exists', () => {
    const start = stateWith({ runs: [runWith(), queuedRun('run-now', T0, { bypassLimit: true, manual: true }), queuedRun('run-wait', T0)] })
    const { effects } = tick(start, obsAt(at(1), { config: configWith([projectWith()], 1), orca: seen({ agents: [agent('working', T0)] }) }))
    expect(effects).toEqual([{ type: 'launch', runId: 'run-now' }])
  })

  it('C53: a together queued run does not become launching when all authors are removed, and is aborted with a notification', () => {
    const items = [pr(7), pr(8)]
    const start = stateWith({ runs: [queuedRun('run-a', T0, { rule: DEPS, kindName: 'Dependabot', items })] })
    const { state, effects } = tick(start, obsAt(at(1), { config: configWith([projectWith({ authors: [], bots: [], rules: [DEPS] })]) }))
    expect(effects).toEqual([
      { type: 'log', level: 'info', message: 'run run-a: dropped #7,#8 (author no longer allowed)' },
      { type: 'notify', key: 'aborted:run-a', title: 'orcapod: aborted', message: 'run-a "Dependabot ×2": author no longer allowed' },
    ])
    const run = onlyRun(state)
    expect([run.phase, run.lastMessage, run.items]).toEqual([{ kind: 'aborted', at: '2026-10-23T00:01:00.000Z', reason: 'author no longer allowed' }, 'author no longer allowed', [pr(7), pr(8)]])
  })

  it('C53: when only some authors are removed, items are reduced accordingly and the run becomes launching', () => {
    const items = [pr(7), pr(8, { login: 'bob', bot: false, association: 'COLLABORATOR' })]
    const start = stateWith({ runs: [queuedRun('run-a', T0, { rule: DEPS, kindName: 'Dependabot', items })] })
    const { state, effects } = tick(start, obsAt(at(1), { config: configWith([projectWith({ authors: ['OWNER'], rules: [DEPS] })]) }))
    expect(effects).toEqual([
      { type: 'log', level: 'info', message: 'run run-a: dropped #8 (author no longer allowed)' },
      { type: 'launch', runId: 'run-a' },
    ])
    expect(onlyRun(state).items).toEqual([pr(7)])
  })

  it('C53: a run created by orcapod run / rerun (manual) becomes launching even with authors: []', () => {
    const start = stateWith({ runs: [queuedRun('run-a', T0, { manual: true })] })
    const { state, effects } = tick(start, obsAt(at(1), { config: configWith([projectWith({ authors: [], bots: [] })]) }))
    expect(effects).toEqual([{ type: 'launch', runId: 'run-a' }])
    expect(onlyRun(state).items).toEqual([issue(123)])
  })

  it('X1-2: an automatic queued run whose author becomes NONE in the latest response does not become launching and is aborted with a notification, while a manual run does not change authors', () => {
    const demoted = issue(123, { author: { login: 'alice', bot: false, association: 'NONE' } })
    const start = stateWith({ runs: [queuedRun('run-a', T0), queuedRun('run-m', T0, { manual: true })] })
    const { state, effects } = tick(start, obsAt(at(1), { github: { todos: { ok: true, items: [demoted] } } }))
    expect(effects).toEqual([
      { type: 'log', level: 'info', message: 'run run-a: dropped #123 (author no longer allowed)' },
      { type: 'notify', key: 'aborted:run-a', title: 'orcapod: aborted', message: `${LABEL}: author no longer allowed` },
      { type: 'launch', runId: 'run-m' },
    ])
    expect(state.runs.map((r) => [r.id, r.phase.kind, r.items])).toEqual([['run-a', 'aborted', [demoted]], ['run-m', 'launching', [issue(123)]]])
  })

  it('X1-5: disabling a rule keeps its automatic queued runs even with free slots (and no stall notification), and re-enabling makes them launching', () => {
    const start = stateWith({ runs: [queuedRun('run-a', T0)] })
    const ruleOff = tick(start, obsAt(at(40), { config: configWith([projectWith({ rules: [{ ...IMPL, enabled: false }] })]) }))
    const projectOff = tick(ruleOff.state, obsAt(at(41), { config: configWith([projectWith({ enabled: false })]) }))
    expect([ruleOff.effects, projectOff.effects]).toEqual([[], []])
    expect(onlyRun(projectOff.state).phase).toEqual({ kind: 'queued', since: '2026-10-23T00:00:00.000Z' })
    const enabled = tick(projectOff.state, obsAt(at(42)))
    expect(enabled.effects).toEqual([{ type: 'launch', runId: 'run-a' }])
    expect(onlyRun(enabled.state).phase).toEqual({ kind: 'launching', since: '2026-10-23T00:42:00.000Z' })
  })

  it('X1-5: when a rule or project is removed from the configuration, automatic queued runs are aborted with a warn, and manual runs become launching', () => {
    const start = stateWith({ runs: [queuedRun('run-a', T0), queuedRun('run-m', T0, { manual: true })] })
    const ruleGone = tick(start, obsAt(at(1), { config: configWith([projectWith({ rules: [DEPS] })]) }))
    expect(ruleGone.effects).toEqual([
      { type: 'log', level: 'warn', message: 'run run-a: rule ["todos","issue","impl"] is not in the config; aborted the queued run' },
      { type: 'launch', runId: 'run-m' },
    ])
    expect(ruleGone.state.runs.map((r) => [r.id, r.phase])).toEqual([
      ['run-a', { kind: 'aborted', at: '2026-10-23T00:01:00.000Z', reason: 'rule is not in the config' }],
      ['run-m', { kind: 'launching', since: '2026-10-23T00:01:00.000Z' }],
    ])
    const projectGone = tick(stateWith({ runs: [queuedRun('run-a', T0)] }), obsAt(at(1), { config: configWith([]) }))
    expect(projectGone.effects).toEqual([{ type: 'log', level: 'warn', message: 'run run-a: rule ["todos","issue","impl"] is not in the config; aborted the queued run' }])
    expect(onlyRun(projectGone.state).phase).toEqual({ kind: 'aborted', at: '2026-10-23T00:01:00.000Z', reason: 'rule is not in the config' })
  })

  it('a queued run waiting on the limit notifies only once when it exceeds queuedMinutes, and disappears from notified when launched', () => {
    const start = stateWith({ runs: [runWith({ id: 'run-busy' }), queuedRun('run-a', T0)] })
    const config = configWith([projectWith()], 1)
    const orca = seen({ agents: [agent('working', T0)] })
    const first = tick(start, obsAt(at(30), { config, orca }))
    const second = tick(first.state, obsAt(at(31), { config, orca }))
    expect(first.effects).toEqual([{ type: 'notify', key: 'queued:run-a', title: 'orcapod: queue stalled', message: `${LABEL}: waiting in the queue for over 30 minutes` }])
    expect(second.effects).toEqual([])
    const freed = { ...second.state, runs: second.state.runs.filter((r) => r.id === 'run-a') }
    const third = tick(freed, obsAt(at(32), { config }))
    expect(third.effects).toEqual([{ type: 'launch', runId: 'run-a' }])
    expect(onlyRun(third.state).notified).toEqual([])
  })

  describe('A54: the queue stall mark is removed once it is no longer stalled, and notifies one more time if it stalls again', () => {
    const withQueuedMinutes = (queuedMinutes: number, projects: Project[] = [projectWith()]): Config => {
      const config = configWith(projects, 1)
      return { ...config, settings: { ...config.settings, notify: { ...config.settings.notify, queuedMinutes } } }
    }
    const orca = seen({ agents: [agent('working', T0)] })
    const stallNotice = (minutes: number) => ({ type: 'notify', key: 'queued:run-a', title: 'orcapod: queue stalled', message: `${LABEL}: waiting in the queue for over ${minutes} minutes` })
    const notifiedOf = (state: State) => state.runs.find((r) => r.id === 'run-a')?.notified
    const stalled = () => tick(stateWith({ runs: [runWith({ id: 'run-busy' }), queuedRun('run-a', T0)] }), obsAt(at(10), { config: withQueuedMinutes(5), orca }))

    it('after exceeding 5 minutes waiting on the limit the mark is set, and disabling the rule removes it in the next cycle with no notification or launch', () => {
      const first = stalled()
      expect([first.effects, notifiedOf(first.state)]).toEqual([[stallNotice(5)], ['queued']])
      const disabled = tick(first.state, obsAt(at(11), { config: withQueuedMinutes(5, [projectWith({ rules: [{ ...IMPL, enabled: false }] })]), orca }))
      expect([disabled.effects, notifiedOf(disabled.state)]).toEqual([[], []])
    })

    it('raising queuedMinutes to 60 removes the mark, and returning it to 5 notifies one more time', () => {
      const first = stalled()
      const raised = tick(first.state, obsAt(at(11), { config: withQueuedMinutes(60), orca }))
      expect([raised.effects, notifiedOf(raised.state)]).toEqual([[], []])
      const lowered = tick(raised.state, obsAt(at(12), { config: withQueuedMinutes(5), orca }))
      expect([lowered.effects, notifiedOf(lowered.state)]).toEqual([[stallNotice(5)], ['queued']])
    })

    const sectionOfRunA = (state: State, config: Config): string | undefined => {
      const model = buildMonitorModel({ home: '/Users/me/git/orcapod', state, stateError: null, stateMtime: at(11), daemonPid: 4242, lockError: null, config: { kind: 'running', config, loadedAt: T0 }, now: at(11) })
      return model.sections.find((section) => section.rows.some((row) => row.ref?.kind === 'run' && row.ref.runId === 'run-a'))?.id
    }

    it('A54: in the monitor model, while the mark is set it appears under needs-action, and in the state of the cycle after disabling the rule it does not appear under needs-action but under pending / queue', () => {
      const first = stalled()
      expect(sectionOfRunA(first.state, withQueuedMinutes(5))).toBe('attention')
      const disabledConfig = withQueuedMinutes(5, [projectWith({ rules: [{ ...IMPL, enabled: false }] })])
      const disabled = tick(first.state, obsAt(at(11), { config: disabledConfig, orca }))
      expect(sectionOfRunA(disabled.state, disabledConfig)).toBe('waiting')
    })

    it('A54: in the monitor model, in the state of the cycle after raising queuedMinutes to 60 it does not appear under needs-action, and returns to needs-action if it stalls again after returning to 5', () => {
      const first = stalled()
      const raised = tick(first.state, obsAt(at(11), { config: withQueuedMinutes(60), orca }))
      expect(sectionOfRunA(raised.state, withQueuedMinutes(60))).toBe('waiting')
      const lowered = tick(raised.state, obsAt(at(12), { config: withQueuedMinutes(5), orca }))
      expect(sectionOfRunA(lowered.state, withQueuedMinutes(5))).toBe('attention')
    })

    it('even in a cycle where the Orca observation failed, raising queuedMinutes to 60 removes the mark, with no notification, launch, or phase change', () => {
      const first = stalled()
      const down = tick(first.state, obsAt(at(11), { config: withQueuedMinutes(60), orca: { ok: false, error: 'down' } }))
      expect(notifiedOf(down.state)).toEqual([])
      expect(down.effects).toEqual([{ type: 'notify', key: 'orca-outage', title: 'orcapod: Orca unreachable', message: 'down' }])
      expect(down.state.runs.find((r) => r.id === 'run-a')?.phase).toEqual({ kind: 'queued', since: '2026-10-23T00:00:00.000Z' })
    })

    it('even in a cycle where the Orca observation failed, disabling the rule removes the mark', () => {
      const first = stalled()
      const down = tick(first.state, obsAt(at(11), { config: withQueuedMinutes(5, [projectWith({ rules: [{ ...IMPL, enabled: false }] })]), orca: { ok: false, error: 'down' } }))
      expect(notifiedOf(down.state)).toEqual([])
    })

    it('in a cycle where the Orca observation failed, the mark of a still-stalled run remains, and an unmarked stall is not newly marked', () => {
      const first = stalled()
      const stillStalled = tick(first.state, obsAt(at(11), { config: withQueuedMinutes(5), orca: { ok: false, error: 'down' } }))
      expect(notifiedOf(stillStalled.state)).toEqual(['queued'])
      const unmarked = tick(stateWith({ runs: [runWith({ id: 'run-busy' }), queuedRun('run-a', T0)] }), obsAt(at(10), { config: withQueuedMinutes(5), orca: { ok: false, error: 'down' } }))
      expect([unmarked.effects, notifiedOf(unmarked.state)]).toEqual([[{ type: 'notify', key: 'orca-outage', title: 'orcapod: Orca unreachable', message: 'down' }], []])
    })
  })
})

describe('recover', () => {
  const launching = (since: string): Run => runWith({ startedAt: null, orca: null, phase: { kind: 'launching', since }, history: [{ kind: 'queued', at: T0 }, { kind: 'launching', at: since }] })
  const paneFromFile: OrcaRef = { handle: 'term_p', tabId: 'tab-a', paneKey: 'tab-a:leaf-a', ptyId: '' }

  it('C37 / C43: if pane.json exists, copies orca and makes it starting without emitting launch (the handle is re-fetched from the matching item in the listing)', () => {
    const processed = [{ key: '["todos","issue",123,"impl"]', seenAt: T0 }]
    const { state, effects } = tick(stateWith({ processed, runs: [launching(T0)] }), obsAt(at(6), { panes: { 'run-a': paneFromFile }, orca: seen() }))
    expect(effects).toEqual([{ type: 'log', level: 'info', message: 'run run-a: recovered the pane from pane.json' }])
    const run = onlyRun(state)
    expect([run.phase, run.orca, run.startedAt]).toEqual([{ kind: 'starting', since: '2026-10-23T00:06:00.000Z' }, { handle: 'term_p', tabId: 'tab-a', paneKey: 'tab-a:leaf-a', ptyId: '' }, '2026-10-23T00:06:00.000Z'])
    expect(state.processed).toEqual(processed)
  })

  it('C43: does nothing when there is no pane.json and 1 minute has passed since launching', () => {
    const { state, effects } = tick(stateWith({ runs: [launching(T0)] }), obsAt(at(1)))
    expect(effects).toEqual([])
    expect(onlyRun(state).phase).toEqual({ kind: 'launching', since: '2026-10-23T00:00:00.000Z' })
  })

  it('C37 / C43: when there is no pane.json and 6 minutes have passed since launching, stops as an uncertain launch and does not launch again', () => {
    const { state, effects } = tick(stateWith({ runs: [launching(T0)] }), obsAt(at(6)))
    expect(effects.map((effect) => effect.type)).toEqual(['notify'])
    expect(onlyRun(state).phase).toMatchObject({ kind: 'failed', reason: expect.stringContaining('duplicate') })
    expect(onlyRun(state).launchUncertain).toBe(true)
    expect(tick(state, obsAt(at(7))).state.runs).toHaveLength(1)
    expect(state.processed).toEqual([])
  })

  it('C37: even if GitHub keeps returning the same item after a restart with a launching run, it is not re-detected and neither pending nor a new run is created', () => {
    const processed = [{ key: '["todos","issue",123,"impl"]', seenAt: T0 }]
    const github = { todos: { ok: true as const, items: [issue(123)] } }
    const first = tick(stateWith({ processed, runs: [launching(T0)] }), obsAt(at(6), { github }))
    expect(first.effects.map((e) => e.type)).toEqual(['notify'])
    const second = tick(first.state, obsAt(at(7), { github, panes: { 'run-a': paneFromFile }, orca: seen() }))
    expect(second.state.pending).toEqual([])
    expect(second.state.processed).toEqual(processed)
    expect(second.state.runs.map((r) => [r.id, r.phase.kind])).toEqual([['run-a', 'failed']])
  })
})

describe('track: starting', () => {
  const starting = (overrides: Partial<Run> = {}): Run => runWith({ phase: { kind: 'starting', since: T0 }, ...overrides })

  it.each([seen(), { ok: false as const, error: 'offline' }])('in starting, judges a failed result and does not close the tab even when Orca is unreachable (%j)', (orca) => {
    const result = tick(stateWith({ runs: [starting()] }), obsAt(at(2), { orca, results: { 'run-a': { raw: resultFile('failed', 'verification on hold'), mtime: at(1) } } }))
    expect(onlyRun(result.state).phase).toEqual({ kind: 'failed', at: at(2), reason: 'AI reported failed: verification on hold', tabClosed: false })
    expect(result.effects.filter((e) => e.type === 'close')).toEqual([])
  })

  it.each(['starting', 'running'] as const)('in %s, records done even when only an agent of another pane is visible, does not close the tab, and frees the next run slot', (kind) => {
    const run = kind === 'starting' ? starting() : runWith()
    const config = configWith([projectWith()], 1)
    const orca = seen({ agents: [agent('done', at(2), { paneKey: 'other:leaf', lastAssistantMessage: 'other work' })] })
    const result = tick(stateWith({ runs: [run, queuedRun('run-b', at(1))] }), obsAt(at(2), { config, orca, results: { 'run-a': { raw: resultFile('done'), mtime: at(1) } } }))
    expect(result.state.runs[0].phase).toEqual({ kind: 'done', at: at(2), summary: 'Created PR #130', tabClosed: false })
    expect(result.state.runs[0].lastMessage).toBeNull()
    expect(result.effects.filter((e) => e.type === 'close' || e.type === 'writeLastMessage')).toEqual([])
    expect(result.effects.filter((e) => e.type === 'notify')).toEqual([expect.objectContaining({ title: 'orcapod: result untracked', message: expect.stringContaining('The tab remains open') })])
    const next = tick(result.state, obsAt(at(3), { config, orca }))
    expect(next.effects).toContainEqual({ type: 'launch', runId: 'run-b' })
    expect(next.effects.filter((e) => e.type === 'notify')).toEqual([])
  })

  it('a partial write in starting waits 60 seconds, and is left as failed if not fixed', () => {
    const results = { 'run-a': { raw: '{', mtime: at(1) } }
    const first = tick(stateWith({ runs: [starting()] }), obsAt(at(1), { orca: seen(), results }))
    expect(onlyRun(first.state).phase).toMatchObject({ kind: 'starting', invalidResultSince: at(1) })
    const later = tick(first.state, obsAt(at(2), { orca: seen(), results }))
    expect(onlyRun(later.state).phase).toMatchObject({ kind: 'failed', reason: 'result.json is invalid' })
    expect(later.effects.filter((e) => e.type === 'close')).toEqual([])
  })

  it('the grace period for a broken result counted in starting carries over after agent detection, and is cleared by a valid result', () => {
    const results = { 'run-a': { raw: '{', mtime: at(1) } }
    const first = tick(stateWith({ runs: [starting()] }), obsAt(at(1), { orca: seen(), results }))
    const orca = seen({ agents: [agent('working', at(1))] })
    const running = tick(first.state, obsAt(at(1, 20), { orca, results }))
    expect(onlyRun(running.state).phase).toMatchObject({ kind: 'running', invalidResultSince: at(1) })
    const failed = tick(running.state, obsAt(at(2), { orca, results }))
    expect(onlyRun(failed.state).phase).toMatchObject({ kind: 'failed', reason: 'result.json is invalid' })
    const fixed = tick(first.state, obsAt(at(1, 30), { orca, results: { 'run-a': { raw: resultFile('done'), mtime: at(1, 25) } } }))
    expect(onlyRun(fixed.state).phase).not.toHaveProperty('invalidResultSince')
  })

  it('even in starting, observing a done newer than the result at the same time closes in that cycle', () => {
    const result = tick(stateWith({ runs: [starting()] }), obsAt(at(2), { orca: seen({ agents: [agent('done', at(1, 30))] }), results: { 'run-a': { raw: resultFile('done'), mtime: at(1) } } }))
    expect(result.effects).toEqual([{ type: 'close', runId: 'run-a', handle: 'term_a' }])
  })

  it('in starting, even with a result the tab is not closed while a working agent is visible, and done is not confirmed while Orca is unreachable', () => {
    const results = { 'run-a': { raw: resultFile('done'), mtime: at(1) } }
    const working = tick(stateWith({ runs: [starting()] }), obsAt(at(2), { orca: seen({ agents: [agent('working', T0)] }), results }))
    expect(onlyRun(working.state).phase).toMatchObject({ kind: 'running', agent: 'working', result: { mtime: at(1) } })
    expect(working.effects).toEqual([])
    const offline = tick(stateWith({ runs: [starting()] }), obsAt(at(2), { orca: { ok: false, error: 'offline' }, results }))
    expect(onlyRun(offline.state).phase.kind).toBe('starting')
    expect(offline.effects.filter((e) => e.type === 'close')).toEqual([])
  })

  it.each([true, false])('when observing a done result and pane disappearance, tabClosed follows the completeness of the listing (%s)', (complete) => {
    const result = tick(stateWith({ runs: [starting()] }), obsAt(at(2), { orca: seen({ terminals: [], complete }), results: { 'run-a': { raw: resultFile('done'), mtime: at(1) } } }))
    expect(onlyRun(result.state).phase).toEqual({ kind: 'done', at: at(2), summary: 'Created PR #130', tabClosed: complete })
    expect(result.effects.filter((e) => e.type === 'close')).toEqual([])
  })

  it('C24: when starting lasts 91 seconds, notifies once the launch wait with the handle, and when the agent appears makes it running and removes it from notified', () => {
    const first = tick(stateWith({ runs: [starting()] }), obsAt(at(1, 31), { orca: seen() }))
    expect(first.effects).toEqual([{ type: 'notify', key: 'starting-stall:run-a', title: 'orcapod: launch waiting', message: `${LABEL}: no agent appeared 90 seconds after the tab opened (possibly a trust dialog)`, withScreenOf: 'term_a' }])
    expect(onlyRun(first.state).notified).toEqual(['starting-stall'])
    const second = tick(first.state, obsAt(at(2), { orca: seen() }))
    expect(second.effects).toEqual([])
    const third = tick(second.state, obsAt(at(3), { orca: seen({ agents: [agent('working', at(2, 50))] }) }))
    const run = onlyRun(third.state)
    expect([run.phase, run.notified]).toEqual([{ kind: 'running', agent: 'working', agentSince: '2026-10-23T00:03:00.000Z', closeAttempts: 0 }, []])
  })

  it('C42: when hooks enabled is false, "Orca hooks are disabled" is included in the launch-wait message', () => {
    const hooks = { enabled: false, agents: { claude: 'installed' as const, codex: 'installed' as const } }
    const { effects } = tick(stateWith({ runs: [starting()] }), obsAt(at(1, 31), { orca: seen({ hooks }) }))
    expect(effects).toEqual([{ type: 'notify', key: 'starting-stall:run-a', title: 'orcapod: launch waiting', message: `${LABEL}: no agent appeared 90 seconds after the tab opened (possibly a trust dialog). Orca hooks are disabled`, withScreenOf: 'term_a' }])
  })

  it('C42: "Orca hooks are disabled" is included even when the run\'s AI hooks are not installed, and not when hooks is null', () => {
    const hooks = { enabled: true, agents: { claude: 'not_installed' as const, codex: 'installed' as const } }
    const partial = tick(stateWith({ runs: [starting()] }), obsAt(at(1, 31), { orca: seen({ hooks }) }))
    const unknown = tick(stateWith({ runs: [starting()] }), obsAt(at(1, 31), { orca: seen({ hooks: null }) }))
    expect(partial.effects.map((e) => (e.type === 'notify' ? e.message : e.type))).toEqual([`${LABEL}: no agent appeared 90 seconds after the tab opened (possibly a trust dialog). Orca hooks are disabled`])
    expect(unknown.effects.map((e) => (e.type === 'notify' ? e.message : e.type))).toEqual([`${LABEL}: no agent appeared 90 seconds after the tab opened (possibly a trust dialog)`])
  })

  it('in starting, if the pane is in neither a complete listing nor agents, aborted with a notification', () => {
    const { state, effects } = tick(stateWith({ runs: [starting()] }), obsAt(at(1), { orca: seen({ terminals: [] }) }))
    expect(effects).toEqual([{ type: 'notify', key: 'aborted:run-a', title: 'orcapod: aborted', message: `${LABEL}: pane and tab disappeared` }])
    expect(onlyRun(state).phase).toEqual({ kind: 'aborted', at: '2026-10-23T00:01:00.000Z', reason: 'pane and tab disappeared' })
  })
})

describe('track: running', () => {
  it('C14: if result.json done comes first, only saves without closing, and closes when a done that started afterwards is observed', () => {
    const results = { 'run-a': { raw: resultFile('done'), mtime: at(10) } }
    const first = tick(stateWith({ runs: [runWith()] }), obsAt(at(11), { orca: seen({ agents: [agent('working', at(1))] }), results }))
    expect(first.effects).toEqual([])
    expect(onlyRun(first.state).phase).toEqual({ kind: 'running', agent: 'working', agentSince: '2026-10-23T00:00:00.000Z', closeAttempts: 0, result: { file: { status: 'done', summary: 'Created PR #130', links: ['https://github.com/alice/todos/pull/130'] }, mtime: '2026-10-23T00:10:00.000Z' } })
    const second = tick(first.state, obsAt(at(12), { orca: seen({ agents: [agent('done', at(11, 30))] }), results }))
    expect(second.effects).toEqual([{ type: 'close', runId: 'run-a', handle: 'term_a' }])
    expect(onlyRun(second.state).phase).toMatchObject({ kind: 'running', agent: 'done', closeAttempts: 1 })
  })

  it('C15: does not close with a result written after the previous turn\'s done, and closes on a new done', () => {
    const start = stateWith({ runs: [runWith({ phase: { kind: 'running', agent: 'done', agentSince: at(2), closeAttempts: 0 } })] })
    const noResult = tick(start, obsAt(at(3), { orca: seen({ agents: [agent('done', at(2))] }) }))
    expect(noResult.effects).toEqual([])
    const results = { 'run-a': { raw: resultFile('done'), mtime: at(4) } }
    const stale = tick(noResult.state, obsAt(at(5), { orca: seen({ agents: [agent('done', at(2))] }), results }))
    expect(stale.effects).toEqual([])
    const fresh = tick(stale.state, obsAt(at(6), { orca: seen({ agents: [agent('done', at(5, 30))] }), results }))
    expect(fresh.effects).toEqual([{ type: 'close', runId: 'run-a', handle: 'term_a' }])
  })

  it('X1-3: after a valid done is saved, if result.json becomes broken, close is not issued even when a new done is observed', () => {
    const first = tick(stateWith({ runs: [runWith()] }), obsAt(at(11), { orca: seen({ agents: [agent('working', at(1))] }), results: { 'run-a': { raw: resultFile('done'), mtime: at(10) } } }))
    const broken = tick(first.state, obsAt(at(12), { orca: seen({ agents: [agent('done', at(11, 30))] }), results: { 'run-a': { raw: '{"status":', mtime: at(11, 40) } } }))
    expect(broken.effects).toEqual([])
    expect(onlyRun(broken.state).phase).toMatchObject({ kind: 'running', agent: 'done', closeAttempts: 0, invalidResultSince: '2026-10-23T00:12:00.000Z' })
  })

  it('X1-3: after a valid done is saved, if result.json disappears, close is not issued, and if done continues for waitingMinutes a no-result notification is sent', () => {
    const first = tick(stateWith({ runs: [runWith()] }), obsAt(at(11), { orca: seen({ agents: [agent('working', at(1))] }), results: { 'run-a': { raw: resultFile('done'), mtime: at(10) } } }))
    const orca = seen({ agents: [agent('done', at(11, 30))] })
    const vanished = tick(first.state, obsAt(at(12), { orca }))
    expect(vanished.effects).toEqual([])
    expect(onlyRun(vanished.state).phase).toMatchObject({ kind: 'running', agent: 'done', agentSince: '2026-10-23T00:12:00.000Z', closeAttempts: 0 })
    const later = tick(vanished.state, obsAt(at(22), { orca }))
    expect(later.effects).toEqual([{ type: 'notify', key: 'done-no-result:run-a', title: 'orcapod: no result', message: `${LABEL}: the turn ended without a result (10 minutes)` }])
  })

  it('C16: a broken result.json becomes failed after a 60-second grace period, and close is not issued', () => {
    const broken = { 'run-a': { raw: '{', mtime: at(1) } }
    const orca = seen({ agents: [agent('done', at(1, 30))] })
    const first = tick(stateWith({ runs: [runWith()] }), obsAt(at(2), { orca, results: broken }))
    expect(first.effects).toEqual([])
    expect(onlyRun(first.state).phase).toMatchObject({ kind: 'running', invalidResultSince: '2026-10-23T00:02:00.000Z' })
    const later = tick(first.state, obsAt(at(3, 1), { orca, results: broken }))
    expect(later.effects).toEqual([{ type: 'notify', key: 'failed:run-a', title: 'orcapod: failed', message: `${LABEL}: result.json is invalid` }])
    expect(onlyRun(later.state).phase).toEqual({ kind: 'failed', at: '2026-10-23T00:03:01.000Z', reason: 'result.json is invalid', tabClosed: false })
  })

  it('C16: if it becomes a valid done during the grace period, invalidResultSince is cleared and it proceeds to judgment', () => {
    const orca = seen({ agents: [agent('done', at(2, 30))] })
    const first = tick(stateWith({ runs: [runWith()] }), obsAt(at(2), { orca, results: { 'run-a': { raw: '{"status":"don', mtime: at(1) } } }))
    const fixed = tick(first.state, obsAt(at(2, 40), { orca, results: { 'run-a': { raw: '{"status":"done"}', mtime: at(2, 10) } } }))
    expect(fixed.effects).toEqual([{ type: 'close', runId: 'run-a', handle: 'term_a' }])
    expect(onlyRun(fixed.state).phase).toEqual({ kind: 'running', agent: 'done', agentSince: '2026-10-23T00:02:00.000Z', closeAttempts: 1, result: { file: { status: 'done', summary: '', links: [] }, mtime: '2026-10-23T00:02:10.000Z' } })
  })

  it('C16: an unknown status value is also treated as broken', () => {
    const { state } = tick(stateWith({ runs: [runWith()] }), obsAt(at(2), { orca: seen({ agents: [agent('working', T0)] }), results: { 'run-a': { raw: resultFile('ok'), mtime: at(1) } } }))
    expect(onlyRun(state).phase).toMatchObject({ kind: 'running', invalidResultSince: '2026-10-23T00:02:00.000Z' })
  })

  it('C17: if result.json has status: failed, makes it failed, does not issue close, and notifies once', () => {
    const { state, effects } = tick(stateWith({ runs: [runWith()] }), obsAt(at(2), { orca: seen({ agents: [agent('done', at(1, 30))] }), results: { 'run-a': { raw: resultFile('failed', 'tests do not pass'), mtime: at(1) } } }))
    expect(effects).toEqual([{ type: 'notify', key: 'failed:run-a', title: 'orcapod: failed', message: `${LABEL}: AI reported failed: tests do not pass` }])
    expect(onlyRun(state).phase).toEqual({ kind: 'failed', at: '2026-10-23T00:02:00.000Z', reason: 'AI reported failed: tests do not pass', tabClosed: false })
  })

  it('C18: aborted if the pane is in neither a complete listing nor agents, close is not issued, and 1 notification', () => {
    const { state, effects } = tick(stateWith({ runs: [runWith()] }), obsAt(at(2), { orca: seen({ terminals: [] }) }))
    expect(effects).toEqual([{ type: 'notify', key: 'aborted:run-a', title: 'orcapod: aborted', message: `${LABEL}: pane and tab disappeared` }])
    expect(onlyRun(state).phase).toEqual({ kind: 'aborted', at: '2026-10-23T00:02:00.000Z', reason: 'pane and tab disappeared' })
  })

  it('C33: if the listing is incomplete, does not abort even when the pane is not found, and only leaves a log', () => {
    const { state, effects } = tick(stateWith({ runs: [runWith()] }), obsAt(at(2), { orca: seen({ terminals: [], complete: false }) }))
    expect(effects).toEqual([{ type: 'log', level: 'warn', message: 'run run-a: terminal list is incomplete, so the pane is not judged as gone' }])
    expect(onlyRun(state).phase.kind).toBe('running')
  })

  it('if the pane disappears after attempting close, treats it as closed and makes it done (tabClosed: true)', () => {
    const result = { file: { status: 'done' as const, summary: 'Created PR #130', links: [] }, mtime: at(1) }
    const start = stateWith({ runs: [runWith({ phase: { kind: 'running', agent: 'done', agentSince: at(2), result, closeAttempts: 1 } })] })
    const { state, effects } = tick(start, obsAt(at(3), { orca: seen({ terminals: [] }) }))
    expect(effects).toEqual([])
    expect(onlyRun(state).phase).toEqual({ kind: 'done', at: '2026-10-23T00:03:00.000Z', summary: 'Created PR #130', tabClosed: true })
  })

  it('C19: if done lasts 11 minutes with no result, notifies done-no-result once, and returns to working to disappear from notified', () => {
    const start = stateWith({ runs: [runWith({ phase: { kind: 'running', agent: 'done', agentSince: T0, closeAttempts: 0 } })] })
    const doneAgent = seen({ agents: [agent('done', T0)] })
    const first = tick(start, obsAt(at(11), { orca: doneAgent }))
    expect(first.effects).toEqual([{ type: 'notify', key: 'done-no-result:run-a', title: 'orcapod: no result', message: `${LABEL}: the turn ended without a result (10 minutes)` }])
    expect(onlyRun(first.state).phase.kind).toBe('running')
    const second = tick(first.state, obsAt(at(12), { orca: doneAgent }))
    expect(second.effects).toEqual([])
    const working = tick(second.state, obsAt(at(13), { orca: seen({ agents: [agent('working', at(12, 50))] }) }))
    expect(working.effects).toEqual([])
    expect(onlyRun(working.state).notified).toEqual([])
  })

  it('C21: waiting 11 minutes gives 1 notification, 12 minutes adds none, working clears it, and waiting 11 minutes again gives 1 notification', () => {
    const waiting = (since: string) => seen({ agents: [agent('waiting', since)] })
    const notice = { type: 'notify', key: 'waiting:run-a', title: 'orcapod: waiting for input', message: `${LABEL}: waiting for input for 10 minutes` }
    const start = stateWith({ runs: [runWith({ phase: { kind: 'running', agent: 'waiting', agentSince: T0, waitingSince: T0, closeAttempts: 0 } })] })
    const c1 = tick(start, obsAt(at(11), { orca: waiting(T0) }))
    const c2 = tick(c1.state, obsAt(at(12), { orca: waiting(T0) }))
    const c3 = tick(c2.state, obsAt(at(13), { orca: seen({ agents: [agent('working', at(13))] }) }))
    const c4 = tick(c3.state, obsAt(at(14), { orca: waiting(at(14)) }))
    const c5 = tick(c4.state, obsAt(at(25), { orca: waiting(at(14)) }))
    expect([c1.effects, c2.effects, c3.effects, c4.effects, c5.effects]).toEqual([[notice], [], [], [], [notice]])
    expect(onlyRun(c3.state).phase).toEqual({ kind: 'running', agent: 'working', agentSince: '2026-10-23T00:13:00.000Z', closeAttempts: 0 })
    expect(onlyRun(c3.state).notified).toEqual([])
    expect(onlyRun(c4.state).phase).toMatchObject({ waitingSince: '2026-10-23T00:14:00.000Z' })
  })

  it('C46: observing AskUserQuestion while working records waitingSince, notifies if it lasts 10 minutes, and clears it when returning to working', () => {
    const asking = seen({ agents: [agent('working', T0, { toolName: 'AskUserQuestion' })] })
    const first = tick(stateWith({ runs: [runWith()] }), obsAt(at(10), { orca: asking }))
    expect(first.effects).toEqual([])
    expect(onlyRun(first.state).phase).toEqual({ kind: 'running', agent: 'working', agentSince: '2026-10-23T00:00:00.000Z', waitingSince: '2026-10-23T00:10:00.000Z', closeAttempts: 0 })
    const second = tick(first.state, obsAt(at(20), { orca: asking }))
    expect(second.effects).toEqual([{ type: 'notify', key: 'waiting:run-a', title: 'orcapod: waiting for input', message: `${LABEL}: waiting for input for 10 minutes` }])
    const back = tick(second.state, obsAt(at(21), { orca: seen({ agents: [agent('working', T0, { toolName: 'Bash' })] }) }))
    expect(onlyRun(back.state).phase).toEqual({ kind: 'running', agent: 'working', agentSince: '2026-10-23T00:00:00.000Z', closeAttempts: 0 })
    expect(onlyRun(back.state).notified).toEqual([])
  })

  it('C47: long-run is counted from startedAt and does not include time spent waiting in the queue', () => {
    const queuedLong = runWith({ createdAt: T0, startedAt: at(100) })
    const orca = seen({ agents: [agent('working', at(100))] })
    const early = tick(stateWith({ runs: [queuedLong] }), obsAt(at(130), { orca }))
    expect(early.effects).toEqual([])
    const late = tick(early.state, obsAt(at(221), { orca }))
    expect(late.effects).toEqual([{ type: 'notify', key: 'long-run:run-a', title: 'orcapod: long run', message: `${LABEL}: running for over 120 minutes` }])
    const later = tick(late.state, obsAt(at(240), { orca }))
    expect(later.effects).toEqual([])
  })

  it('C23: tracks by paneKey even if the title differs, does not abort when only ptyId matches while orphaned, and copies the handle and closes with that handle', () => {
    const renamed = { ...TERMINAL, title: '✳ A completely different title' }
    const first = tick(stateWith({ runs: [runWith()] }), obsAt(at(1), { orca: seen({ terminals: [renamed], agents: [] }) }))
    expect(first.effects).toEqual([])
    const orphaned: TerminalObservation = { handle: 'term_b', tabId: 'pty:pty-a', leafId: 'pty:pty-a', ptyId: 'pty-a', orphaned: true, title: null }
    const second = tick(first.state, obsAt(at(2), { orca: seen({ terminals: [orphaned], agents: [] }) }))
    expect(second.effects).toEqual([])
    const run = onlyRun(second.state)
    expect([run.phase.kind, run.orca]).toEqual(['running', { handle: 'term_b', tabId: 'tab-a', paneKey: 'tab-a:leaf-a', ptyId: 'pty-a' }])
    const third = tick(second.state, obsAt(at(4), { orca: seen({ terminals: [orphaned], agents: [agent('done', at(3, 30))] }), results: { 'run-a': { raw: resultFile('done'), mtime: at(3) } } }))
    expect(third.effects).toEqual([{ type: 'close', runId: 'run-a', handle: 'term_b' }])
  })

  it('C34: in the cycle after close fails 3 times, makes it done (tabClosed: false), notifies close-failed, and does not issue close', () => {
    const result = { file: { status: 'done' as const, summary: 'Created PR #130', links: [] }, mtime: at(1) }
    const start = stateWith({ runs: [runWith({ phase: { kind: 'running', agent: 'done', agentSince: at(2), result, closeAttempts: 3 } })] })
    const { state, effects } = tick(start, obsAt(at(3), { orca: seen({ agents: [agent('done', at(2))] }) }))
    expect(effects).toEqual([{ type: 'notify', key: 'close-failed:run-a', title: 'orcapod: cannot close tab', message: `${LABEL}: failed to close the tab 3 times. The tab remains open` }])
    expect(onlyRun(state).phase).toEqual({ kind: 'done', at: '2026-10-23T00:03:00.000Z', summary: 'Created PR #130', tabClosed: false })
  })

  it('C34: if close keeps failing with ptyKilled: false, close is issued 3 times, and in the 4th cycle it becomes done (tabClosed: false) with 1 close-failed notification', () => {
    const results = { 'run-a': { raw: resultFile('done'), mtime: at(1) } }
    let state = stateWith({ runs: [runWith({ phase: { kind: 'running', agent: 'working', agentSince: T0, closeAttempts: 0 } })] })
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const now = at(3 + cycle)
      const out = tick(state, obsAt(now, { orca: seen({ agents: [agent('done', at(2))] }), results }))
      expect(out.effects).toEqual([{ type: 'close', runId: 'run-a', handle: 'term_a' }])
      state = applyClose(out.state, 'run-a', { ok: true, ptyKilled: false }, now)
      expect(onlyRun(state).phase).toMatchObject({ kind: 'running', closeAttempts: cycle + 1 })
    }
    const fourth = tick(state, obsAt(at(6), { orca: seen({ agents: [agent('done', at(2))] }), results }))
    expect(fourth.effects).toEqual([{ type: 'notify', key: 'close-failed:run-a', title: 'orcapod: cannot close tab', message: `${LABEL}: failed to close the tab 3 times. The tab remains open` }])
    expect(onlyRun(fourth.state).phase).toEqual({ kind: 'done', at: '2026-10-23T00:06:00.000Z', summary: 'Created PR #130', tabClosed: false })
    const fifth = tick(fourth.state, obsAt(at(7), { orca: seen({ agents: [agent('done', at(2))] }), results }))
    expect(fifth.effects).toEqual([])
  })

  it('C35: even if the configuration path changes or the project is removed, tracks by looking at agents at the path from when the run was created', () => {
    const moved = configWith([projectWith({ path: '/Users/alice/git/elsewhere' })])
    const removed = configWith([])
    const orca = seen({ agents: [agent('waiting', at(1))] })
    const first = tick(stateWith({ runs: [runWith()] }), obsAt(at(2), { config: moved, orca }))
    const second = tick(first.state, obsAt(at(3), { config: removed, orca }))
    expect(onlyRun(first.state).phase).toMatchObject({ agent: 'waiting', agentSince: '2026-10-23T00:02:00.000Z' })
    expect(onlyRun(second.state).phase).toMatchObject({ kind: 'running', agent: 'waiting', waitingSince: '2026-10-23T00:02:00.000Z' })
  })

  it('emits writeLastMessage only when lastAssistantMessage changes, and does not write for null', () => {
    const said = seen({ agents: [agent('done', T0, { lastAssistantMessage: 'I created the PR' })] })
    const first = tick(stateWith({ runs: [runWith()] }), obsAt(at(1), { orca: said }))
    expect(first.effects).toEqual([{ type: 'writeLastMessage', runId: 'run-a', text: 'I created the PR' }])
    expect(onlyRun(first.state).lastMessage).toBe('I created the PR')
    const same = tick(first.state, obsAt(at(2), { orca: said }))
    const silent = tick(same.state, obsAt(at(3), { orca: seen({ agents: [agent('done', T0)] }) }))
    expect([same.effects, silent.effects]).toEqual([[], []])
  })
})

describe('serve', () => {
  const request = { type: 'run' as const, project: 'todos', item: issue(42), kind: 'feature', now: false }

  it('a run request creates a manual queued run, does not change processed, and emits consumption of the request file', () => {
    const { state, effects } = tick(stateWith(), obsAt(T0, { orca: { ok: false, error: 'down' }, requests: [{ file: 'req-1.json', request }] }))
    expect(effects).toEqual([
      { type: 'consumeRequest', file: 'req-1.json' },
      { type: 'notify', key: 'orca-outage', title: 'orcapod: Orca unreachable', message: 'down' },
    ])
    expect(state.processed).toEqual([])
    expect(state.consumedRequests).toEqual(['req-1.json'])
    expect(onlyRun(state)).toEqual({
      id: '20261023-0000-61ed5d',
      project: 'todos',
      target: { path: '/Users/alice/git/todos', repo: 'alice/todos', githubAccount: 'taylor' },
      rule: { target: 'issue', label: '', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 0, enabled: true, bootstrap: 'skip' },
      kindName: 'Feature',
      items: [issue(42)],
      createdAt: '2026-10-23T00:00:00.000Z',
      startedAt: null,
      phase: { kind: 'queued', since: '2026-10-23T00:00:00.000Z' },
      history: [{ kind: 'queued', at: '2026-10-23T00:00:00.000Z' }],
      orca: null,
      notified: [],
      bypassLimit: false,
      manual: true,
      lastMessage: null,
    })
  })

  it('a run --now request uses bypassLimit and the ai of the request. A project, kind, or prompt not in the configuration only warns', () => {
    const requests = [
      { file: 'a.json', request: { ...request, ai: 'codex' as const, now: true } },
      { file: 'b.json', request: { ...request, project: 'ghost' } },
      { file: 'c.json', request: { ...request, kind: 'review' } },
      { file: 'd.json', request: { ...request, kind: 'dependabot' } },
    ]
    const config = { ...configWith(), prompts: new Map([['feature.codex', 'x']]) }
    const { state, effects } = tick(stateWith(), obsAt(T0, { config, orca: { ok: false, error: 'down' }, requests }))
    expect(effects.filter((e) => e.type === 'log')).toEqual([
      { type: 'log', level: 'warn', message: 'cannot process request b.json: project ghost is not in the config' },
      { type: 'log', level: 'warn', message: 'cannot process request c.json: kind review is not in the config' },
      { type: 'log', level: 'warn', message: 'cannot process request d.json: no enabled rule uses kind dependabot, so the AI cannot be chosen' },
    ])
    const run = onlyRun(state)
    expect([run.rule.ai, run.bypassLimit]).toEqual(['codex', true])
    expect(state.consumedRequests).toEqual(['a.json', 'b.json', 'c.json', 'd.json'])
  })

  it('C25: with a stop request, running gets close + aborted, a failed run whose pane remains gets close only, and queued gets aborted only', () => {
    const start = stateWith({ runs: [
      runWith(),
      runWith({ id: 'run-f', phase: { kind: 'failed', at: T0, reason: 'result.json is invalid', tabClosed: false }, orca: { ...REF, paneKey: 'tab-f:leaf-f', ptyId: 'pty-f' } }),
      queuedRun('run-q', T0),
    ] })
    const failedTerminal: TerminalObservation = { handle: 'term_f2', tabId: 'tab-f', leafId: 'leaf-f', ptyId: 'pty-f', orphaned: false, title: null }
    const requests = [
      { file: 's1.json', request: { type: 'stop' as const, runId: 'run-a' } },
      { file: 's2.json', request: { type: 'stop' as const, runId: 'run-f' } },
      { file: 's3.json', request: { type: 'stop' as const, runId: 'run-q' } },
    ]
    const { state, effects } = tick(start, obsAt(at(5), { orca: seen({ agents: [agent('working', T0)], terminals: [TERMINAL, failedTerminal] }), requests }))
    expect(effects).toEqual([
      { type: 'close', runId: 'run-a', handle: 'term_a' },
      { type: 'consumeRequest', file: 's1.json' },
      { type: 'close', runId: 'run-f', handle: 'term_f2' },
      { type: 'consumeRequest', file: 's2.json' },
      { type: 'consumeRequest', file: 's3.json' },
    ])
    expect(state.runs.map((r) => [r.id, r.phase])).toEqual([
      ['run-a', { kind: 'aborted', at: '2026-10-23T00:05:00.000Z', reason: 'orcapod stop' }],
      ['run-f', { kind: 'failed', at: '2026-10-23T00:00:00.000Z', reason: 'result.json is invalid', tabClosed: false }],
      ['run-q', { kind: 'aborted', at: '2026-10-23T00:05:00.000Z', reason: 'orcapod stop' }],
    ])
  })

  it('X1-7: stopping a launching run during an Orca outage copies the pane of pane.json and aborts, and the tab is closed by a stop after recovery', () => {
    const paneFromFile: OrcaRef = { handle: 'term_p', tabId: 'tab-a', paneKey: 'tab-a:leaf-a', ptyId: '' }
    const launching = runWith({ startedAt: null, orca: null, phase: { kind: 'launching', since: T0 }, history: [{ kind: 'queued', at: T0 }, { kind: 'launching', at: T0 }] })
    const stop = (file: string) => [{ file, request: { type: 'stop' as const, runId: 'run-a' } }]
    const during = tick(stateWith({ runs: [launching] }), obsAt(at(1), { orca: { ok: false, error: 'down' }, panes: { 'run-a': paneFromFile }, requests: stop('s1.json') }))
    expect(during.effects).toEqual([{ type: 'consumeRequest', file: 's1.json' }, { type: 'notify', key: 'orca-outage', title: 'orcapod: Orca unreachable', message: 'down' }])
    const stopped = onlyRun(during.state)
    expect([stopped.phase, stopped.orca]).toEqual([{ kind: 'aborted', at: '2026-10-23T00:01:00.000Z', reason: 'orcapod stop' }, paneFromFile])
    const after = tick(during.state, obsAt(at(2), { orca: seen(), requests: stop('s2.json') }))
    expect(after.effects).toEqual([{ type: 'close', runId: 'run-a', handle: 'term_a' }, { type: 'consumeRequest', file: 's2.json' }, { type: 'log', level: 'info', message: 'reconnected to Orca' }])
  })

  it('C25: rerun creates a manual queued run with the same items / rule / target and does not change processed. A nonexistent id gets warn + consume', () => {
    const processed = [{ key: '["todos","issue",123,"impl"]', seenAt: T0 }]
    const original = runWith({ phase: { kind: 'failed', at: T0, reason: 'x', tabClosed: false } })
    const requests = [
      { file: 'r1.json', request: { type: 'rerun' as const, runId: 'run-a' } },
      { file: 'r2.json', request: { type: 'stop' as const, runId: 'nope' } },
    ]
    const { state, effects } = tick(stateWith({ processed, runs: [original] }), obsAt(at(5), { orca: { ok: false, error: 'down' }, requests }))
    expect(effects).toEqual([
      { type: 'consumeRequest', file: 'r1.json' },
      { type: 'log', level: 'warn', message: 'request r2.json: stop target nope not found' },
      { type: 'consumeRequest', file: 'r2.json' },
      { type: 'notify', key: 'orca-outage', title: 'orcapod: Orca unreachable', message: 'down' },
    ])
    expect(state.processed).toEqual(processed)
    const rerun = state.runs[1]
    expect([rerun.id, rerun.items, rerun.rule, rerun.target, rerun.manual, rerun.bypassLimit, rerun.phase.kind]).toEqual(['20261023-0005-bb31d3', [issue(123)], IMPL, original.target, true, false, 'queued'])
  })

  it('C39: a request consumed in the previous cycle that remains is not processed and only consumeRequest is emitted, and when it is gone it disappears from consumedRequests', () => {
    const requests = [{ file: 'req-1.json', request: { type: 'stop' as const, runId: 'run-a' } }]
    const start = stateWith({ runs: [runWith({ phase: { kind: 'aborted', at: T0, reason: 'orcapod stop' } })], consumedRequests: ['req-1.json', 'gone.json'] })
    const again = tick(start, obsAt(at(1), { requests }))
    expect(again.effects).toEqual([{ type: 'consumeRequest', file: 'req-1.json' }])
    expect(again.state.consumedRequests).toEqual(['req-1.json'])
    const deleted = tick(again.state, obsAt(at(2)))
    expect(deleted.state.consumedRequests).toEqual([])
  })

  it('C48: a broken request gets warn + consumeRequest, and runs do not increase', () => {
    const { state, effects } = tick(stateWith(), obsAt(T0, { requests: [{ file: 'bad.json', error: 'not valid JSON: Unexpected end of JSON input' }] }))
    expect(effects).toEqual([
      { type: 'log', level: 'warn', message: 'cannot read request bad.json: not valid JSON: Unexpected end of JSON input' },
      { type: 'consumeRequest', file: 'bad.json' },
    ])
    expect(state.runs).toEqual([])
  })
})

describe('applyLaunch / applyClose', () => {
  const launching = runWith({ startedAt: null, orca: null, phase: { kind: 'launching', since: T0 }, history: [{ kind: 'launching', at: T0 }] })

  it('applyLaunch: on success makes it starting and copies orca and startedAt, on failure makes it failed', () => {
    const ok = onlyRun(applyLaunch(stateWith({ runs: [launching] }), 'run-a', { ok: true, orca: REF }, at(1)))
    expect([ok.phase, ok.orca, ok.startedAt, ok.history]).toEqual([{ kind: 'starting', since: '2026-10-23T00:01:00.000Z' }, REF, '2026-10-23T00:01:00.000Z', [{ kind: 'launching', at: '2026-10-23T00:00:00.000Z' }, { kind: 'starting', at: '2026-10-23T00:01:00.000Z' }]])
    const failed = onlyRun(applyLaunch(stateWith({ runs: [launching] }), 'run-a', { ok: false, error: 'no_pane_key' }, at(1)))
    expect([failed.phase, failed.orca, failed.startedAt]).toEqual([{ kind: 'failed', at: '2026-10-23T00:01:00.000Z', reason: 'launch failed: no_pane_key', tabClosed: false, launchFailed: true }, null, null])
  })

  it('C34: applyClose treats only ptyKilled: true as success, and with false / null / a failure code the run stays running', () => {
    const result = { file: { status: 'done' as const, summary: 'Created PR #130', links: [] }, mtime: at(1) }
    const start = stateWith({ runs: [runWith({ phase: { kind: 'running', agent: 'done', agentSince: at(2), result, closeAttempts: 1 } })] })
    expect(applyClose(start, 'run-a', { ok: true, ptyKilled: false }, at(3))).toEqual(start)
    expect(applyClose(start, 'run-a', { ok: true, ptyKilled: null }, at(3))).toEqual(start)
    expect(applyClose(start, 'run-a', { ok: false, code: 'terminal_handle_stale' }, at(3))).toEqual(start)
    expect(onlyRun(applyClose(start, 'run-a', { ok: true, ptyKilled: true }, at(3))).phase).toEqual({ kind: 'done', at: '2026-10-23T00:03:00.000Z', summary: 'Created PR #130', tabClosed: true })
  })

  it('applyClose: does not change the phase of a run aborted by stop, and sets tabClosed: true for a tab left by done', () => {
    const aborted = stateWith({ runs: [runWith({ phase: { kind: 'aborted', at: T0, reason: 'orcapod stop' } })] })
    expect(applyClose(aborted, 'run-a', { ok: true, ptyKilled: true }, at(1))).toEqual(aborted)
    const leftOpen = stateWith({ runs: [runWith({ phase: { kind: 'done', at: T0, summary: 's', tabClosed: false }, history: [{ kind: 'done', at: T0 }] })] })
    const closed = onlyRun(applyClose(leftOpen, 'run-a', { ok: true, ptyKilled: true }, at(1)))
    expect([closed.phase, closed.history]).toEqual([{ kind: 'done', at: '2026-10-23T00:00:00.000Z', summary: 's', tabClosed: true }, [{ kind: 'done', at: '2026-10-23T00:00:00.000Z' }]])
  })

  it('A36: applyClose treats a failed tab as closed only when ptyKilled: true, and does not change at, reason, or history', () => {
    const start = stateWith({ runs: [runWith({ phase: { kind: 'failed', at: T0, reason: 'result.json is invalid', tabClosed: false }, history: [{ kind: 'failed', at: T0 }] })] })
    expect(applyClose(start, 'run-a', { ok: true, ptyKilled: false }, at(1))).toEqual(start)
    expect(applyClose(start, 'run-a', { ok: true, ptyKilled: null }, at(1))).toEqual(start)
    expect(applyClose(start, 'run-a', { ok: false, code: 'terminal_handle_stale' }, at(1))).toEqual(start)
    const closed = onlyRun(applyClose(start, 'run-a', { ok: true, ptyKilled: true }, at(1)))
    expect([closed.phase, closed.history]).toEqual([{ kind: 'failed', at: '2026-10-23T00:00:00.000Z', reason: 'result.json is invalid', tabClosed: true }, [{ kind: 'failed', at: '2026-10-23T00:00:00.000Z' }]])
  })
})

describe('failed tab', () => {
  const failedRun = (overrides: Partial<Run> = {}): Run => runWith({ phase: { kind: 'failed', at: T0, reason: 'result.json is invalid', tabClosed: false }, history: [{ kind: 'failed', at: T0 }], ...overrides })
  const stop = (file: string) => [{ file, request: { type: 'stop' as const, runId: 'run-a' } }]

  it('A37 / A53: when the listing is complete and neither tab nor agent is visible, sets tabClosed: true and adds no log, notification, or history. When the listing is incomplete, stays false and emits no log', () => {
    const incomplete = tick(stateWith({ runs: [failedRun()] }), obsAt(at(1), { orca: seen({ terminals: [], complete: false }) }))
    expect([incomplete.effects, onlyRun(incomplete.state).phase]).toEqual([[], { kind: 'failed', at: '2026-10-23T00:00:00.000Z', reason: 'result.json is invalid', tabClosed: false }])
    const vanished = tick(stateWith({ runs: [failedRun()] }), obsAt(at(1), { orca: seen({ terminals: [] }) }))
    const run = onlyRun(vanished.state)
    expect([vanished.effects, run.phase, run.history, run.orca]).toEqual([[], { kind: 'failed', at: '2026-10-23T00:00:00.000Z', reason: 'result.json is invalid', tabClosed: true }, [{ kind: 'failed', at: '2026-10-23T00:00:00.000Z' }], REF])
  })

  it('A37: does not change tabClosed in a cycle where the Orca observation failed', () => {
    const { state } = tick(stateWith({ runs: [failedRun()] }), obsAt(at(1), { orca: { ok: false, error: 'down' } }))
    expect(onlyRun(state).phase).toEqual({ kind: 'failed', at: '2026-10-23T00:00:00.000Z', reason: 'result.json is invalid', tabClosed: false })
  })

  it('A40: stays false when only an agent is visible, stays true even if the tab becomes visible after being treated as closed, and does not rewrite the handle', () => {
    const agentOnly = tick(stateWith({ runs: [failedRun()] }), obsAt(at(1), { orca: seen({ terminals: [], agents: [agent('done', T0)] }) }))
    expect(onlyRun(agentOnly.state).phase).toMatchObject({ kind: 'failed', tabClosed: false })
    const renamed = { ...TERMINAL, handle: 'term_z' }
    const visible = tick(stateWith({ runs: [failedRun()] }), obsAt(at(1), { orca: seen({ terminals: [renamed] }) }))
    expect([visible.effects, onlyRun(visible.state).phase, onlyRun(visible.state).orca]).toEqual([[], { kind: 'failed', at: '2026-10-23T00:00:00.000Z', reason: 'result.json is invalid', tabClosed: false }, REF])
    const closed = failedRun({ phase: { kind: 'failed', at: T0, reason: 'result.json is invalid', tabClosed: true } })
    const reappeared = tick(stateWith({ runs: [closed] }), obsAt(at(1), { orca: seen() }))
    expect(onlyRun(reappeared.state).phase).toMatchObject({ kind: 'failed', tabClosed: true })
  })

  it('I9: a failed run with no tab reference stays tabClosed: false even if the tab is absent from a complete listing', () => {
    const { state } = tick(stateWith({ runs: [failedRun({ orca: null })] }), obsAt(at(1), { orca: seen({ terminals: [] }) }))
    expect(onlyRun(state).phase).toMatchObject({ kind: 'failed', tabClosed: false })
  })

  it('A38: stop on a failed run whose tab is visible emits close and stays false, stays false if close returns ptyKilled: null, and becomes true if the tab is gone in the next cycle', () => {
    const stopped = tick(stateWith({ runs: [failedRun()] }), obsAt(at(1), { orca: seen(), requests: stop('s1.json') }))
    expect(stopped.effects).toEqual([{ type: 'close', runId: 'run-a', handle: 'term_a' }, { type: 'consumeRequest', file: 's1.json' }])
    expect(onlyRun(stopped.state).phase).toMatchObject({ kind: 'failed', tabClosed: false })
    const unconfirmed = applyClose(stopped.state, 'run-a', { ok: true, ptyKilled: null }, at(1))
    expect(onlyRun(unconfirmed).phase).toMatchObject({ kind: 'failed', tabClosed: false })
    const next = tick(unconfirmed, obsAt(at(2), { orca: seen({ terminals: [] }) }))
    expect([next.effects, onlyRun(next.state).phase]).toEqual([[], { kind: 'failed', at: '2026-10-23T00:00:00.000Z', reason: 'result.json is invalid', tabClosed: true }])
  })

  it('A39: stop on a failed run with no tab reference and no pane.json does not emit close and sets tabClosed: true', () => {
    const { state, effects } = tick(stateWith({ runs: [failedRun({ orca: null })] }), obsAt(at(1), { orca: seen(), requests: stop('s1.json') }))
    expect(effects).toEqual([{ type: 'consumeRequest', file: 's1.json' }])
    const run = onlyRun(state)
    expect([run.phase, run.orca, run.history]).toEqual([{ kind: 'failed', at: '2026-10-23T00:00:00.000Z', reason: 'result.json is invalid', tabClosed: true }, null, [{ kind: 'failed', at: '2026-10-23T00:00:00.000Z' }]])
  })

  it('A39: even with no tab reference, if the tab recovered from pane.json is visible, emits close and stays false awaiting the applyClose result', () => {
    const paneFromFile: OrcaRef = { handle: 'term_p', tabId: 'tab-a', paneKey: 'tab-a:leaf-a', ptyId: '' }
    const { state, effects } = tick(stateWith({ runs: [failedRun({ orca: null })] }), obsAt(at(1), { orca: seen(), panes: { 'run-a': paneFromFile }, requests: stop('s1.json') }))
    expect(effects).toEqual([{ type: 'close', runId: 'run-a', handle: 'term_a' }, { type: 'consumeRequest', file: 's1.json' }])
    expect([onlyRun(state).phase, onlyRun(state).orca]).toEqual([{ kind: 'failed', at: '2026-10-23T00:00:00.000Z', reason: 'result.json is invalid', tabClosed: false }, paneFromFile])
  })

  it('R6: stop on a failed run whose tab is not visible in an incomplete Orca listing also sets tabClosed: true as cleanup', () => {
    const { state, effects } = tick(stateWith({ runs: [failedRun()] }), obsAt(at(1), { orca: seen({ terminals: [], complete: false }), requests: stop('s1.json') }))
    expect(effects).toEqual([{ type: 'consumeRequest', file: 's1.json' }])
    expect(onlyRun(state).phase).toMatchObject({ kind: 'failed', tabClosed: true })
  })

  it('I9: sending stop to a failed run with a tab reference while Orca is down consumes the request, does not emit close, and stays tabClosed: false. It becomes true if the tab is gone in tracking after recovery', () => {
    const down = { ok: false as const, error: 'down' }
    const during = tick(stateWith({ runs: [failedRun()] }), obsAt(at(1), { orca: down, requests: stop('s1.json') }))
    expect(during.effects).toEqual([{ type: 'consumeRequest', file: 's1.json' }, { type: 'notify', key: 'orca-outage', title: 'orcapod: Orca unreachable', message: 'down' }])
    const run = onlyRun(during.state)
    expect([run.phase, run.orca, run.history]).toEqual([{ kind: 'failed', at: '2026-10-23T00:00:00.000Z', reason: 'result.json is invalid', tabClosed: false }, REF, [{ kind: 'failed', at: '2026-10-23T00:00:00.000Z' }]])
    const back = tick(during.state, obsAt(at(2), { orca: seen({ terminals: [] }) }))
    expect(onlyRun(back.state).phase).toEqual({ kind: 'failed', at: '2026-10-23T00:00:00.000Z', reason: 'result.json is invalid', tabClosed: true })
  })

  it('I9: even while Orca is down, stop on a failed run whose reference was recovered from pane.json copies the reference and stays tabClosed: false, and becomes true if there is neither a reference nor pane.json', () => {
    const down = { ok: false as const, error: 'down' }
    const paneFromFile: OrcaRef = { handle: 'term_p', tabId: 'tab-a', paneKey: 'tab-a:leaf-a', ptyId: '' }
    const recovered = tick(stateWith({ runs: [failedRun({ orca: null })] }), obsAt(at(1), { orca: down, panes: { 'run-a': paneFromFile }, requests: stop('s1.json') }))
    expect([onlyRun(recovered.state).phase, onlyRun(recovered.state).orca]).toEqual([{ kind: 'failed', at: '2026-10-23T00:00:00.000Z', reason: 'result.json is invalid', tabClosed: false }, paneFromFile])
    const unknown = tick(stateWith({ runs: [failedRun({ orca: null })] }), obsAt(at(1), { orca: down, requests: stop('s1.json') }))
    expect([onlyRun(unknown.state).phase, onlyRun(unknown.state).orca]).toEqual([{ kind: 'failed', at: '2026-10-23T00:00:00.000Z', reason: 'result.json is invalid', tabClosed: true }, null])
  })
})

describe('properties of tick', () => {
  it('C20: calling twice with the same input is deeply equal including run IDs, and the input is not mutated', () => {
    const start = stateWith({
      processed: [{ key: '["todos","issue",1,"impl"]', seenAt: T0 }, { key: '["todos","issue",2,"impl"]', seenAt: T0 }],
      pending: [{ ruleKey: IMPL_KEY, project: 'todos', items: [issue(1), issue(2)], fireAt: T0 }],
      runs: [runWith({ id: 'run-w', phase: { kind: 'running', agent: 'working', agentSince: T0, closeAttempts: 0 } })],
    })
    const obs = obsAt(at(11), {
      github: { todos: { ok: true, items: [issue(1)] } },
      orca: seen({ agents: [agent('waiting', at(1))] }),
      requests: [{ file: 'r.json', request: { type: 'run', project: 'todos', item: issue(4), kind: 'feature', now: false } }],
    })
    const stateBefore = structuredClone(start)
    const obsBefore = structuredClone(obs)
    const once = tick(start, obs)
    const twice = tick(start, obs)
    expect(twice).toEqual(once)
    expect(once.state.runs.map((r) => r.id)).toEqual(['run-w', '20261023-0011-243263', '20261023-0011-15f3aa', '20261023-0011-9d5b75'])
    expect(start).toEqual(stateBefore)
    expect(obs).toEqual(obsBefore)
  })

  it('C52: over the 5 cycles queued → launching → starting → running → done, history has 5 entries and does not grow in cycles where the same phase continues', () => {
    const requests = [{ file: 'r.json', request: { type: 'run' as const, project: 'todos', item: issue(123), kind: 'feature', now: false } }]
    const c1 = tick(stateWith(), obsAt(T0, { orca: { ok: false, error: 'down' }, requests }))
    const c1b = tick(c1.state, obsAt(at(0, 20), { orca: { ok: false, error: 'down' } }))
    const c2 = tick(c1b.state, obsAt(at(1)))
    const id = onlyRun(c2.state).id
    const pane: OrcaRef = { handle: 'term_a', tabId: 'tab-a', paneKey: 'tab-a:leaf-a', ptyId: '' }
    const c3 = tick(c2.state, obsAt(at(2), { panes: { [id]: pane }, orca: seen({ agents: [] }) }))
    const c4 = tick(c3.state, obsAt(at(3), { orca: seen({ agents: [agent('working', at(2, 50))] }) }))
    const c4b = tick(c4.state, obsAt(at(4), { orca: seen({ agents: [agent('waiting', at(3, 50))] }) }))
    const results = { [id]: { raw: resultFile('done'), mtime: at(4, 30) } }
    const c5 = tick(c4b.state, obsAt(at(5), { orca: seen({ agents: [agent('done', at(4, 40))] }), results }))
    expect(c5.effects).toEqual([{ type: 'close', runId: id, handle: 'term_a' }])
    const done = applyClose(c5.state, id, { ok: true, ptyKilled: true }, at(5))
    expect(onlyRun(done).history).toEqual([
      { kind: 'queued', at: '2026-10-23T00:00:00.000Z' },
      { kind: 'launching', at: '2026-10-23T00:01:00.000Z' },
      { kind: 'starting', at: '2026-10-23T00:02:00.000Z' },
      { kind: 'running', at: '2026-10-23T00:03:00.000Z' },
      { kind: 'done', at: '2026-10-23T00:05:00.000Z' },
    ])
  })
})


describe('SPEC-ENGLISH-OUTPUT-001 conditions: failure-path wording, launch failure marker, notification keys', () => {
  const launching = () => runWith({ startedAt: null, orca: null, phase: { kind: 'launching', since: T0 }, history: [{ kind: 'launching', at: T0 }] })

  function noticeTexts(effects: Effect[]): string[] {
    return effects.flatMap((effect) => (effect.type === 'notify' ? [effect.title, effect.message] : effect.type === 'log' ? [effect.message] : []))
  }

  function noticeKeys(effects: Effect[]): string[] {
    return effects.flatMap((effect) => (effect.type === 'notify' ? [effect.key] : []))
  }

  function failureScenarios(): { name: string; run: Run; effects: Effect[] }[] {
    const launchFailure = applyLaunch(stateWith({ runs: [launching()] }), 'run-a', { ok: false, error: 'no_pane_key' }, at(1))
    const afterLaunchFailure = tick(launchFailure, obsAt(at(2)))
    const uncertain = tick(stateWith({ runs: [launching()] }), obsAt(at(6)))
    const aiFailed = tick(stateWith({ runs: [runWith()] }), obsAt(at(2), { orca: seen({ agents: [agent('done', at(1, 30))] }), results: { 'run-a': { raw: resultFile('failed', 'tests do not pass'), mtime: at(1) } } }))
    const brokenResult = tick(stateWith({ runs: [runWith({ phase: { kind: 'running', agent: 'working', agentSince: T0, invalidResultSince: T0, closeAttempts: 0 } })] }), obsAt(at(2), { orca: seen({ agents: [agent('working', T0)] }), results: { 'run-a': { raw: '{broken', mtime: at(1) } } }))
    const vanished = tick(stateWith({ runs: [runWith()] }), obsAt(at(2), { orca: seen({ terminals: [] }) }))
    const result = { file: { status: 'done' as const, summary: 'Created PR #130', links: [] }, mtime: at(1) }
    const closeFailed = tick(stateWith({ runs: [runWith({ phase: { kind: 'running', agent: 'done', agentSince: at(2), result, closeAttempts: 3 } })] }), obsAt(at(3), { orca: seen({ agents: [agent('done', at(2))] }) }))
    return [
      { name: 'launch failed (applyLaunch)', run: onlyRun(launchFailure), effects: [] },
      { name: 'cycle after launch failed', run: afterLaunchFailure.state.runs[0], effects: afterLaunchFailure.effects },
      { name: 'launch result unknown', run: onlyRun(uncertain.state), effects: uncertain.effects },
      { name: 'AI reported failed', run: onlyRun(aiFailed.state), effects: aiFailed.effects },
      { name: 'result.json invalid', run: onlyRun(brokenResult.state), effects: brokenResult.effects },
      { name: 'pane and tab disappeared', run: onlyRun(vanished.state), effects: vanished.effects },
      { name: 'close failed 3 times', run: onlyRun(closeFailed.state), effects: closeFailed.effects },
    ]
  }

  it('A1-3: every phase.reason, log message and notification generated along launch failure, unknown launch, AI failure, broken result, vanished pane and close failure is free of Japanese', () => {
    const scenarios = failureScenarios()
    const generated = scenarios.flatMap(({ run, effects }) => [...noticeTexts(effects), 'reason' in run.phase ? run.phase.reason : '', run.lastMessage ?? ''])
    expect(scenarios.map(({ run }) => run.phase.kind)).toEqual(['failed', 'failed', 'failed', 'failed', 'failed', 'aborted', 'done'])
    expect(generated.filter((text) => text !== '').length).toBeGreaterThanOrEqual(10)
    expect(generated.filter((text) => JAPANESE.test(text))).toEqual([])
    expect(scenarios.flatMap(({ run }) => ('reason' in run.phase ? [run.phase.reason] : []))).toEqual([
      'launch failed: no_pane_key',
      'launch failed: no_pane_key',
      'launch result unknown; not relaunching to avoid a duplicate run',
      'AI reported failed: tests do not pass',
      'result.json is invalid',
      'pane and tab disappeared',
    ])
  })

  it('A6-1: the notifications of those paths keep their keys (failed: / aborted: / close-failed:) whatever the language of the title', () => {
    const keys = failureScenarios().flatMap(({ effects }) => noticeKeys(effects))
    expect(keys.sort()).toEqual(['aborted:run-a', 'close-failed:run-a', 'failed:run-a', 'failed:run-a', 'failed:run-a'].sort())
  })

  it('A2-4: a launch failure reported by applyLaunch and a launch whose pane never appears both mark phase.launchFailed; only the second sets launchUncertain', () => {
    const reported = onlyRun(applyLaunch(stateWith({ runs: [launching()] }), 'run-a', { ok: false, error: 'no_pane_key' }, at(1)))
    expect(reported.phase).toEqual({ kind: 'failed', at: at(1), reason: 'launch failed: no_pane_key', tabClosed: false, launchFailed: true })
    expect(reported.launchUncertain).toBeUndefined()
    const unknown = onlyRun(tick(stateWith({ runs: [launching()] }), obsAt(at(6))).state)
    expect(unknown.phase).toEqual({ kind: 'failed', at: at(6), reason: 'launch result unknown; not relaunching to avoid a duplicate run', tabClosed: false, launchFailed: true })
    expect(unknown.launchUncertain).toBe(true)
  })

  it('A2-4 (added): failures that are not launch failures never carry launchFailed', () => {
    const others = failureScenarios().filter(({ name }) => ['AI reported failed', 'result.json invalid'].includes(name))
    expect(others).toHaveLength(2)
    for (const { run } of others) expect(run.phase).not.toHaveProperty('launchFailed')
  })

  it('A10-1: the same waiting event observed over 3 consecutive cycles notifies exactly once', () => {
    const waiting = seen({ agents: [agent('waiting', T0)] })
    const start = stateWith({ runs: [runWith({ phase: { kind: 'running', agent: 'waiting', agentSince: T0, waitingSince: T0, closeAttempts: 0 } })] })
    const c1 = tick(start, obsAt(at(11), { orca: waiting }))
    const c2 = tick(c1.state, obsAt(at(12), { orca: waiting }))
    const c3 = tick(c2.state, obsAt(at(13), { orca: waiting }))
    expect([c1, c2, c3].flatMap(({ effects }) => noticeKeys(effects))).toEqual(['waiting:run-a'])
    expect(onlyRun(c3.state).notified).toEqual(['waiting'])
  })
})
