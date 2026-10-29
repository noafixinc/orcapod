import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { formatStatus, resolveRunId } from '../src/status.ts'
import type { Config, Item, Project, Rule, Run, State } from '../src/types.ts'

const NOW = '2026-10-23T01:41:40.000Z'

let originalTz: string | undefined

beforeAll(() => {
  originalTz = process.env.TZ
  process.env.TZ = 'Asia/Tokyo'
})

afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
})

function secondsBefore(seconds: number): string {
  return new Date(Date.parse(NOW) - seconds * 1000).toISOString()
}

const featureRule: Rule = { target: 'issue', label: 'impl', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 5, enabled: true, bootstrap: 'skip' }
const dependabotRule: Rule = { target: 'pr', label: 'dependencies', kind: 'dependabot', ai: 'codex', batch: 'together', delayMinutes: 30, enabled: true, bootstrap: 'skip' }

function project(overrides: Partial<Project>): Project {
  return { name: 'todos', path: '/Users/me/git/todos', repo: 'taylor/todos', githubAccount: 'taylor', enabled: true, authors: ['OWNER'], bots: ['dependabot[bot]'], rules: [featureRule, dependabotRule], ...overrides }
}

const config: Config = {
  settings: { maxConcurrentPerProject: 2, launch: { claude: 'claude', codex: 'codex' }, notify: { desktop: true, waitingMinutes: 10, maxRunMinutes: 120, queuedMinutes: 30 } },
  kinds: [{ id: 'feature', name: 'Feature' }, { id: 'dependabot', name: 'Dependabot' }],
  projects: [
    project({}),
    project({ name: 'catalog', path: '/Users/me/git/catalog', repo: 'acme-corp/catalog', githubAccount: 'acme-developer', rules: [featureRule] }),
    project({ name: 'old', path: '/Users/me/git/old', repo: 'taylor/old', enabled: false, rules: [featureRule] }),
  ],
  prompts: new Map(),
}

function item(number: number, target: Item['target'] = 'issue'): Item {
  return { project: 'todos', repo: 'taylor/todos', target, number, title: `Title ${number}`, url: `https://github.com/taylor/todos/issues/${number}`, labels: ['impl'], author: { login: 'taylor', bot: false, association: 'OWNER' } }
}

function run(overrides: Partial<Run>): Run {
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
  return { version: 1, processed: [], pending: [], runs: [], watchedRules: [], lastPolledAt: {}, projectErrors: {}, orcaOutageSince: null, consumedRequests: [], configStatus: null, daemonInfo: null, ...overrides }
}

const dependabotItems = [1, 2, 3, 4, 5].map((n) => item(n, 'pr'))

describe('formatStatus', () => {
  it.each([
    [false, config], [true, config], [false, null], [true, null],
  ])('history=%s, configuration=%s: replaces control characters in every section with spaces while keeping newlines, Japanese text, emoji, and the original data', (history, loadedConfig) => {
    const controls = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('').replace('\n', '')
      + Array.from({ length: 33 }, (_, i) => String.fromCharCode(0x7f + i)).join('')
    const unsafe = `\u524d${controls}\u4e2d\ud800\u5f8c\udc00\n\u65e5\u672c\u8a9e😀`
    const safe = `\u524d${' '.repeat(64)}\u4e2d \u5f8c \n\u65e5\u672c\u8a9e😀`
    const state = stateWith({
      projectErrors: { [unsafe]: { since: secondsBefore(60), message: `watch${unsafe}` } },
      pending: [{ ruleKey: JSON.stringify([unsafe, 'issue', unsafe]), project: unsafe, items: [item(1)], fireAt: NOW }],
      runs: [
        run({ id: 'queued-aaaaaa', kindName: `queued${unsafe}`, phase: { kind: 'queued', since: NOW } }),
        run({ id: 'active-bbbbbb', kindName: `active${unsafe}` }),
        run({ id: 'done-cccccc', phase: { kind: 'done', at: NOW, summary: `done${unsafe}`, tabClosed: true } }),
        run({ id: 'failed-dddddd', phase: { kind: 'failed', at: NOW, reason: `failed${unsafe}`, tabClosed: true } }),
        run({ id: 'aborted-eeeeee', phase: { kind: 'aborted', at: NOW, reason: `aborted${unsafe}` } }),
      ],
    })
    const displayConfig = loadedConfig === null ? null : { ...loadedConfig, projects: [project({ name: unsafe, githubAccount: `account${unsafe}` })] }
    const before = JSON.stringify({ state, config: displayConfig })
    const output = formatStatus({ state, config: displayConfig, daemonPid: 4242, now: NOW, history })

    for (const text of ['watch', 'queued', 'active', 'done', 'failed', 'aborted']) expect(output).toContain(`${text}${safe}`)
    expect(output).toContain(`${safe} / issue / ${safe}`)
    if (displayConfig !== null) expect(output).toContain(`account${safe}`)
    const unsafeCodePoints = [...output].filter((char) => {
      const code = char.codePointAt(0) ?? 0
      return (code < 0x20 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff)
    })
    expect(unsafeCodePoints).toEqual([])
    expect(output).toContain('\nWatching:\n')
    expect(JSON.stringify({ state, config: displayConfig })).toBe(before)
  })

  it('shows daemon, watching, pending, queue, running, and recent', () => {
    const state = stateWith({
      lastPolledAt: { todos: secondsBefore(12) },
      projectErrors: { catalog: { since: secondsBefore(180), message: 'gh: Not Found (HTTP 404)' } },
      pending: [{ ruleKey: '["todos","pr","dependencies"]', project: 'todos', items: dependabotItems, fireAt: '2026-10-23T01:46:10.000Z' }],
      runs: [
        run({}),
        run({ id: '20261023-0940-aa11bb', items: [item(124)], createdAt: secondsBefore(100), startedAt: null, phase: { kind: 'queued', since: secondsBefore(100) }, bypassLimit: true }),
        run({ id: '20261023-0930-8be0d2', rule: dependabotRule, kindName: 'Dependabot', items: dependabotItems, phase: { kind: 'done', at: '2026-10-23T01:02:00.000Z', summary: '4 merged, 1 needs attention #88', tabClosed: true } }),
        run({ id: '20261023-0900-c0ffee', items: [item(99)], phase: { kind: 'failed', at: '2026-10-23T00:50:00.000Z', reason: 'AI reported failed: tests do not pass', tabClosed: true } }),
      ],
    })
    expect(formatStatus({ state, config, daemonPid: 4242, now: NOW, history: false })).toBe([
      'daemon: running (pid 4242)',
      'Watching:',
      '  todos (taylor, poll 12s ago)',
      '  catalog (acme-developer, not polled yet, watch error: gh: Not Found (HTTP 404) (since 3m ago))',
      '  old (disabled)',
      'Pending:',
      '  todos / pr / dependencies — 5 items, launches in 4m (batched)',
      'Queue:',
      '  aa11bb "#124 Feature" waiting 1m (--now)',
      'Running:',
      '  3f9a1c "#123 Feature" running/working 24m',
      'Unresolved:',
      '  c0ffee "#99 Feature" not investigated → orcapod incident c0ffee',
      'Recent:',
      '  8be0d2 "Dependabot ×5" done 10-23 10:02 "4 merged, 1 needs attention #88"',
      '  c0ffee "#99 Feature" failed 10-23 09:50 (AI reported failed: tests do not pass)',
    ].join('\n'))
  })

  it('when the daemon is stopped, the configuration is unreadable, and Orca is unreachable, shows that fact and the watching section derivable from state alone, and shows "none" for empty sections', () => {
    const state = stateWith({
      lastPolledAt: { todos: secondsBefore(75) },
      projectErrors: { gone: { since: secondsBefore(7200), message: 'folder not found: /Users/me/git/gone' } },
      orcaOutageSince: '2026-10-23T01:30:00.000Z',
    })
    expect(formatStatus({ state, config: null, daemonPid: null, now: NOW, history: false })).toBe([
      'daemon: not running (start it with orcapod start)',
      'config: unreadable (check it with orcapod validate)',
      'Orca: unreachable since 10-23 10:30',
      'Watching:',
      '  todos (poll 1m ago)',
      '  gone (not polled yet, watch error: folder not found: /Users/me/git/gone (since 2h 0m ago))',
      'Pending: none',
      'Queue: none',
      'Running: none',
      'Recent: none',
    ].join('\n'))
  })

  it('pending is ordered by earliest launch and annotates expiry, disabled, monitoring error, and rules removed from the configuration', () => {
    const state = stateWith({
      projectErrors: { catalog: { since: secondsBefore(60), message: 'gh: HTTP 502' } },
      pending: [
        { ruleKey: '["old","issue","impl"]', project: 'old', items: [item(3)], fireAt: secondsBefore(-3 * 3600 - 300) },
        { ruleKey: '["todos","issue","impl"]', project: 'todos', items: [item(1), item(2)], fireAt: secondsBefore(30) },
        { ruleKey: '["catalog","issue","impl"]', project: 'catalog', items: [item(4)], fireAt: secondsBefore(-45) },
        { ruleKey: '["todos","issue","urgent"]', project: 'todos', items: [item(5)], fireAt: secondsBefore(-600) },
      ],
    })
    const lines = formatStatus({ state, config, daemonPid: 4242, now: NOW, history: false }).split('\n')
    expect(lines.slice(lines.indexOf('Pending:'), lines.indexOf('Queue: none'))).toEqual([
      'Pending:',
      '  todos / issue / impl — 2 items, due (launches next cycle)',
      '  catalog / issue / impl — 1 item, launches in 45s (watch error: no launch until it clears)',
      '  todos / issue / urgent — 1 item, launches in 10m (rule not in config, dropped when due)',
      '  old / issue / impl — 1 item, launches in 3h 5m (disabled: no launch until re-enabled)',
    ])
  })

  it('running counts launching from the start of the phase and starting / running from startedAt, and attaches the agent to running', () => {
    const state = stateWith({
      runs: [
        run({ id: 'run-launching-aaaaaa', startedAt: null, phase: { kind: 'launching', since: secondsBefore(20) } }),
        run({ id: 'run-starting-bbbbbb', startedAt: secondsBefore(95), phase: { kind: 'starting', since: secondsBefore(95) } }),
        run({ id: 'run-running-cccccc', startedAt: secondsBefore(125 * 60), phase: { kind: 'running', agent: 'waiting', agentSince: secondsBefore(600), closeAttempts: 0 } }),
      ],
    })
    const lines = formatStatus({ state, config, daemonPid: 4242, now: NOW, history: false }).split('\n')
    expect(lines.slice(lines.indexOf('Running:'), lines.indexOf('Recent: none'))).toEqual([
      'Running:',
      '  aaaaaa "#123 Feature" launching 20s',
      '  bbbbbb "#123 Feature" starting 1m',
      '  cccccc "#123 Feature" running/waiting 2h 5m',
    ])
  })

  it('recent shows up to 10 entries, newest finish time first, and annotates a done run whose tab could not be closed with "tab remains"', () => {
    const finished = Array.from({ length: 12 }, (_, i) => run({
      id: `20261023-0000-run0${String(i).padStart(2, '0')}`,
      items: [item(100 + i)],
      phase: i === 11
        ? { kind: 'done', at: secondsBefore(60), summary: 'created PR #130', tabClosed: false }
        : { kind: 'aborted', at: secondsBefore(3600 - i * 60), reason: 'orcapod stop' },
    }))
    const lines = formatStatus({ state: stateWith({ runs: finished }), config, daemonPid: 4242, now: NOW, history: false }).split('\n')
    expect(lines.slice(lines.indexOf('Recent:'))).toEqual([
      'Recent:',
      '  run011 "#111 Feature" done 10-23 10:40 "created PR #130" (tab remains)',
      '  run010 "#110 Feature" aborted 10-23 09:51 (orcapod stop)',
      '  run009 "#109 Feature" aborted 10-23 09:50 (orcapod stop)',
      '  run008 "#108 Feature" aborted 10-23 09:49 (orcapod stop)',
      '  run007 "#107 Feature" aborted 10-23 09:48 (orcapod stop)',
      '  run006 "#106 Feature" aborted 10-23 09:47 (orcapod stop)',
      '  run005 "#105 Feature" aborted 10-23 09:46 (orcapod stop)',
      '  run004 "#104 Feature" aborted 10-23 09:45 (orcapod stop)',
      '  run003 "#103 Feature" aborted 10-23 09:44 (orcapod stop)',
      '  run002 "#102 Feature" aborted 10-23 09:43 (orcapod stop)',
    ])
  })

  it('A51: a failed run whose tab remains is annotated with "(tab remains)" in both recent and --history, and aborted is not', () => {
    const state = stateWith({
      runs: [
        run({ id: '20261023-0900-c0ffee', items: [item(99)], createdAt: '2026-10-23T00:00:00.000Z', phase: { kind: 'failed', at: '2026-10-23T00:50:00.000Z', reason: 'result.json is invalid', tabClosed: false } }),
        run({ id: '20261023-0901-dead00', items: [item(98)], createdAt: '2026-10-23T00:01:00.000Z', phase: { kind: 'aborted', at: '2026-10-23T00:40:00.000Z', reason: 'orcapod stop' } }),
      ],
    })
    const recent = formatStatus({ state, config, daemonPid: 4242, now: NOW, history: false }).split('\n')
    expect(recent.slice(recent.indexOf('Recent:'))).toEqual([
      'Recent:',
      '  c0ffee "#99 Feature" failed 10-23 09:50 (result.json is invalid) (tab remains)',
      '  dead00 "#98 Feature" aborted 10-23 09:40 (orcapod stop)',
    ])
    const history = formatStatus({ state, config, daemonPid: 4242, now: NOW, history: true }).split('\n')
    expect(history.slice(history.indexOf('History (2):'))).toEqual([
      'History (2):',
      '  10-23 09:01 dead00 "#98 Feature" aborted 10-23 09:40 (orcapod stop)',
      '  10-23 09:00 c0ffee "#99 Feature" failed 10-23 09:50 (result.json is invalid) (tab remains)',
    ])
  })

  it('--history shows all runs, newest creation first, instead of recent', () => {
    const state = stateWith({
      runs: [
        run({ id: '20261023-0900-c0ffee', items: [item(99)], createdAt: '2026-10-23T00:00:00.000Z', phase: { kind: 'failed', at: '2026-10-23T00:50:00.000Z', reason: 'result.json is invalid', tabClosed: true } }),
        run({ id: '20261023-0917-3f9a1c', createdAt: '2026-10-23T00:17:00.000Z' }),
        run({ id: '20261023-0940-aa11bb', items: [item(124)], createdAt: '2026-10-23T00:40:00.000Z', startedAt: null, phase: { kind: 'queued', since: '2026-10-23T00:40:00.000Z' } }),
      ],
    })
    const lines = formatStatus({ state, config, daemonPid: 4242, now: NOW, history: true }).split('\n')
    expect(lines.slice(lines.indexOf('History (3):'))).toEqual([
      'History (3):',
      '  10-23 09:40 aa11bb "#124 Feature" queued',
      '  10-23 09:17 3f9a1c "#123 Feature" running/working',
      '  10-23 09:00 c0ffee "#99 Feature" failed 10-23 09:50 (result.json is invalid)',
    ])
    expect(lines).not.toContain('Recent: none')
  })
})

describe('resolveRunId', () => {
  const runs = [run({ id: '20261023-0917-3f9a1c' }), run({ id: '20261023-0918-77ab12' }), run({ id: '20261024-1000-77ab12' })]

  it.each([
    ['last 6 characters', '3f9a1c', { ok: true, id: '20261023-0917-3f9a1c' }],
    ['full id', '20261023-0918-77ab12', { ok: true, id: '20261023-0918-77ab12' }],
    ['ambiguous last 6 characters', '77ab12', { ok: false, error: '77ab12 matches multiple runs: 20261023-0918-77ab12, 20261024-1000-77ab12 (give the full id)' }],
    ['no match', 'ffffff', { ok: false, error: 'no run matches ffffff (give the last 6 characters of the id or the full id; see orcapod status --history)' }],
    ['partial id that is not the last 6 characters', '0917-3f9a1c', { ok: false, error: 'no run matches 0917-3f9a1c (give the last 6 characters of the id or the full id; see orcapod status --history)' }],
  ])('%s', (_name, query, expected) => {
    expect(resolveRunId(runs, query)).toEqual(expected)
  })
})
