import { incidentLabel, unresolved } from './incident-contract.ts'
import { ruleKey } from './config.ts'
import { runTitle } from './launch.ts'
import { ownValue } from './records.ts'
import { ago, byNewest, clock, duration, fireTimingText, isActive, isFinished, pendingNotes, phaseText, shortRunId } from './status.ts'
import type { Config, ConfigResult, ConfigStatus, Pending, Project, Rule, Run, State } from './types.ts'

const FALLBACK_CYCLE_SECONDS = 20
const STALE_CYCLES = 3

export type DaemonHealth =
  | { kind: 'never' }
  | { kind: 'alive'; pid: number; updatedAt: string }
  | { kind: 'stale'; pid: number; updatedAt: string }
  | { kind: 'stopped'; updatedAt: string }
export type ConfigView =
  | { kind: 'running'; config: Config; loadedAt: string }
  | { kind: 'unreflected'; disk: Config | null; diskError: string | null; status: ConfigStatus }
  | { kind: 'unknown'; disk: Config | null; diskError: string | null }
export type DetailRef = { kind: 'run'; runId: string } | { kind: 'pending'; ruleKey: string } | { kind: 'project'; name: string; ruleKey?: string }
export type RowRef = DetailRef | { kind: 'notice'; key: string }
export type ColumnId = 'mark' | 'id' | 'project' | 'title' | 'phase' | 'elapsed' | 'note' | 'lastMessage' | 'rules'
export interface Cell { column: ColumnId; text: string }
export interface Row { ref: RowRef; cells: Cell[]; hint: string | null }
export type SectionId = 'attention' | 'active' | 'waiting' | 'recent' | 'projects'
export interface Section { id: SectionId; title: string; rows: Row[] }
export interface HeaderPart { text: string; alert: boolean }
export type RunFile = { kind: 'text'; text: string } | { kind: 'missing' } | { kind: 'unreadable'; message: string }
export type DetailContent =
  | { kind: 'run'; run: Run; resultJson: RunFile; lastMessage: RunFile }
  | { kind: 'pending'; pending: Pending; rule: Rule | null }
  | { kind: 'project'; name: string; project: Project | null; error: { since: string; message: string } | null }
export interface MonitorModel { home: string; header: HeaderPart[]; neverStarted: boolean; sections: Section[]; history: Row[]; configLines: string[] }
export interface MonitorInput { home: string; state: State | null; stateError: string | null; stateMtime: string | null; daemonPid: number | null; lockError: string | null; config: ConfigView; now: string }

interface Attention { mark: string; note: string | null; since: string; hint: string }

export function daemonHealthOf(stateMtime: string | null, daemonPid: number | null, cycleSeconds: number, now: string): DaemonHealth {
  if (stateMtime === null) return { kind: 'never' }
  if (daemonPid === null) return { kind: 'stopped', updatedAt: stateMtime }
  if (Date.parse(now) - Date.parse(stateMtime) >= STALE_CYCLES * cycleSeconds * 1000) return { kind: 'stale', pid: daemonPid, updatedAt: stateMtime }
  return { kind: 'alive', pid: daemonPid, updatedAt: stateMtime }
}

export function configViewOf(disk: ConfigResult, status: ConfigStatus | null): ConfigView {
  const diskConfig = disk.ok ? disk.config : null
  const diskError = disk.ok ? null : disk.errors.join('\n')
  if (status === null) return { kind: 'unknown', disk: diskConfig, diskError }
  if (status.error === null && disk.ok && disk.sha256 === status.sha256) return { kind: 'running', config: disk.config, loadedAt: status.loadedAt }
  return { kind: 'unreflected', disk: diskConfig, diskError, status }
}

export function buildMonitorModel(input: MonitorInput): MonitorModel {
  const { state, now } = input
  const config = shownConfig(input.config)
  const health = daemonHealthOf(input.stateMtime, input.daemonPid, state?.daemonInfo?.cycleSeconds ?? FALLBACK_CYCLE_SECONDS, now)
  return {
    home: input.home,
    header: headerOf(input, health, config),
    neverStarted: state === null,
    sections: state === null ? [] : sectionsOf(state, config, health, now),
    history: state === null ? [] : finishedRuns(state.runs).map((run) => runRow(run, now, null)),
    configLines: configLinesOf(input.config, state?.watchedRules ?? []),
  }
}

export function ruleText(rule: Rule): string {
  return `${rule.target}/${rule.label} → ${rule.kind} ${rule.ai} batch ${rule.batch} delay ${rule.delayMinutes}m bootstrap ${rule.bootstrap}${ruleAuthorsText(rule)}${rule.enabled ? '' : ' (disabled)'}`
}

function ruleAuthorsText(rule: Rule): string {
  return rule.authors === undefined ? '' : ` authors [${rule.authors.join(', ')}]`
}

export function shownConfig(view: ConfigView): Config | null {
  return view.kind === 'running' ? view.config : view.disk
}

function headerOf(input: MonitorInput, health: DaemonHealth, config: Config | null): HeaderPart[] {
  const { state, now } = input
  const parts: HeaderPart[] = [
    ...(state === null ? [] : stateParts(state, config)),
    configPart(input.config),
    ...(input.stateError === null ? [] : [{ text: input.stateError, alert: true }]),
    ...(input.lockError === null ? [] : [{ text: input.lockError, alert: true }]),
  ]
  return [
    { text: 'orcapod monitor', alert: false },
    daemonPart(health, now),
    ...parts.filter((part) => part.alert),
    ...parts.filter((part) => !part.alert),
    { text: `home ${input.home}`, alert: false },
  ]
}

function daemonPart(health: DaemonHealth, now: string): HeaderPart {
  switch (health.kind) {
    case 'never': return { text: 'daemon: never started', alert: true }
    case 'alive': return { text: `daemon: running pid ${health.pid} (updated ${ago(health.updatedAt, now)})`, alert: false }
    case 'stale': return { text: `daemon: possibly stopped pid ${health.pid} (updated ${ago(health.updatedAt, now)})`, alert: true }
    case 'stopped': return { text: `daemon: stopped (updated ${ago(health.updatedAt, now)})`, alert: true }
  }
}

function stateParts(state: State, config: Config | null): HeaderPart[] {
  const orcaVersion = state.daemonInfo === null ? 'Orca version unknown (daemon is the 001 version)' : `Orca ${state.daemonInfo.orcaVersion ?? 'version unknown'}`
  const failing = Object.keys(state.projectErrors)
  const healthy = watchedProjectNames(state, config).filter((name) => !failing.includes(name))
  return [
    ...(state.orcaOutageSince === null ? [] : [{ text: `Orca: unreachable since ${clock(state.orcaOutageSince)}`, alert: true }]),
    { text: orcaVersion, alert: false },
    { text: `GitHub: ${healthy.length} healthy${failing.length === 0 ? '' : ` / watch error ${failing.join(' ')}`}`, alert: failing.length > 0 },
  ]
}

function watchedProjectNames(state: State, config: Config | null): string[] {
  if (config !== null) return config.projects.filter((project) => project.enabled).map((project) => project.name)
  return projectNamesOf(state)
}

function projectNamesOf(state: State): string[] {
  return [...new Set([...Object.keys(state.lastPolledAt), ...Object.keys(state.projectErrors)])]
}

function configPart(view: ConfigView): HeaderPart {
  switch (view.kind) {
    case 'running': return { text: `config loaded ${clock(view.loadedAt)} OK`, alert: false }
    case 'unreflected': {
      const reason = view.status.error ?? view.diskError
      return { text: `config not applied (daemon runs the config loaded ${clock(view.status.loadedAt)}${reason === null ? '' : `; error: ${reason}`})`, alert: true }
    }
    case 'unknown': return { text: `config status unknown${view.diskError === null ? '' : ` (config on disk: ${view.diskError})`}`, alert: view.diskError !== null }
  }
}

function sectionsOf(state: State, config: Config | null, health: DaemonHealth, now: string): Section[] {
  const attentionRuns = state.runs.flatMap((run) => {
    const attention = attentionOf(run)
    return attention === null ? [] : [{ run, attention }]
  })
  const inAttention = new Set(attentionRuns.map(({ run }) => run.id))
  const rest = state.runs.filter((run) => !inAttention.has(run.id))
  const attention = [
    ...attentionRuns.map(({ run, attention }) => attentionRunRow(run, attention, now)),
    ...stateAttentionRows(state, health, now),
  ]
  const active = rest.filter(isActive).map((run) => runRow(run, now, null))
  const waiting = [
    ...rest.filter((run) => run.phase.kind === 'queued').map((run) => runRow(run, now, null)),
    ...[...state.pending].sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt)).map((pending) => pendingRow(pending, state, config, now)),
  ]
  const recent = finishedRuns(rest).map((run) => runRow(run, now, null))
  const projects = projectRows(state, config, now)
  return [
    { id: 'attention', title: attention.length === 0 ? 'Attention none' : `Attention ${attention.length}`, rows: attention },
    { id: 'active', title: `Running ${active.length}${limitsText(state, config)}`, rows: active },
    { id: 'waiting', title: `Pending / queue ${waiting.length}`, rows: waiting },
    { id: 'recent', title: 'Recent (h for all)', rows: recent },
    { id: 'projects', title: `Projects ${config?.projects.length ?? projects.length}${config === null ? '' : ` / rules ${projects.length}`} (c for full config)`, rows: projects },
  ]
}

function attentionOf(run: Run): Attention | null {
  const { phase } = run
  if (unresolved(run)) return { mark: '!', note: incidentLabel(run.incident), since: run.incident?.updatedAt ?? ('at' in phase ? phase.at : run.createdAt), hint: `→ orcapod incident ${shortRunId(run.id)}` }
  if (phase.kind === 'failed' && !phase.tabClosed) return { mark: '!', note: null, since: phase.at, hint: `→ orcapod stop ${shortRunId(run.id)}` }
  if (phase.kind === 'running' && phase.waitingSince !== undefined) return { mark: '?', note: 'waiting for input', since: phase.waitingSince, hint: '→ answer in the Orca tab' }
  if (phase.kind === 'starting' && run.notified.includes('starting-stall')) return { mark: '!', note: 'slow to start', since: run.startedAt ?? phase.since, hint: '→ accept the trust dialog in the Orca tab' }
  if (phase.kind === 'queued' && run.notified.includes('queued')) return { mark: '!', note: 'queue stalled', since: phase.since, hint: '→ orcapod logs' }
  return null
}

function attentionRunRow(run: Run, attention: Attention, now: string): Row {
  const row = runRow(run, now, attention.note)
  const elapsed: Cell[] = isFinished(run.phase) ? [] : [{ column: 'elapsed', text: duration(Date.parse(now) - Date.parse(attention.since)) }]
  return {
    ref: row.ref,
    cells: [{ column: 'mark', text: attention.mark }, ...row.cells.filter((cell) => cell.column !== 'elapsed'), ...elapsed],
    hint: attention.hint,
  }
}

function stateAttentionRows(state: State, health: DaemonHealth, now: string): Row[] {
  const lastCycleError = state.daemonInfo?.lastCycleError ?? null
  return [
    ...Object.entries(state.projectErrors).map(([name, error]) => noticeRow(`project-error:${name}`, name, 'watch error', `${error.message} (since ${ago(error.since, now)})`)),
    ...(state.orcaOutageSince === null ? [] : [noticeRow('orca-outage', 'Orca', 'unreachable', `since ${clock(state.orcaOutageSince)}`)]),
    ...(lastCycleError === null ? [] : [noticeRow('cycle-error', 'daemon', 'cycle failed', `daemon cycle failed (${clock(lastCycleError.at)}): ${lastCycleError.message}`)]),
    ...(health.kind === 'stale' ? [noticeRow('daemon-stale', 'daemon', 'not updating', `daemon possibly stopped (pid ${health.pid}, updated ${ago(health.updatedAt, now)})`)] : []),
    ...(health.kind === 'stopped' ? [noticeRow('daemon-stopped', 'daemon', 'stopped', `daemon: stopped (updated ${ago(health.updatedAt, now)})`)] : []),
  ]
}

function noticeRow(key: string, subject: string, title: string, note: string): Row {
  return {
    ref: { kind: 'notice', key },
    cells: [{ column: 'mark', text: '!' }, { column: 'id', text: '-' }, { column: 'project', text: subject }, { column: 'title', text: title }, { column: 'note', text: note }],
    hint: '→ orcapod logs',
  }
}

function runRow(run: Run, now: string, note: string | null): Row {
  const since = sinceOf(run)
  const notes = [note, run.manual ? 'manual' : null, run.bypassLimit ? '--now' : null].filter((text) => text !== null)
  const cells: Cell[] = [
    { column: 'id', text: shortRunId(run.id) },
    { column: 'project', text: run.project },
    { column: 'title', text: runTitle(run) },
    { column: 'phase', text: phaseText(run.phase) },
    ...(since === null ? [] : [{ column: 'elapsed' as const, text: duration(Date.parse(now) - Date.parse(since)) }]),
    ...(notes.length === 0 ? [] : [{ column: 'note' as const, text: notes.join(' / ') }]),
    ...(isActive(run) ? [{ column: 'lastMessage' as const, text: `last: ${lastMessageOf(run)}` }] : []),
  ]
  return { ref: { kind: 'run', runId: run.id }, cells, hint: null }
}

function sinceOf(run: Run): string | null {
  switch (run.phase.kind) {
    case 'queued':
    case 'launching':
      return run.phase.since
    case 'starting':
    case 'running':
      return run.startedAt ?? run.createdAt
    default:
      return null
  }
}

function lastMessageOf(run: Run): string {
  return run.rule.ai === 'codex' || run.lastMessage === null ? '—' : run.lastMessage
}

function finishedRuns(runs: Run[]): Run[] {
  return runs
    .flatMap((run) => (isFinished(run.phase) ? [{ run, at: run.phase.at }] : []))
    .sort(byNewest(({ at }) => at))
    .map(({ run }) => run)
}

function pendingRow(pending: Pending, state: State, config: Config | null, now: string): Row {
  const rule = ruleOfPending(config, pending)
  const notes = pendingNotes(pending, state, config)
  return {
    ref: { kind: 'pending', ruleKey: pending.ruleKey },
    cells: [
      { column: 'id', text: '-' },
      { column: 'project', text: pending.project },
      { column: 'title', text: rule === null ? pending.ruleKey : `${rule.target}/${rule.label}` },
      { column: 'phase', text: `pending ${pending.items.length} ${pending.items.length === 1 ? 'item' : 'items'}` },
      { column: 'elapsed', text: fireTimingText(pending, now) },
      ...(notes.length === 0 ? [] : [{ column: 'note' as const, text: notes.join(', ') }]),
    ],
    hint: null,
  }
}

export function ruleOfPending(config: Config | null, pending: Pending): Rule | null {
  const project = config?.projects.find((candidate) => candidate.name === pending.project)
  return project?.rules.find((rule) => ruleKey(project.name, rule) === pending.ruleKey) ?? null
}

function limitsText(state: State, config: Config | null): string {
  const counts = new Map<string, number>()
  for (const run of state.runs.filter(isActive)) counts.set(run.project, (counts.get(run.project) ?? 0) + 1)
  if (counts.size === 0) return ''
  const limit = config === null ? '?' : String(config.settings.maxConcurrentPerProject)
  return ` (${[...counts].map(([project, count]) => `${project} ${count}/${limit}`).join(', ')})`
}

function projectRows(state: State, config: Config | null, now: string): Row[] {
  if (config === null) return projectNamesOf(state).map((name) => projectRow(name, null, state, now))
  return config.projects.flatMap((project) => project.rules.map((rule) => projectRow(project.name, project, state, now, rule)))
}

function projectRow(name: string, project: Project | null, state: State, now: string, rule?: Rule): Row {
  const polledAt = ownValue(state.lastPolledAt, name)
  const error = ownValue(state.projectErrors, name)
  const notes = [
    ...(project === null ? [] : [project.githubAccount]),
    project?.enabled === false ? 'disabled' : polledAt === undefined ? 'not polled yet' : `poll ${ago(polledAt, now)}`,
    ...(error === undefined ? [] : [`watch error ${error.message}`]),
  ]
  return {
    ref: { kind: 'project', name, ...(rule === undefined ? {} : { ruleKey: ruleKey(name, rule) }) },
    cells: [
      { column: 'project', text: name },
      { column: 'note', text: notes.join('  ') },
      ...(rule === undefined ? [] : [{ column: 'rules' as const, text: ruleSummary(rule) }]),
    ],
    hint: null,
  }
}

function ruleSummary(rule: Rule): string {
  return `${rule.target}/${rule.label}→${rule.kind} ${rule.ai}${rule.batch === 'together' ? ' together' : ''} ${rule.delayMinutes}m${ruleAuthorsText(rule)}${rule.enabled ? '' : ' (disabled)'}`
}

function configLinesOf(view: ConfigView, watchedRules: string[]): string[] {
  switch (view.kind) {
    case 'running':
      return [`Config in effect (loaded ${clock(view.loadedAt)})`, '', ...configBody(view.config)]
    case 'unreflected':
      return [
        'Config not applied',
        ...(view.status.error === null ? [] : ['Daemon load error:', ...indented(view.status.error)]),
        ...(view.diskError === null || view.diskError === view.status.error ? [] : ['Parse error in config.yaml on disk:', ...indented(view.diskError)]),
        ...(view.status.error === null && view.diskError === null ? ['config.yaml on disk differs from what the daemon loaded (the daemon loads it next cycle)'] : []),
        `Daemon runs the config loaded at ${clock(view.status.loadedAt)}`,
        'Rule keys in effect:',
        ...(watchedRules.length === 0 ? ['  none'] : watchedRules.map((key) => `  ${key}`)),
        ...(view.disk === null ? [] : ['', 'Config on disk (not applied):', ...configBody(view.disk)]),
      ]
    case 'unknown':
      return [
        'Config status unknown (the daemon is the 001 version or has never run)',
        ...(view.diskError === null ? [] : ['Parse error in config.yaml on disk:', ...indented(view.diskError)]),
        ...(view.disk === null ? [] : ['', 'Config on disk:', ...configBody(view.disk)]),
      ]
  }
}

function indented(text: string): string[] {
  return text.split('\n').map((line) => `  ${line}`)
}

function configBody(config: Config): string[] {
  const { settings } = config
  return [
    'settings:',
    `  maxConcurrentPerProject: ${settings.maxConcurrentPerProject}`,
    `  launch.claude: ${settings.launch.claude}`,
    `  launch.codex: ${settings.launch.codex}`,
    `  notify: desktop ${settings.notify.desktop ? 'on' : 'off'}, waitingMinutes ${settings.notify.waitingMinutes}, maxRunMinutes ${settings.notify.maxRunMinutes}, queuedMinutes ${settings.notify.queuedMinutes}`,
    'kinds:',
    ...config.kinds.map((kind) => `  ${kind.id}: ${kind.name}`),
    'projects:',
    ...config.projects.flatMap((project) => [
      `  ${project.name}${project.enabled ? '' : ' (disabled)'}  ${project.repo}  ${project.path}`,
      `    githubAccount: ${project.githubAccount}`,
      `    authors: ${project.authors.join(', ')}`,
      `    bots: ${project.bots.length === 0 ? 'none' : project.bots.join(', ')}`,
      '    rules:',
      ...project.rules.map((rule) => {
        const promptKey = `${rule.kind}.${rule.ai}`
        return `      ${ruleText(rule)}  prompts/${promptKey}.md ${config.prompts.has(promptKey) ? 'present' : 'missing'}`
      }),
    ]),
  ]
}
