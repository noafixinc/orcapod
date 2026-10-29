import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clampDetailScroll, displayWidth, fitWidth, initialUi, reduceKey, renderScreen } from '../src/monitor-layout.ts'
import type { Key, ScreenLine, ScreenSize, UiState } from '../src/monitor-layout.ts'
import { ruleKey } from '../src/config.ts'
import { buildMonitorModel } from '../src/monitor-model.ts'
import type { DetailContent, MonitorModel } from '../src/monitor-model.ts'
import type { Config, Item, Pending, Project, Rule, Run, State } from '../src/types.ts'

const NOW = '2026-10-23T01:00:00.000Z'
const HOME = '/Users/me/git/orcapod'
const SMALL: ScreenSize = { width: 80, height: 24 }
const LARGE: ScreenSize = { width: 126, height: 40 }
const LOG = ['2026-10-23 09:41:20 info poll todos: open 14, new 0', '2026-10-23 09:41:40 warn run 9c01de: queued 3m', '  at runCycle (src/daemon.ts:42)']

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

function project(name: string): Project {
  return { name, path: `/Users/me/git/${name}`, repo: `taylor/${name}`, githubAccount: 'taylor', enabled: true, authors: ['OWNER'], bots: [], rules: [featureRule] }
}

function configWith(projectCount: number): Config {
  return {
    settings: { maxConcurrentPerProject: 2, launch: { claude: 'claude', codex: 'codex' }, notify: { desktop: true, waitingMinutes: 10, maxRunMinutes: 120, queuedMinutes: 30 } },
    kinds: [{ id: 'feature', name: 'Feature' }],
    projects: Array.from({ length: projectCount }, (_, i) => project(i === 0 ? 'todos' : `proj${i}`)),
    prompts: new Map([['feature.claude', 'x']]),
  }
}

function item(number: number): Item {
  return { project: 'todos', repo: 'taylor/todos', target: 'issue', number, title: `Title ${number}`, url: `https://github.com/taylor/todos/issues/${number}`, labels: ['impl'], author: { login: 'taylor', bot: false, association: 'OWNER' } }
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
    configStatus: { loadedAt: secondsBefore(3600), sha256: 'a'.repeat(64), error: null },
    daemonInfo: { pid: 4242, startedAt: secondsBefore(7200), lastCycleAt: secondsBefore(3), lastCycleError: null, orcaVersion: '1.4.217', cycleSeconds: 20 },
    ...overrides,
  }
}

function modelOf(state: State | null, projectCount = 3, home = HOME): MonitorModel {
  const config = configWith(projectCount)
  return buildMonitorModel({ home, state, stateError: null, stateMtime: secondsBefore(3), daemonPid: 4242, lockError: null, config: { kind: 'running', config, loadedAt: secondsBefore(3600) }, now: NOW })
}

function numbered(prefix: string, count: number, make: (id: string, i: number) => Run): Run[] {
  return Array.from({ length: count }, (_, i) => make(`20261023-0000-${prefix}${String(i).padStart(2, '0')}`, i))
}

function shapedState(counts: { attention: number; active: number; waiting: number; recent: number }): State {
  return stateWith({
    runs: [
      ...numbered('fail', counts.attention, (id, i) => runWith({ id, items: [item(100 + i)], phase: { kind: 'failed', at: secondsBefore(600 + i), reason: 'result.json is invalid', tabClosed: false } })),
      ...numbered('actv', counts.active, (id, i) => runWith({ id, items: [item(200 + i)] })),
      ...numbered('wait', counts.waiting, (id, i) => runWith({ id, items: [item(300 + i)], startedAt: null, phase: { kind: 'queued', since: secondsBefore(60) } })),
      ...numbered('done', counts.recent, (id, i) => runWith({ id, items: [item(400 + i)], phase: { kind: 'done', at: secondsBefore(900 + i * 60), summary: `summary ${i}`, tabClosed: true } })),
    ],
  })
}

function hasControlOrLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i)
    if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)) return true
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  return false
}

function expectFullScreen(lines: ScreenLine[], size: ScreenSize): void {
  expect(lines).toHaveLength(size.height)
  expect(lines.map((line) => displayWidth(line.text))).toEqual(Array.from({ length: size.height }, () => size.width))
  expect(lines.filter((line) => hasControlOrLoneSurrogate(line.text))).toEqual([])
}

function press(ui: UiState, keys: Key[], model: MonitorModel, size: ScreenSize, detail: DetailContent | null = null): UiState {
  return keys.reduce((current, key) => {
    const result = reduceKey(current, key, model, size, detail)
    if (result.kind === 'quit') throw new Error(`${key} quit`)
    return result.ui
  }, ui)
}

function texts(lines: ScreenLine[]): string[] {
  return lines.map((line) => line.text)
}

function selectedLines(lines: ScreenLine[]): string[] {
  return lines.filter((line) => line.inverse).map((line) => line.text)
}

function viewsOf(model: MonitorModel): { name: string; ui: UiState; detail: DetailContent | null }[] {
  const base = initialUi(model)
  const run = runWith({ notified: ['waiting'], orca: { handle: 'term-1', tabId: 'tab-1', paneKey: 'pane-1', ptyId: 'pty-1' }, history: [{ kind: 'queued', at: secondsBefore(1800) }, { kind: 'running', at: secondsBefore(1400) }] })
  const pending: Pending = { ruleKey: '["todos","issue","impl"]', project: 'todos', items: [item(1), item(2)], fireAt: secondsBefore(-270) }
  return [
    { name: 'main', ui: base, detail: null },
    { name: 'history', ui: { ...base, view: { kind: 'history' } }, detail: null },
    { name: 'config', ui: { ...base, view: { kind: 'config' } }, detail: null },
    { name: 'help', ui: { ...base, view: { kind: 'help' } }, detail: null },
    { name: 'detail (run)', ui: { ...base, view: { kind: 'detail', ref: { kind: 'run', runId: run.id } } }, detail: { kind: 'run', run, resultJson: { kind: 'text', text: '{\n  "status": "failed",\n  "summary": "type error"\n}\n' }, lastMessage: { kind: 'text', text: 'please decide the approach' } } },
    { name: 'detail (pending)', ui: { ...base, view: { kind: 'detail', ref: { kind: 'pending', ruleKey: pending.ruleKey } } }, detail: { kind: 'pending', pending, rule: featureRule } },
    { name: 'detail (project)', ui: { ...base, view: { kind: 'detail', ref: { kind: 'project', name: 'todos' } } }, detail: { kind: 'project', name: 'todos', project: project('todos'), error: { since: secondsBefore(300), message: 'HTTP 404: Not Found' } } },
  ]
}

it('fitWidth adjusts width through the existing import path too', () => {
  expect(fitWidth('\u6f22\u5b57\u304b\u306a', 6)).toBe('\u6f22\u5b57… ')
})

describe('renderScreen: width and height', () => {
  it.each([
    [{ width: 79, height: 24 }, `Needs 80×24 or larger (now 79×24)${' '.repeat(46)}`],
    [{ width: 80, height: 23 }, `Needs 80×24 or larger (now 80×23)${' '.repeat(47)}`],
  ])('A25: %o renders only the single guidance line, fitted to the width', (size, expected) => {
    const model = modelOf(shapedState({ attention: 1, active: 1, waiting: 1, recent: 1 }))
    expect(renderScreen(model, initialUi(model), size, LOG, null)).toEqual([{ text: expected, inverse: false }])
  })

  it.each([
    [{ width: 10, height: 5 }, 'Needs 80×…'],
    [{ width: 1, height: 1 }, '…'],
    [{ width: 0, height: 0 }, ''],
    [{ width: 79, height: 1000 }, `Needs 80×24 or larger (now 79×1000)${' '.repeat(44)}`],
    [{ width: 1000, height: 23 }, `Needs 80×24 or larger (now 1000×23)${' '.repeat(965)}`],
  ])('A25 (additional): even for an extremely small or elongated terminal such as %o, the guidance line is exactly the terminal width and nothing throws', (size, expected) => {
    const model = modelOf(shapedState({ attention: 1, active: 1, waiting: 1, recent: 1 }))
    expect(renderScreen(model, initialUi(model), size, LOG, null)).toEqual([{ text: expected, inverse: false }])
  })

  it('A23: at 126×40, a running row lays out the last response containing ZWJ emoji sequences, combining characters, half-width katakana, kanji and ESC with only ESC replaced by a space, matching the literal column counts', () => {
    const model = modelOf(stateWith({ runs: [runWith({ id: '20261023-0001-aaaaaa', lastMessage: '👨‍👩‍👧 é \uff76\uff85 \u6f22\u5b57\u001b[31m' })] }), 1)
    const row = texts(renderScreen(model, initialUi(model), LARGE, [], null)).find((line) => line.includes('last:'))
    expect(row).toBe(`│   aaaaaa  todos      #123 Feature         running/working 24m last: 👨‍👩‍👧 é \uff76\uff85 \u6f22\u5b57 [31m${' '.repeat(38)}│`)
  })

  it('A25: exactly 80×24 gives all 24 rows at width 80', () => {
    const model = modelOf(shapedState({ attention: 1, active: 1, waiting: 1, recent: 1 }))
    expectFullScreen(renderScreen(model, initialUi(model), SMALL, LOG, null), SMALL)
  })

  it('A27: rendering the standard, history, configuration, help and detail (run / pending / project) views at 80×24 and 126×40 gives every row exactly the terminal width and a row count equal to the terminal height', () => {
    const model = modelOf(shapedState({ attention: 2, active: 3, waiting: 2, recent: 30 }), 4)
    for (const { ui, detail } of viewsOf(model)) {
      for (const size of [SMALL, LARGE]) expectFullScreen(renderScreen(model, ui, size, LOG, detail), size)
    }
  })

  it.each(['\ufe0f', '\u3099', '\u309a', '\u0301'])('a zero-width character at the start of a cell (U+%s) keeps every row at the terminal width', (mark) => {
    const model = modelOf(stateWith({ runs: [runWith({ id: '20261023-0001-aaaaaa', lastMessage: `${mark}abc`, phase: { kind: 'failed', at: secondsBefore(60), reason: `${mark}reason`, tabClosed: false } })] }), 1)
    for (const size of [SMALL, LARGE]) expectFullScreen(renderScreen(model, initialUi(model), size, [`${mark}log`], null), size)
  })

  it('A56: for a model from the same load, the last-updated string in every view heading is the same', () => {
    const model = modelOf(shapedState({ attention: 1, active: 1, waiting: 1, recent: 1 }))
    const headers = viewsOf(model).map(({ ui, detail }) => renderScreen(model, ui, SMALL, LOG, detail)[0].text)
    expect(new Set(headers).size).toBe(1)
    expect(headers[0]).toContain('updated 3s ago')
    const reloaded = reduceKey(initialUi(model), 'r', model, SMALL)
    if (reloaded.kind !== 'reload') throw new Error('r did not reload')
    const afterReload = viewsOf(model).map(({ ui, detail }) => renderScreen(model, { ...reloaded.ui, view: ui.view }, SMALL, LOG, detail)[0].text)
    expect(afterReload).toEqual(headers)
  })

  it('A23: even with a summary / last response / log containing control characters, emoji, combining characters and half-width katakana and a 200-character home, every row of every view is width 80 / 126 and contains no control characters', () => {
    const home = `/Users/me/${'\u6df1\u3044\u968e\u5c64/'.repeat(38)}`
    expect(home).toHaveLength(200)
    const state = stateWith({
      runs: [
        runWith({ id: '20261023-0001-aaaaaa', lastMessage: '👨‍👩‍👧 é \uff76\uff85 \u6f22\u5b57\u001b[31m' }),
        runWith({ id: '20261023-0002-bbbbbb', phase: { kind: 'done', at: secondsBefore(60), summary: '\u001b[2J\u001b]0;x\u0007\u6539\u884c\n\u30bf\u30d6\t\u009b31m', tabClosed: true } }),
      ],
      projectErrors: { 'ev\u001bil': { since: secondsBefore(60), message: 'x\u0007y\ud800' } },
    })
    const model = modelOf(state, 3, home)
    const log = [...LOG, '2026-10-23 09:42:00 error \u001b[2J\u6d88\u53bb\u009b', '\ud800\u5b64\u7acb']
    for (const { ui, detail } of viewsOf(model)) {
      for (const size of [SMALL, LARGE]) {
        const lines = renderScreen(model, ui, size, log, detail)
        expectFullScreen(lines, size)
        expect(lines.filter((line) => line.text.includes('\u001b') || line.text.includes('\u0007') || line.text.includes('\n') || line.text.includes('\t'))).toEqual([])
      }
    }
  })

  it('A26: rendering the same model at 80×24 after 126×40 gives every row at width 80, and the last response disappears but the rules of the project remain', () => {
    const model = modelOf(stateWith({ runs: [runWith({ lastMessage: 'adding tests' })] }))
    const ui = initialUi(model)
    const large = texts(renderScreen(model, ui, LARGE, LOG, null))
    expect(large.some((line) => line.includes('last: adding tests'))).toBe(true)
    expect(large.some((line) => line.includes('issue/impl→feature claude 5m'))).toBe(true)
    const small = renderScreen(model, ui, SMALL, LOG, null)
    expectFullScreen(small, SMALL)
    expect(texts(small).filter((line) => line.includes('last:'))).toEqual([])
    expect(texts(small).filter((line) => line.includes('issue/impl→feature'))).toHaveLength(3)
  })
})

describe('renderScreen: tier layout of the standard screen', () => {
  it('even when the run listing has spare space, the selection inversion applies only to the project row', () => {
    const model = modelOf(stateWith({}), 1)
    for (const size of [SMALL, LARGE]) {
      const lines = renderScreen(model, initialUi(model), size, [], null)
      expectFullScreen(lines, size)
      expect(selectedLines(lines)).toHaveLength(1)
      expect(selectedLines(lines)[0]).toContain('todos')
    }
  })

  it('each status section places one blank row after its data rows', () => {
    const model = modelOf(shapedState({ attention: 1, active: 1, waiting: 1, recent: 1 }))
    const lines = texts(renderScreen(model, initialUi(model), LARGE, [], null))
    const end = lines.findIndex((line) => line.startsWith('└'))
    const boundaries = lines.map((line, index) => line.startsWith('├') || index === end ? index : -1).filter((index) => index >= 0 && index <= end)
    expect(boundaries).toHaveLength(4)
    for (const index of boundaries) {
      expect(lines[index - 1]).toBe(`│${' '.repeat(LARGE.width - 2)}│`)
      expect(lines[index - 2]).not.toBe(`│${' '.repeat(LARGE.width - 2)}│`)
    }
  })

  it('even with 80×24, 6 rules and empty status sections, the trailing blank row and closing border of every section are kept', () => {
    const model = modelOf(stateWith({}), 6)
    const lines = renderScreen(model, initialUi(model), SMALL, [], null)
    expectFullScreen(lines, SMALL)
    const text = texts(lines)
    expect(text[8]).toBe(`│${' '.repeat(78)}│`)
    expect(text[9]).toBe(`└${'─'.repeat(78)}┘`)
    expect(text[10]).toContain('┌ Projects 6 / rules 6')
    expect(text.slice(11, 17).filter((line) => line.includes('issue/impl'))).toHaveLength(6)
    expect(text[18]).toContain('┌ Log')
  })

  it('rules of the same project can be selected individually, rules beyond the frame are reachable, and the selection is kept after resize', () => {
    const config = configWith(1)
    config.projects[0].rules = Array.from({ length: 15 }, (_, i) => ({ ...featureRule, label: `rule${i}` }))
    const model = buildMonitorModel({ home: HOME, state: stateWith({}), stateError: null, stateMtime: NOW, daemonPid: 4242, lockError: null, config: { kind: 'running', config, loadedAt: NOW }, now: NOW })
    let ui = initialUi(model)
    for (let i = 0; i < 15; i += 1) {
      if (i > 0) ui = press(ui, ['down'], model, SMALL)
      const lines = renderScreen(model, ui, SMALL, [], null)
      expectFullScreen(lines, SMALL)
      expect(selectedLines(lines)).toHaveLength(1)
      expect(selectedLines(lines)[0]).toContain(`issue/rule${i}→`)
      expect(texts(lines)[10]).toContain('┌ Projects 1 / rules 15')
      expect(texts(lines)[9]).toBe(`└${'─'.repeat(SMALL.width - 2)}┘`)
      expect(texts(lines)[18]).toContain('┌ Log')
      expect(press(ui, ['enter'], model, SMALL).view).toEqual({ kind: 'detail', ref: { kind: 'project', name: 'todos', ruleKey: ruleKey('todos', config.projects[0].rules[i]) } })
    }
    for (const size of [LARGE, SMALL]) {
      const lines = renderScreen(model, ui, size, [], null)
      expectFullScreen(lines, size)
      expect(selectedLines(lines)[0]).toContain('issue/rule14→')
    }
    expect(press(ui, ['down'], model, SMALL).selected).toEqual(ui.selected)
    ui = press(ui, Array.from({ length: 14 }, () => 'up'), model, SMALL)
    expect(selectedLines(renderScreen(model, ui, SMALL, [], null))[0]).toContain('issue/rule0→')
  })

  it('the 80×24 standard screen shows heading, tier boxes, log and key guidance in that order, and rows are truncated to the column width', () => {
    const state = stateWith({
      runs: [
        runWith({ id: '20261023-0900-7a44f0', items: [item(119)], phase: { kind: 'failed', at: secondsBefore(300), reason: 'AI reported failed: type error after dependency update', tabClosed: false } }),
        runWith({}),
      ],
      lastPolledAt: { todos: secondsBefore(12) },
    })
    const lines = texts(renderScreen(modelOf(state, 1), initialUi(modelOf(state, 1)), SMALL, LOG, null))
    expect(lines).toEqual([
      ` orcapod monitor  daemon: running pid 4242 (updated 3s ago)  Orca 1.4.217  GitH…`,
      `┌ Attention 1 ${'─'.repeat(65)}┐`,
      '│ ! 7a44f0  todos      #119 Feature   failed 10-23 0… → orcapod incident 7a44f0│',
      `│${' '.repeat(78)}│`,
      `├ Running 1 (todos 1/2) ${'─'.repeat(55)}┤`,
      `│   3f9a1c  todos      #123 Feature   running/working 24m${' '.repeat(22)}│`,
      `│${' '.repeat(78)}│`,
      `├ Pending / queue 0 ${'─'.repeat(59)}┤`,
      `│${' '.repeat(78)}│`,
      `├ Recent (h for all) ${'─'.repeat(58)}┤`,
      `│${' '.repeat(78)}│`,
      `└${'─'.repeat(78)}┘`,
      ...Array.from({ length: 2 }, () => ' '.repeat(80)),
      `┌ Projects 1 / rules 1 (c for full config) ${'─'.repeat(36)}┐`,
      `│   todos      issue/impl→feature claude 5m  taylor  poll 12s ago${' '.repeat(14)}│`,
      `└${'─'.repeat(78)}┘`,
      `┌ Log ${'─'.repeat(73)}┐`,
      `│09:41:20 info poll todos: open 14, new 0${' '.repeat(38)}│`,
      `│09:41:40 warn run 9c01de: queued 3m${' '.repeat(43)}│`,
      `│           at runCycle (src/daemon.ts:42)${' '.repeat(37)}│`,
      `│${' '.repeat(78)}│`,
      `└${'─'.repeat(78)}┘`,
      ' ↑↓ select  Tab next section  Enter detail  h history  c config  l toggle log  …',
    ])
  })

  it('A11: when all tiers fit at 126×40, every row is shown without an "N more" marker, and even with 0 attention items a blank row is placed under the heading', () => {
    const model = modelOf(shapedState({ attention: 0, active: 1, waiting: 1, recent: 2 }), 3)
    const lines = texts(renderScreen(model, initialUi(model), LARGE, LOG, null))
    expectFullScreen(renderScreen(model, initialUi(model), LARGE, LOG, null), LARGE)
    expect(lines[1]).toBe(`┌ Attention none ${'─'.repeat(108)}┐`)
    expect(lines[2]).toBe(`│${' '.repeat(124)}│`)
    expect(lines[3].startsWith('├ Running 1')).toBe(true)
    expect(lines.filter((line) => line.includes(' more'))).toEqual([])
    expect(lines.filter((line) => /actv00|wait00|done00|done01/.test(line))).toHaveLength(4)
    expect(lines.filter((line) => /│ {3}(todos|proj1|proj2) /.test(line))).toHaveLength(3)
  })

  it('A12: at a height that fits if only the recent tier is trimmed, all projects are shown and only the recent tier gets an "N more" marker', () => {
    const model = modelOf(shapedState({ attention: 1, active: 2, waiting: 2, recent: 20 }), 4)
    const ui = { ...initialUi(model), showLog: false }
    const lines = texts(renderScreen(model, ui, SMALL, LOG, null))
    expectFullScreen(renderScreen(model, ui, SMALL, LOG, null), SMALL)
    expect(lines.find((line) => line.startsWith('├ Recent'))).toBe(`├ Recent (h for all)  18 more ${'─'.repeat(49)}┤`)
    expect(lines.find((line) => line.startsWith('┌ Projects'))).toBe(`┌ Projects 4 / rules 4 (c for full config) ${'─'.repeat(36)}┐`)
    expect(lines.filter((line) => /│ {3}(todos|proj1|proj2|proj3) /.test(line))).toHaveLength(4)
    expect(lines.filter((line) => line.includes('done'))).toHaveLength(2)
  })

  it('A10: at 80×24 where attention and running items overflow, the screen scrolls without trimming attention, running or pending, and the selected row stays on screen while all 17 runs are selected in turn', () => {
    const model = modelOf(shapedState({ attention: 6, active: 8, waiting: 3, recent: 10 }), 5)
    let ui = initialUi(model)
    const first = texts(renderScreen(model, ui, SMALL, LOG, null))
    expect(first[1]).toBe(`┌ Attention 6 ${'─'.repeat(65)}┐`)
    expect(first.filter((line) => line.startsWith('├ Recent'))).toEqual([])
    const visited = new Set<string>()
    for (let i = 0; i < 17; i += 1) {
      if (i > 0) ui = press(ui, ['down'], model, SMALL)
      const lines = renderScreen(model, ui, SMALL, LOG, null)
      expectFullScreen(lines, SMALL)
      const selected = ui.selected
      if (selected?.kind !== 'run') throw new Error('no run row is selected')
      const shortId = selected.runId.slice(-6)
      expect(selectedLines(lines)).toHaveLength(1)
      expect(selectedLines(lines)[0]).toContain(shortId)
      visited.add(shortId)
    }
    expect([...visited].sort()).toEqual([
      ...Array.from({ length: 8 }, (_, i) => `actv0${i}`),
      ...Array.from({ length: 6 }, (_, i) => `fail0${i}`),
      ...Array.from({ length: 3 }, (_, i) => `wait0${i}`),
    ])
    const last = texts(renderScreen(model, ui, SMALL, LOG, null))
    expect(last.some((line) => line.includes('wait02'))).toBe(true)
    expect(last.slice(10, 17).map((line) => line.trimEnd())).toEqual(first.slice(10, 17).map((line) => line.trimEnd()))
    expect(last[10]).toContain('┌ Projects 5 / rules 5')
    expect(last[17]).toContain('┌ Log')
  })

  it('I3: at 80×24 with no runs or pending items and 50 monitoring errors, notification rows are selected one at a time with down and scroll, reaching the last project49 whether or not the log is shown', () => {
    const projectErrors = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`project${i}`, { since: secondsBefore(60), message: 'HTTP 502' }]))
    const model = modelOf(stateWith({ projectErrors }), 0)
    for (const showLog of [true, false]) {
      let ui = { ...initialUi(model), showLog }
      expect(ui.selected).toEqual({ kind: 'notice', key: 'project-error:project0' })
      for (let i = 0; i < 49; i += 1) {
        ui = press(ui, ['down'], model, SMALL)
        const lines = renderScreen(model, ui, SMALL, LOG, null)
        expectFullScreen(lines, SMALL)
        expect(selectedLines(lines)).toHaveLength(1)
        expect(selectedLines(lines)[0]).toContain(`project${i + 1} `)
      }
      expect(ui.selected).toEqual({ kind: 'notice', key: 'project-error:project49' })
      expect(ui.scroll).toBe(showLog ? 45 : 39)
      const last = texts(renderScreen(model, ui, SMALL, LOG, null))
      expect(last.filter((line) => line.includes('project49'))).toEqual([`│ ! -       project49  watch error    HTTP 502 (since 1m ago)${' '.repeat(4)}→ orcapod logs│`])
      expect(press(ui, ['down'], model, SMALL)).toEqual(ui)
      const backToTop = press(ui, Array.from({ length: 49 }, () => 'up' as const), model, SMALL)
      expect([backToTop.selected, backToTop.scroll]).toEqual([{ kind: 'notice', key: 'project-error:project0' }, 0])
    }
  })

  it('I3: pressing Enter on an attention notification row does not open the detail and changes neither selection nor scroll', () => {
    const model = modelOf(stateWith({ orcaOutageSince: secondsBefore(120), runs: [runWith({})] }))
    const onNotice = press(initialUi(model), ['up'], model, SMALL)
    expect(onNotice.selected).toEqual({ kind: 'notice', key: 'orca-outage' })
    expect(reduceKey(onNotice, 'enter', model, SMALL)).toEqual({ kind: 'ui', ui: onNotice })
  })

  it('A13: when the run on the 2nd running row is selected and becomes done, the selection moves to a nearby row in the running tier and stays on screen', () => {
    const runs = numbered('actv', 3, (id, i) => runWith({ id, items: [item(200 + i)] }))
    const before = modelOf(stateWith({ runs }))
    const ui = press(initialUi(before), ['down'], before, SMALL)
    expect(ui.selected).toEqual({ kind: 'run', runId: '20261023-0000-actv01' })

    const after = modelOf(stateWith({ runs: [runs[0], { ...runs[1], phase: { kind: 'done', at: secondsBefore(5), summary: 'finished', tabClosed: true } }, runs[2]] }))
    const lines = renderScreen(after, ui, SMALL, LOG, null)
    expect(selectedLines(lines)).toHaveLength(1)
    expect(selectedLines(lines)[0]).toContain('actv02')
    const reloaded = reduceKey(ui, 'r', after, SMALL)
    expect(reloaded).toEqual({ kind: 'reload', ui: { ...ui, selected: { kind: 'run', runId: '20261023-0000-actv02' }, anchor: { section: 'active', index: 1 } } })
  })

  it('when the selected tier becomes empty, the selection moves to the first row', () => {
    const before = modelOf(stateWith({ runs: [runWith({ id: '20261023-0000-actv00' }), runWith({ id: '20261023-0000-wait00', startedAt: null, phase: { kind: 'queued', since: secondsBefore(60) } })] }))
    const ui = press(initialUi(before), ['down'], before, SMALL)
    expect(ui.selected).toEqual({ kind: 'run', runId: '20261023-0000-wait00' })
    const after = modelOf(stateWith({ runs: [runWith({ id: '20261023-0000-actv00' })] }))
    expect(selectedLines(renderScreen(after, ui, SMALL, LOG, null))[0]).toContain('actv00')
  })

  it('the log shows only the last lines that fit the displayed line count, and hiding it with l widens the tier boxes', () => {
    const model = modelOf(stateWith({}))
    const log = Array.from({ length: 10 }, (_, i) => `2026-10-23 09:00:0${i} info line ${i}`)
    const shown = texts(renderScreen(model, initialUi(model), SMALL, log, null))
    expect(shown.slice(17, 23)).toEqual([
      `┌ Log ${'─'.repeat(73)}┐`,
      `│09:00:06 info line 6${' '.repeat(58)}│`,
      `│09:00:07 info line 7${' '.repeat(58)}│`,
      `│09:00:08 info line 8${' '.repeat(58)}│`,
      `│09:00:09 info line 9${' '.repeat(58)}│`,
      `└${'─'.repeat(78)}┘`,
    ])
    const hidden = press(initialUi(model), ['l'], model, SMALL)
    expect(hidden.showLog).toBe(false)
    const withoutLog = texts(renderScreen(model, hidden, SMALL, log, null))
    expect(withoutLog.filter((line) => line.includes('Log ') || line.includes('line'))).toEqual([])
    expect(withoutLog[18]).toContain('┌ Projects')
    expect(withoutLog[22]).toBe(`└${'─'.repeat(78)}┘`)
    expect(withoutLog[23]).toContain('↑↓ select')
  })
})

describe('renderScreen: views other than standard', () => {
  it('when state.json is missing, the standard screen has only the heading, the "daemon has never run" row, the log and key guidance', () => {
    const model = buildMonitorModel({ home: HOME, state: null, stateError: null, stateMtime: null, daemonPid: null, lockError: null, config: { kind: 'unknown', disk: null, diskError: null }, now: NOW })
    const lines = renderScreen(model, initialUi(model), SMALL, [], null)
    expectFullScreen(lines, SMALL)
    expect(texts(lines).map((line) => line.trimEnd()).filter((line) => line !== '')).toEqual([
      ` orcapod monitor  daemon: never started!  config status unknown  home /Users/me…`,
      ' daemon has never run (start it with orcapod start)',
      `┌ Log ${'─'.repeat(73)}┐`,
      ...Array.from({ length: 4 }, () => `│${' '.repeat(78)}│`),
      `└${'─'.repeat(78)}┘`,
      ' c config  l toggle log  r reload  ? help  q quit',
    ])
  })

  it('the detail (run) shows the detected item, phase history, Orca references, notifications, and the full text of result.json and last-message.md', () => {
    const model = modelOf(stateWith({ runs: [runWith({})] }))
    const view = viewsOf(model).find(({ name }) => name === 'detail (run)')
    if (view === undefined) throw new Error('no detail (run) view')
    const lines = texts(renderScreen(model, view.ui, LARGE, LOG, view.detail)).map((line) => line.trimEnd())
    expect(lines.slice(1, 21)).toEqual([
      ' Detail run 20261023-0917-3f9a1c',
      'todos  #123 Feature  running/working',
      'rule issue/impl → feature claude batch each delay 5m bootstrap skip',
      'created 10-23 09:30  started 10-23 09:36',
      'path /Users/me/git/todos  repo taylor/todos  githubAccount taylor',
      'detected items:',
      '  #123 Title 123  taylor (OWNER)  labels impl  https://github.com/taylor/todos/issues/123',
      'phase history:',
      '  10-23 09:30 queued',
      '  10-23 09:36 running',
      'Orca: tabId tab-1  paneKey pane-1  ptyId pty-1  handle term-1',
      'notified: waiting',
      'result.json:',
      '  {',
      '    "status": "failed",',
      '    "summary": "type error"',
      '  }',
      '',
      'last-message.md:',
      '  please decide the approach',
    ])
  })

  it('I5: the history, configuration, help and detail views start their second row with distinct one-word titles that differ from the standard screen border', () => {
    const model = modelOf(shapedState({ attention: 1, active: 1, waiting: 1, recent: 1 }))
    const firstWords = viewsOf(model).map(({ ui, detail }) => renderScreen(model, ui, SMALL, LOG, detail)[1].text.trim().split(' ')[0])
    expect(firstWords).toEqual(['┌', 'History', 'Settings', 'Keys', 'Detail', 'Detail', 'Detail'])
    const titles = new Set(firstWords.slice(1))
    expect(titles.size).toBe(4)
    expect(titles.has('┌')).toBe(false)
  })

  it('I5: at 80 columns the second row of every detail view, including a vanished target, starts with Detail and is not truncated', () => {
    const model = modelOf(shapedState({ attention: 1, active: 1, waiting: 1, recent: 1 }))
    const details = [
      ...viewsOf(model).filter(({ ui }) => ui.view.kind === 'detail'),
      { ui: { ...initialUi(model), view: { kind: 'detail', ref: { kind: 'run', runId: 'gone' } } } satisfies UiState, detail: null },
    ]
    const second = details.map(({ ui, detail }) => renderScreen(model, ui, SMALL, LOG, detail)[1].text)
    expect(second.map((line) => line.trimEnd())).toEqual([' Detail run 20261023-0917-3f9a1c', ' Detail pending todos', ' Detail project todos', ' Detail'])
    expect(second.filter((line) => line.includes('…'))).toEqual([])
  })

  it('the first help row pairs keys with directions: ↑ k (up) · ↓ j (down)', () => {
    const model = modelOf(stateWith({}))
    const lines = texts(renderScreen(model, { ...initialUi(model), view: { kind: 'help' } }, SMALL, LOG, null)).map((line) => line.trimEnd())
    expect(lines.slice(1, 4)).toEqual([' Keys', '↑ k  ↓ j   move the selection one row (across sections)', 'Tab        first row of the next section'])
  })

  it('when result.json or last-message.md cannot be read in the detail (run), a "cannot read <file name>: <message>" row is shown, and a missing file is shown as "<file name>: missing"', () => {
    const model = modelOf(stateWith({ runs: [runWith({})] }))
    const run = runWith({})
    const detail: DetailContent = { kind: 'run', run, resultJson: { kind: 'unreadable', message: 'EISDIR: illegal operation on a directory, read' }, lastMessage: { kind: 'missing' } }
    const lines = texts(renderScreen(model, { ...initialUi(model), view: { kind: 'detail', ref: { kind: 'run', runId: run.id } } }, LARGE, LOG, detail)).map((line) => line.trimEnd())
    expect(lines.filter((line) => /^(cannot read )?(result\.json|last-message\.md)/.test(line))).toEqual(['cannot read result.json: EISDIR: illegal operation on a directory, read', 'last-message.md: missing'])
  })

  it('when the detail has no content (the target disappeared from state), that fact is shown', () => {
    const model = modelOf(stateWith({}))
    const lines = texts(renderScreen(model, { ...initialUi(model), view: { kind: 'detail', ref: { kind: 'run', runId: 'gone' } } }, SMALL, LOG, null))
    expect(lines.slice(1, 3).map((line) => line.trimEnd())).toEqual([' Detail', 'target not found (removed from state)'])
  })
})

describe('G2: detail scroll bounds', () => {
  const detail: DetailContent = {
    kind: 'project', name: 'todos', project: null,
    error: { since: NOW, message: Array.from({ length: 40 }, (_, i) => `evidence${i + 1}`).join('\n') },
  }

  function setup() {
    const model = modelOf(stateWith({}))
    const ui: UiState = { ...initialUi(model), view: { kind: 'detail', ref: { kind: 'project', name: 'todos' } } }
    const body = (current: UiState, content: DetailContent) => texts(renderScreen(model, current, SMALL, [], content)).slice(2, -1).map((line) => line.trimEnd())
    return { model, ui, body }
  }

  it('a 42-line body stops at the bottom edge of 80×24 and does not exceed the valid range with extra down presses', () => {
    const { model, ui, body } = setup()
    const bottom = press(ui, Array<Key>(21).fill('down'), model, SMALL, detail)
    expect(bottom.scroll).toBe(21)
    expect(body(bottom, detail)).toEqual(Array.from({ length: 21 }, (_, i) => `  evidence${i + 20}`))
    const repeated = press(bottom, Array<Key>(100).fill('down'), model, SMALL, detail)
    expect(repeated.scroll).toBe(21)
    expect(body(repeated, detail)).toEqual(body(bottom, detail))
  })

  it('even after repeated down at the bottom edge, a single up immediately moves the display top back by one line', () => {
    const { model, ui, body } = setup()
    const bottom = press(ui, Array<Key>(121).fill('down'), model, SMALL, detail)
    expect(body(bottom, detail)[0]).toBe('  evidence20')
    const up = press(bottom, ['up'], model, SMALL, detail)
    expect(body(up, detail)[0]).toBe('  evidence19')
  })

  it('with a short body, down/up keeps the position at 0', () => {
    const { model, ui, body } = setup()
    const short: DetailContent = { ...detail, error: null }
    const first = body(ui, short)
    expect(first).toEqual(['not in config', 'watch error none', ...Array<string>(19).fill('')])
    const down = press(ui, ['down'], model, SMALL, short)
    expect(body(down, short)).toEqual(first)
    expect(down.scroll).toBe(0)
    expect(press(down, ['up', 'up'], model, SMALL, short).scroll).toBe(0)
  })

  it('even when a scrolled body is shortened, the display position fits within the start of the shorter body', () => {
    const { model, ui, body } = setup()
    const scrolled = press(ui, Array<Key>(21).fill('down'), model, SMALL, detail)
    expect(body(scrolled, detail)[0]).toBe('  evidence20')
    const short: DetailContent = { ...detail, error: null }
    expect(body(scrolled, short)).toEqual(body(ui, short))
    const clamped = clampDetailScroll(scrolled, SMALL, short)
    expect(clamped.scroll).toBe(0)
    expect(body(clamped, detail)).toEqual(body(ui, detail))
  })

  it('after the body is shortened or the terminal enlarged, up moves back one line from the corrected display position, and returns to 0 when the target disappears', () => {
    const { model, ui } = setup()
    const bottom = press(ui, Array<Key>(21).fill('down'), model, SMALL, detail)
    const shorter: DetailContent = { ...detail, error: { since: NOW, message: Array.from({ length: 30 }, (_, i) => `evidence${i + 1}`).join('\n') } }
    expect(press(bottom, ['up'], model, SMALL, shorter).scroll).toBe(10)
    expect(clampDetailScroll(bottom, LARGE, detail).scroll).toBe(5)
    expect(press(bottom, ['up'], model, LARGE, detail).scroll).toBe(4)
    expect(clampDetailScroll(bottom, SMALL, null).scroll).toBe(0)
  })
})

describe('initialUi and reduceKey', () => {
  it('the initial state shows the standard screen with the log and selects the first selectable row of the standard screen (a row containing only attention notifications is not selected)', () => {
    const model = modelOf(stateWith({ projectErrors: { todos: { since: secondsBefore(60), message: 'HTTP 502' } }, runs: [runWith({})] }))
    expect(initialUi(model)).toEqual({ view: { kind: 'main' }, selected: { kind: 'run', runId: '20261023-0917-3f9a1c' }, anchor: { section: 'active', index: 0 }, showLog: true, scroll: 0 })
    const empty = buildMonitorModel({ home: HOME, state: null, stateError: null, stateMtime: null, daemonPid: null, lockError: null, config: { kind: 'unknown', disk: null, diskError: null }, now: NOW })
    expect(initialUi(empty)).toEqual({ view: { kind: 'main' }, selected: null, anchor: null, showLog: true, scroll: 0 })
  })

  it('up/down move one row at a time across tiers and stop at the ends; Tab moves to the first row of the next tier and wraps to the start after the last tier', () => {
    const model = modelOf(shapedState({ attention: 1, active: 2, waiting: 1, recent: 0 }), 1)
    const ui = initialUi(model)
    const selectedId = (state: UiState): string => (state.selected?.kind === 'run' ? state.selected.runId.slice(-6) : `${state.selected?.kind}`)
    expect(selectedId(ui)).toBe('fail00')
    expect(selectedId(press(ui, ['up'], model, SMALL))).toBe('fail00')
    expect(selectedId(press(ui, ['down', 'down'], model, SMALL))).toBe('actv01')
    expect(press(ui, ['down', 'down', 'down', 'down', 'down', 'down'], model, SMALL).selected).toEqual({ kind: 'project', name: 'todos', ruleKey: ruleKey('todos', featureRule) })
    expect(selectedId(press(ui, ['tab'], model, SMALL))).toBe('actv00')
    expect(selectedId(press(ui, ['tab', 'tab'], model, SMALL))).toBe('wait00')
    expect(press(ui, ['tab', 'tab', 'tab'], model, SMALL).selected).toEqual({ kind: 'project', name: 'todos', ruleKey: ruleKey('todos', featureRule) })
    expect(selectedId(press(ui, ['tab', 'tab', 'tab', 'tab'], model, SMALL))).toBe('fail00')
  })

  it('Enter opens the detail of the selected row and Esc returns to the standard screen; h / c / ? switch views and l toggles log display', () => {
    const model = modelOf(stateWith({ runs: [runWith({})] }))
    const ui = initialUi(model)
    expect(press(ui, ['enter'], model, SMALL).view).toEqual({ kind: 'detail', ref: { kind: 'run', runId: '20261023-0917-3f9a1c' } })
    expect(press(ui, ['enter', 'escape'], model, SMALL)).toEqual(ui)
    expect(press(ui, ['h'], model, SMALL).view).toEqual({ kind: 'history' })
    expect(press(ui, ['c'], model, SMALL).view).toEqual({ kind: 'config' })
    expect(press(ui, ['?'], model, SMALL).view).toEqual({ kind: 'help' })
    expect(press(ui, ['h', 'c'], model, SMALL).view).toEqual({ kind: 'config' })
    expect(press(ui, ['l'], model, SMALL).showLog).toBe(false)
    expect(press(ui, ['l', 'l'], model, SMALL).showLog).toBe(true)
    expect(press(ui, ['h', 'tab', 'enter'], model, SMALL)).toEqual({ ...ui, view: { kind: 'history' } })
  })

  it('q and Ctrl-C return quit, and r returns reload', () => {
    const model = modelOf(stateWith({}))
    const ui = initialUi(model)
    expect(reduceKey(ui, 'q', model, SMALL)).toEqual({ kind: 'quit' })
    expect(reduceKey({ ...ui, view: { kind: 'help' } }, 'ctrl-c', model, SMALL)).toEqual({ kind: 'quit' })
    expect(reduceKey(ui, 'r', model, SMALL)).toEqual({ kind: 'reload', ui })
  })

  it('up/down in the history view scroll and stay between 0 and the last screen', () => {
    const model = modelOf(shapedState({ attention: 0, active: 0, waiting: 0, recent: 30 }))
    const history = press(initialUi(model), ['h'], model, SMALL)
    expect(press(history, ['up'], model, SMALL).scroll).toBe(0)
    expect(press(history, ['down', 'down'], model, SMALL).scroll).toBe(2)
    expect(press(history, Array.from({ length: 15 }, () => 'down' as const), model, SMALL).scroll).toBe(9)
    const lines = texts(renderScreen(model, press(history, ['down', 'down'], model, SMALL), SMALL, LOG, null))
    expect(lines[2]).toContain('done02')
    expect(lines[22]).toContain('done22')
  })

  it('when state.json is missing, only c, ?, l, r, q and Ctrl-C work, and Esc returns from configuration and help', () => {
    const model = buildMonitorModel({ home: HOME, state: null, stateError: null, stateMtime: null, daemonPid: null, lockError: null, config: { kind: 'unknown', disk: null, diskError: null }, now: NOW })
    const ui = initialUi(model)
    for (const key of ['h', 'up', 'down', 'tab', 'enter', 'escape'] as const) expect(reduceKey(ui, key, model, SMALL)).toEqual({ kind: 'ui', ui })
    expect(press(ui, ['c'], model, SMALL).view).toEqual({ kind: 'config' })
    expect(press(ui, ['c', 'escape'], model, SMALL)).toEqual(ui)
    expect(press(ui, ['?', 'h'], model, SMALL).view).toEqual({ kind: 'help' })
    expect(press(ui, ['l'], model, SMALL).showLog).toBe(false)
    expect(reduceKey(ui, 'r', model, SMALL)).toEqual({ kind: 'reload', ui })
    expect(reduceKey(ui, 'ctrl-c', model, SMALL)).toEqual({ kind: 'quit' })
  })
})

describe('SPEC-ENGLISH-OUTPUT-001 conditions: every row of every view is the terminal width', () => {
  const SHAPES = [
    { name: 'no attention, no runs', counts: { attention: 0, active: 0, waiting: 0, recent: 0 } },
    { name: 'no attention, 17 runs', counts: { attention: 0, active: 6, waiting: 5, recent: 6 } },
    { name: '2 attention, 17 runs', counts: { attention: 2, active: 5, waiting: 4, recent: 6 } },
  ]
  const SIZES = [SMALL, LARGE]

  function expectEveryViewFullScreen(model: MonitorModel): void {
    for (const { ui, detail } of viewsOf(model)) {
      for (const size of SIZES) {
        for (const log of [LOG, []]) expectFullScreen(renderScreen(model, ui, size, log, detail), size)
        expectFullScreen(renderScreen(model, { ...ui, showLog: false }, size, LOG, detail), size)
      }
    }
  }

  it.each(SHAPES)('A4-1: $name: all views at 80x24 and 126x40, with and without the log, are exactly the terminal width and height', ({ counts }) => {
    expectEveryViewFullScreen(modelOf(shapedState(counts), 4))
  })

  it('A4-2: a 30-character English kind name, a 20-character project name and a last message with full-width, emoji, combining characters and ESC keep every row at the terminal width', () => {
    const kindName = 'Dependency Update Automation!!'
    const projectName = 'verylongprojectname1'
    expect([kindName.length, projectName.length]).toEqual([30, 20])
    const config = configWith(2)
    config.projects[1] = project(projectName)
    config.kinds[0] = { id: 'feature', name: kindName }
    const message = '\uff21\uff22\uff23 \u6f22\u5b57\u304b\u306a \uff76\uff85 😀 é 👨‍👩‍👧 \u001b[31mred\u001b[0m'
    const target = { path: `/Users/me/git/${projectName}`, repo: `taylor/${projectName}`, githubAccount: 'taylor' }
    const state = stateWith({
      runs: [
        runWith({ id: '20261023-0001-aaaaaa', kindName, project: projectName, target, lastMessage: message }),
        runWith({ id: '20261023-0002-bbbbbb', kindName, lastMessage: message, phase: { kind: 'failed', at: secondsBefore(60), reason: message, tabClosed: false } }),
        runWith({ id: '20261023-0003-cccccc', kindName, project: projectName, target, startedAt: null, phase: { kind: 'queued', since: secondsBefore(60) } }),
        runWith({ id: '20261023-0004-dddddd', kindName, phase: { kind: 'done', at: secondsBefore(900), summary: message, tabClosed: true } }),
      ],
    })
    const model = buildMonitorModel({ home: HOME, state, stateError: null, stateMtime: secondsBefore(3), daemonPid: 4242, lockError: null, config: { kind: 'running', config, loadedAt: secondsBefore(3600) }, now: NOW })
    const projectDetail: UiState = { ...initialUi(model), view: { kind: 'detail', ref: { kind: 'project', name: projectName } } }
    const runDetail: UiState = { ...initialUi(model), view: { kind: 'detail', ref: { kind: 'run', runId: '20261023-0001-aaaaaa' } } }
    const views = [...viewsOf(model), { name: 'long project', ui: projectDetail, detail: { kind: 'project', name: projectName, project: project(projectName), error: null } satisfies DetailContent }, { name: 'long run', ui: runDetail, detail: null }]
    for (const { ui, detail } of views) {
      for (const size of SIZES) expectFullScreen(renderScreen(model, ui, size, LOG, detail), size)
    }
  })

  it.each<[string, Partial<State>]>([
    ['a 200-character English configStatus.error', { configStatus: { loadedAt: secondsBefore(3600), sha256: 'a'.repeat(64), error: 'config error '.repeat(16).slice(0, 200) } }],
    ['50 project errors', { projectErrors: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`project${i}`, { since: secondsBefore(60), message: 'HTTP 502 Bad Gateway' }])) }],
    ['daemonInfo null', { daemonInfo: null }],
    ['all three at once', { configStatus: { loadedAt: secondsBefore(3600), sha256: 'a'.repeat(64), error: 'config error '.repeat(16).slice(0, 200) }, projectErrors: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`project${i}`, { since: secondsBefore(60), message: 'HTTP 502 Bad Gateway' }])), daemonInfo: null }],
  ])('A4-3: %s keeps every row of every view at the terminal width', (_name, overrides) => {
    const model = modelOf(stateWith({ ...shapedState({ attention: 2, active: 3, waiting: 2, recent: 5 }), ...overrides }), 3)
    expectEveryViewFullScreen(model)
  })

  it.each([[{ width: 79, height: 24 }], [{ width: 80, height: 23 }]])('A4-4: %o prints exactly one guidance line in English whose width is the terminal width', (size) => {
    const model = modelOf(shapedState({ attention: 1, active: 1, waiting: 1, recent: 1 }))
    const lines = renderScreen(model, initialUi(model), size, LOG, null)
    expect(lines).toHaveLength(1)
    expect(displayWidth(lines[0].text)).toBe(size.width)
    expect(lines[0].text.trimEnd()).toBe(`Needs 80×24 or larger (now ${size.width}×${size.height})`)
  })

  it('A5-2: the first words of the four page titles are 4 distinct words and none is the box-drawing corner of the standard screen', () => {
    const model = modelOf(shapedState({ attention: 1, active: 1, waiting: 1, recent: 1 }))
    const byName = new Map(viewsOf(model).map(({ name, ui, detail }) => [name, renderScreen(model, ui, SMALL, LOG, detail)[1].text.trim().split(' ')[0]]))
    const titles = ['history', 'config', 'help', 'detail (run)'].map((name) => byName.get(name))
    expect(new Set(titles).size).toBe(4)
    expect(titles).not.toContain('┌')
    expect(byName.get('main')).toBe('┌')
  })

  it('A5-3: at 80 columns the second row of the detail view starts with Detail and is not clipped with an ellipsis', () => {
    const model = modelOf(shapedState({ attention: 1, active: 1, waiting: 1, recent: 1 }))
    for (const { name, ui, detail } of viewsOf(model).filter(({ name }) => name.startsWith('detail'))) {
      const second = renderScreen(model, ui, SMALL, LOG, detail)[1].text
      expect([name, second.trim().startsWith('Detail')]).toEqual([name, true])
      expect([name, second.includes('…')]).toEqual([name, false])
    }
  })
})
