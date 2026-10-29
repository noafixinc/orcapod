import { runTitle } from './launch.ts'
import { ruleText } from './monitor-model.ts'
import type { ColumnId, DetailContent, DetailRef, MonitorModel, Row, RowRef, RunFile, Section, SectionId } from './monitor-model.ts'
import { clock, phaseText } from './status.ts'
import { cellText, clip, displayWidth, fitWidth, printable } from './terminal-text.ts'
import type { Item } from './types.ts'

export { displayWidth, fitWidth, printableLines } from './terminal-text.ts'

const MIN_WIDTH = 80
const MIN_HEIGHT = 24
const WIDE_WIDTH = 120
const MIN_LOG_AREA_HEIGHT = 4
const LOG_AREA_SHARE = 4
const MARK_WIDTH = 1
const ID_WIDTH = 6
const PROJECT_WIDTH = 10
const WIDE_TITLE_WIDTH = 20
const NARROW_TITLE_WIDTH = 14
const MIN_BODY_WIDTH = 30
const LOG_DATE_PREFIX = /^\d{4}-\d{2}-\d{2} /
const LOG_CONTINUATION_INDENT = ' '.repeat(9)
const FLOWING_COLUMNS: readonly ColumnId[] = ['phase', 'elapsed', 'note', 'lastMessage', 'rules']
const WIDE_ONLY_COLUMNS: readonly ColumnId[] = ['lastMessage', 'rules']
const TRIM_LAST_FIRST_ORDER: readonly SectionId[] = ['recent']

const MAIN_FOOTER = ' ↑↓ select  Tab next section  Enter detail  h history  c config  l toggle log  r reload  ? help  q quit │ actions: orcapod stop <id> / rerun <id>'
const NEVER_STARTED_FOOTER = ' c config  l toggle log  r reload  ? help  q quit'
const VIEW_FOOTER = ' ↑↓ scroll  Esc back  h history  c config  ? help  q quit'
const NEVER_STARTED_MESSAGE = ' daemon has never run (start it with orcapod start)'
const HELP_LINES: readonly string[] = [
  '↑ k  ↓ j   move the selection one row (across sections)',
  'Tab        first row of the next section',
  'Enter      detail of the selected row (run / pending / project)',
  'Esc        back to the main screen',
  'h          history (all finished runs)',
  'c          settings',
  'l          toggle the log area',
  'r          reload now',
  '?          this key list',
  'q Ctrl-C   quit',
  '',
  'No stop, rerun or manual launch here. Use orcapod stop <id> / orcapod rerun <id> / orcapod run in another terminal',
]

export interface ScreenSize { width: number; height: number }
export type View = { kind: 'main' } | { kind: 'history' } | { kind: 'config' } | { kind: 'help' } | { kind: 'detail'; ref: DetailRef }
export interface SelectionAnchor { section: SectionId; index: number }
export interface UiState { view: View; selected: RowRef | null; anchor: SelectionAnchor | null; showLog: boolean; scroll: number }
export interface ScreenLine { text: string; inverse: boolean; redRanges?: { start: number; end: number }[] }
export type Key = 'up' | 'down' | 'tab' | 'enter' | 'escape' | 'h' | 'c' | 'l' | 'r' | '?' | 'q' | 'ctrl-c'
export type KeyResult = { kind: 'ui'; ui: UiState } | { kind: 'reload'; ui: UiState } | { kind: 'quit' }

interface Selectable { ref: RowRef; section: SectionId; index: number; line: number }
interface LineSpan { target: number; first: number; last: number }
interface MainFrame { lines: string[]; projectLines: string[]; projectStart: number; selectables: Selectable[]; selection: Selectable | null; boxHeight: number; logHeight: number; scroll: number }

export function initialUi(model: MonitorModel): UiState {
  const rows = model.sections.flatMap((section) => section.rows.map((row, index) => ({ ref: row.ref, anchor: { section: section.id, index } })))
  const first = rows.find((row) => row.ref.kind !== 'notice') ?? rows[0]
  if (first === undefined) return { view: { kind: 'main' }, selected: null, anchor: null, showLog: true, scroll: 0 }
  return { view: { kind: 'main' }, selected: first.ref, anchor: first.anchor, showLog: true, scroll: 0 }
}

export function renderScreen(model: MonitorModel, ui: UiState, size: ScreenSize, log: readonly string[], detail: DetailContent | null): ScreenLine[] {
  if (size.width < MIN_WIDTH || size.height < MIN_HEIGHT) return [plain(fitWidth(`Needs 80×24 or larger (now ${size.width}×${size.height})`, Math.max(0, size.width)))]
  switch (ui.view.kind) {
    case 'main': return model.neverStarted ? renderNeverStarted(model, ui, size, log) : renderMain(model, ui, size, log)
    case 'history': return renderPaged(model, size, `History ${model.history.length} (newest first)`, historyBody(model, size), ui.scroll)
    case 'config': return renderPaged(model, size, 'Settings', model.configLines, ui.scroll)
    case 'help': return renderPaged(model, size, 'Keys', HELP_LINES, ui.scroll)
    case 'detail': {
      const { title, body } = detailOf(detail)
      return renderPaged(model, size, title, body, ui.scroll)
    }
  }
}

export function clampDetailScroll(ui: UiState, size: ScreenSize, detail: DetailContent | null): UiState {
  if (ui.view.kind !== 'detail') return ui
  return { ...ui, scroll: scrollFor(ui.scroll, detailOf(detail).body.length, pagedViewport(size), null) }
}

export function reduceKey(ui: UiState, key: Key, model: MonitorModel, size: ScreenSize, detail: DetailContent | null = null): KeyResult {
  ui = clampDetailScroll(ui, size, detail)
  switch (key) {
    case 'q':
    case 'ctrl-c':
      return { kind: 'quit' }
    case 'r':
      return { kind: 'reload', ui: settled(ui, model, size) }
    case 'l':
      return changed({ ...ui, showLog: !ui.showLog }, model, size)
    case 'c':
      return changed({ ...ui, view: { kind: 'config' }, scroll: 0 }, model, size)
    case '?':
      return changed({ ...ui, view: { kind: 'help' }, scroll: 0 }, model, size)
    case 'escape':
      return ui.view.kind === 'main' ? changed(ui, model, size) : changed({ ...ui, view: { kind: 'main' }, scroll: 0 }, model, size)
    case 'h':
      return model.neverStarted ? unchanged(ui) : changed({ ...ui, view: { kind: 'history' }, scroll: 0 }, model, size)
    case 'up':
    case 'down': {
      const step = key === 'up' ? -1 : 1
      if (ui.view.kind !== 'main') return unchanged({ ...ui, scroll: scrolledBy(ui, step, model, size, detail) })
      return model.neverStarted ? unchanged(ui) : unchanged(moveSelection(ui, model, size, step))
    }
    case 'tab':
      return ui.view.kind !== 'main' || model.neverStarted ? unchanged(ui) : unchanged(nextSection(ui, model, size))
    case 'enter': {
      if (ui.view.kind !== 'main' || model.neverStarted) return unchanged(ui)
      const { selection } = mainFrame(model, ui, size)
      if (selection === null) return unchanged(ui)
      const { ref } = selection
      if (ref.kind === 'notice') return unchanged(ui)
      return unchanged({ ...ui, view: { kind: 'detail', ref }, selected: ref, anchor: anchorOf(selection), scroll: 0 })
    }
  }
}

function plain(text: string): ScreenLine {
  return { text, inverse: false }
}

function headerLine(model: MonitorModel, width: number): ScreenLine {
  let content = ' '
  const redRanges: { start: number; end: number }[] = []
  for (const [index, part] of model.header.entries()) {
    if (index > 0) content += '  '
    const start = content.length
    content += printable(part.alert ? `${part.text}!` : part.text)
    if (part.alert) redRanges.push({ start, end: content.length })
  }
  const text = fitWidth(content, width)
  return { text, inverse: false, redRanges: redRanges.filter((range) => range.start < text.trimEnd().length).map((range) => ({ ...range, end: Math.min(range.end, text.trimEnd().length) })) }
}

function titledBorder(left: string, title: string, right: string, width: number): string {
  const label = clip(` ${title} `, width - 3)
  return `${left}${label}${'─'.repeat(width - 2 - displayWidth(label))}${right}`
}

function rowText(row: Row, width: number, wide: boolean): string {
  const textOf = (column: ColumnId): string | undefined => row.cells.find((cell) => cell.column === column)?.text
  if (row.ref.kind === 'project') return fitWidth(`   ${fitWidth(textOf('project') ?? '', PROJECT_WIDTH)} ${textOf('rules') ?? ''}  ${textOf('note') ?? ''}`, width)
  const fixed = (column: ColumnId, columnWidth: number): string[] => {
    const text = textOf(column)
    return text === undefined ? [] : [fitWidth(text, columnWidth)]
  }
  const flowing = FLOWING_COLUMNS
    .filter((column) => wide || !WIDE_ONLY_COLUMNS.includes(column))
    .flatMap((column) => textOf(column) ?? [])
    .filter((text) => text !== '')
  const body = ` ${[
    fitWidth(textOf('mark') ?? '', MARK_WIDTH),
    ...fixed('id', ID_WIDTH + 1),
    ...fixed('project', PROJECT_WIDTH),
    ...fixed('title', wide ? WIDE_TITLE_WIDTH : NARROW_TITLE_WIDTH),
    ...flowing,
  ].join(' ')}`
  if (row.hint === null) return fitWidth(body, width)
  const hintWidth = Math.min(displayWidth(cellText(row.hint)), Math.max(0, width - 1 - MIN_BODY_WIDTH))
  return `${fitWidth(body, width - 1 - hintWidth)} ${fitWidth(row.hint, hintWidth)}`
}

function logAreaHeight(size: ScreenSize): number {
  return Math.max(MIN_LOG_AREA_HEIGHT, Math.floor(size.height / LOG_AREA_SHARE))
}

function logArea(log: readonly string[], width: number, height: number): ScreenLine[] {
  if (height === 0) return []
  const capacity = height - 2
  const shown = log.slice(Math.max(0, log.length - capacity)).map(logLineText)
  return [
    plain(titledBorder('┌', 'Log', '┐', width)),
    ...padded(shown, capacity).map((line) => plain(`│${fitWidth(line, width - 2)}│`)),
    plain(`└${'─'.repeat(width - 2)}┘`),
  ]
}

function logLineText(line: string): string {
  return LOG_DATE_PREFIX.test(line) ? line.slice('YYYY-MM-DD '.length) : `${LOG_CONTINUATION_INDENT}${line}`
}

function padded(lines: readonly string[], count: number): string[] {
  return [...lines, ...Array.from({ length: Math.max(0, count - lines.length) }, () => '')]
}

function shownCounts(sections: readonly Section[], rowBudget: number): Map<SectionId, number> {
  const trimmable = (id: SectionId): boolean => TRIM_LAST_FIRST_ORDER.includes(id)
  const required = sections.filter((section) => !trimmable(section.id)).reduce((sum, section) => sum + section.rows.length, 0)
  let remaining = Math.max(0, rowBudget - required)
  const counts = new Map<SectionId, number>()
  for (const section of sections) {
    if (!trimmable(section.id)) counts.set(section.id, section.rows.length)
  }
  for (const id of TRIM_LAST_FIRST_ORDER) {
    const rows = sections.find((section) => section.id === id)?.rows.length ?? 0
    const shown = Math.min(rows, remaining)
    counts.set(id, shown)
    remaining -= shown
  }
  return counts
}

function mainFrame(model: MonitorModel, ui: UiState, size: ScreenSize): MainFrame {
  const sections = model.sections.filter((section) => section.id !== 'projects')
  const preferredLogHeight = ui.showLog ? logAreaHeight(size) : 0
  const available = size.height - 2 - preferredLogHeight
  const projects = model.sections.find((section) => section.id === 'projects')
  const projectRows = projects?.rows ?? []
  const projectHeight = projects === undefined ? 0 : Math.min(projectRows.length + 2, Math.floor(available / 2))
  const minimumBoxHeight = sections.length * 2 + 1
  const logHeight = ui.showLog ? Math.max(MIN_LOG_AREA_HEIGHT, Math.min(preferredLogHeight, size.height - 2 - projectHeight - minimumBoxHeight)) : 0
  const boxHeight = size.height - 2 - logHeight - projectHeight
  const counts = shownCounts(sections, boxHeight - sections.length * 2 - 1)
  const wide = size.width >= WIDE_WIDTH
  const lines: string[] = []
  const selectables: Selectable[] = []
  sections.forEach((section, i) => {
    const shown = section.rows.slice(0, counts.get(section.id) ?? section.rows.length)
    const hidden = section.rows.length - shown.length
    const title = hidden > 0 ? `${section.title}  ${hidden} more` : section.title
    lines.push(titledBorder(i === 0 ? '┌' : '├', title, i === 0 ? '┐' : '┤', size.width))
    shown.forEach((row, index) => {
      selectables.push({ ref: row.ref, section: section.id, index, line: lines.length })
      lines.push(`│${rowText(row, size.width - 2, wide)}│`)
    })
    lines.push(`│${' '.repeat(size.width - 2)}│`)
  })
  projectRows.forEach((row, index) => selectables.push({ ref: row.ref, section: 'projects', index, line: lines.length + 1 + index }))
  const selection = resolveSelection(ui, selectables)
  const capacity = Math.max(0, projectHeight - 2)
  const projectStart = selection?.section === 'projects' ? Math.max(0, selection.index - capacity + 1) : 0
  const hidden = projectRows.length - Math.min(projectRows.length, capacity)
  const projectLines = projects === undefined ? [] : [
    titledBorder('┌', `${projects.title}${hidden > 0 ? `  ${hidden} more` : ''}`, '┐', size.width),
    ...projectRows.slice(projectStart, projectStart + capacity).map((row) => `│${rowText(row, size.width - 2, wide)}│`),
    `└${'─'.repeat(size.width - 2)}┘`,
  ]
  const span = selection === null || selection.section === 'projects' ? null : spanAround(selectables.filter((row) => row.section !== 'projects'), selection, lines.length)
  return { lines, projectLines, projectStart, selectables, selection, boxHeight, logHeight, scroll: scrollFor(ui.scroll, lines.length, boxHeight - 1, span) }
}

function resolveSelection(ui: UiState, selectables: readonly Selectable[]): Selectable | null {
  const { selected, anchor } = ui
  if (selected !== null) {
    const matching = selectables.filter((candidate) => sameRef(candidate.ref, selected))
    const kept = anchor === null ? matching[0] : matching.find((candidate) => candidate.section === anchor.section)
    if (kept !== undefined) return kept
    if (anchor !== null) {
      const sameSection = selectables.filter((candidate) => candidate.section === anchor.section)
      if (sameSection.length > 0) return sameSection[Math.min(anchor.index, sameSection.length - 1)]
    }
  }
  return selectables[0] ?? null
}

function sameRef(a: RowRef, b: RowRef): boolean {
  return refKey(a) === refKey(b)
}

function refKey(ref: RowRef): string {
  switch (ref.kind) {
    case 'run': return `run:${ref.runId}`
    case 'pending': return `pending:${ref.ruleKey}`
    case 'project': return `project:${ref.name}:${ref.ruleKey ?? ''}`
    case 'notice': return `notice:${ref.key}`
  }
}

function scrollFor(requested: number, total: number, viewport: number, span: LineSpan | null): number {
  const maxScroll = Math.max(0, total - viewport)
  const scroll = Math.min(Math.max(0, requested), maxScroll)
  if (span === null) return scroll
  const { first, last } = span.last - span.first + 1 <= viewport ? span : { first: span.target, last: span.target }
  if (first < scroll) return first
  if (last >= scroll + viewport) return Math.min(maxScroll, last - viewport + 1)
  return scroll
}

function spanAround(selectables: readonly Selectable[], target: Selectable, totalLines: number): LineSpan {
  const position = selectables.indexOf(target)
  const previous = selectables[position - 1]
  const next = selectables[position + 1]
  return { target: target.line, first: previous === undefined ? 0 : previous.line + 1, last: next === undefined ? totalLines - 1 : next.line - 1 }
}

function anchorOf(selection: Selectable): SelectionAnchor {
  return { section: selection.section, index: selection.index }
}

function renderMain(model: MonitorModel, ui: UiState, size: ScreenSize, log: readonly string[]): ScreenLine[] {
  const frame = mainFrame(model, ui, size)
  const bodyHeight = frame.boxHeight - 1
  const box = frame.lines.slice(frame.scroll, frame.scroll + bodyHeight)
    .map((text, i) => ({ text, inverse: frame.selection?.section !== 'projects' && frame.selection?.line === frame.scroll + i }))
  box.push(plain(`└${'─'.repeat(size.width - 2)}┘`))
  box.push(...Array.from({ length: frame.boxHeight - box.length }, () => plain(' '.repeat(size.width))))
  const projects = frame.projectLines.map((text, i) => ({ text, inverse: frame.selection?.section === 'projects' && i === frame.selection.index - frame.projectStart + 1 }))
  return [headerLine(model, size.width), ...box, ...projects, ...logArea(log, size.width, frame.logHeight), plain(fitWidth(MAIN_FOOTER, size.width))]
}

function renderNeverStarted(model: MonitorModel, ui: UiState, size: ScreenSize, log: readonly string[]): ScreenLine[] {
  const logHeight = ui.showLog ? logAreaHeight(size) : 0
  const body = padded([NEVER_STARTED_MESSAGE], size.height - 2 - logHeight).map((line) => plain(fitWidth(line, size.width)))
  return [headerLine(model, size.width), ...body, ...logArea(log, size.width, logHeight), plain(fitWidth(NEVER_STARTED_FOOTER, size.width))]
}

function pagedViewport(size: ScreenSize): number {
  return size.height - 3
}

function renderPaged(model: MonitorModel, size: ScreenSize, title: string, body: readonly string[], scroll: number): ScreenLine[] {
  const viewport = pagedViewport(size)
  const top = scrollFor(scroll, body.length, viewport, null)
  return [
    headerLine(model, size.width),
    plain(fitWidth(` ${title}`, size.width)),
    ...padded(body.slice(top, top + viewport), viewport).map((line) => plain(fitWidth(line, size.width))),
    plain(fitWidth(VIEW_FOOTER, size.width)),
  ]
}

function historyBody(model: MonitorModel, size: ScreenSize): string[] {
  return model.history.map((row) => rowText(row, size.width, size.width >= WIDE_WIDTH))
}

function pagedLength(ui: UiState, model: MonitorModel, detail: DetailContent | null): number {
  switch (ui.view.kind) {
    case 'history': return model.history.length
    case 'config': return model.configLines.length
    case 'help': return HELP_LINES.length
    case 'detail': return detailOf(detail).body.length
    case 'main': return 0
  }
}

function scrolledBy(ui: UiState, step: number, model: MonitorModel, size: ScreenSize, detail: DetailContent | null): number {
  const maxScroll = Math.max(0, pagedLength(ui, model, detail) - pagedViewport(size))
  return Math.min(Math.max(0, ui.scroll + step), maxScroll)
}

function unchanged(ui: UiState): KeyResult {
  return { kind: 'ui', ui }
}

function changed(ui: UiState, model: MonitorModel, size: ScreenSize): KeyResult {
  return { kind: 'ui', ui: settled(ui, model, size) }
}

function settled(ui: UiState, model: MonitorModel, size: ScreenSize): UiState {
  if (ui.view.kind !== 'main' || model.neverStarted) return ui
  const frame = mainFrame(model, ui, size)
  if (frame.selection === null) return { ...ui, selected: null, anchor: null, scroll: frame.scroll }
  return { ...ui, selected: frame.selection.ref, anchor: anchorOf(frame.selection), scroll: frame.scroll }
}

function moveSelection(ui: UiState, model: MonitorModel, size: ScreenSize, step: number): UiState {
  const frame = mainFrame(model, ui, size)
  if (frame.selection === null) return settled(ui, model, size)
  const position = frame.selectables.indexOf(frame.selection)
  const next = frame.selectables[Math.min(Math.max(0, position + step), frame.selectables.length - 1)]
  return selectIn(ui, frame, next)
}

function nextSection(ui: UiState, model: MonitorModel, size: ScreenSize): UiState {
  const frame = mainFrame(model, ui, size)
  if (frame.selection === null) return settled(ui, model, size)
  const order = model.sections.map((section) => section.id)
  const current = order.indexOf(frame.selection.section)
  const next = frame.selectables.find((candidate) => order.indexOf(candidate.section) > current) ?? frame.selectables[0]
  return selectIn(ui, frame, next)
}

function selectIn(ui: UiState, frame: MainFrame, target: Selectable): UiState {
  const span = target.section === 'projects' ? null : spanAround(frame.selectables.filter((row) => row.section !== 'projects'), target, frame.lines.length)
  return { ...ui, selected: target.ref, anchor: anchorOf(target), scroll: scrollFor(frame.scroll, frame.lines.length, frame.boxHeight - 1, span) }
}

function detailOf(detail: DetailContent | null): { title: string; body: string[] } {
  if (detail === null) return { title: 'Detail', body: ['target not found (removed from state)'] }
  switch (detail.kind) {
    case 'run': {
      const { run } = detail
      return {
        title: `Detail run ${run.id}`,
        body: [
          `${run.project}  ${runTitle(run)}  ${phaseText(run.phase)}`,
          `rule ${ruleText(run.rule)}`,
          `created ${clock(run.createdAt)}  started ${run.startedAt === null ? '-' : clock(run.startedAt)}${run.manual ? '  manual' : ''}${run.bypassLimit ? '  --now' : ''}`,
          `path ${run.target.path}  repo ${run.target.repo}  githubAccount ${run.target.githubAccount}`,
          'detected items:',
          ...run.items.map(itemLine),
          'phase history:',
          ...run.history.map((entry) => `  ${clock(entry.at)} ${entry.kind}`),
          `Orca: ${run.orca === null ? 'none' : `tabId ${run.orca.tabId}  paneKey ${run.orca.paneKey}  ptyId ${run.orca.ptyId}  handle ${run.orca.handle}`}`,
          `notified: ${run.notified.length === 0 ? 'none' : run.notified.join(', ')}`,
          ...fileLines('result.json', detail.resultJson),
          ...fileLines('last-message.md', detail.lastMessage),
        ],
      }
    }
    case 'pending': {
      const { pending, rule } = detail
      return {
        title: `Detail pending ${pending.project}`,
        body: [
          `rule key ${pending.ruleKey}`,
          rule === null ? 'rule not in config (dropped when due)' : `rule ${ruleText(rule)}`,
          `launches at ${clock(pending.fireAt)}`,
          `${pending.items.length} ${pending.items.length === 1 ? 'item' : 'items'}:`,
          ...pending.items.map(itemLine),
        ],
      }
    }
    case 'project': {
      const { project, error } = detail
      return {
        title: `Detail project ${detail.name}`,
        body: [
          ...(project === null
            ? ['not in config']
            : [
                `${project.enabled ? 'enabled' : 'disabled'}  repo ${project.repo}  path ${project.path}`,
                `githubAccount ${project.githubAccount}`,
                `authors ${project.authors.join(', ')}`,
                `bots ${project.bots.length === 0 ? 'none' : project.bots.join(', ')}`,
                'rules:',
                ...project.rules.map((rule) => `  ${ruleText(rule)}`),
              ]),
          ...(error === null ? ['watch error none'] : [`watch error (since ${clock(error.since)}):`, ...error.message.split('\n').map((line) => `  ${line}`)]),
        ],
      }
    }
  }
}

function itemLine(item: Item): string {
  return `  #${item.number} ${item.title}  ${item.author.login} (${item.author.bot ? 'bot' : item.author.association})  labels ${item.labels.join(', ')}  ${item.url}`
}

function fileLines(name: string, file: RunFile): string[] {
  switch (file.kind) {
    case 'missing': return [`${name}: missing`]
    case 'unreadable': return [`cannot read ${name}: ${file.message}`]
    case 'text': return [`${name}:`, ...file.text.split('\n').map((line) => `  ${line}`)]
  }
}
