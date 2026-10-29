import { incidentLabel, unresolved } from './incident-contract.ts'
import { ruleKey } from './config.ts'
import { runTitle } from './launch.ts'
import { ownValue } from './records.ts'
import { printableLines } from './terminal-text.ts'
import type { Config, Pending, Run, RunPhase, State } from './types.ts'

const SHORT_ID_LENGTH = 6
const RECENT_LIMIT = 10

export interface StatusView { state: State; config: Config | null; daemonPid: number | null; now: string; history: boolean }

export type FinishedPhase = Extract<RunPhase, { kind: 'done' | 'failed' | 'aborted' }>

export function shortRunId(id: string): string {
  return id.slice(-SHORT_ID_LENGTH)
}

export function resolveRunId(runs: readonly Run[], query: string): { ok: true; id: string } | { ok: false; error: string } {
  if (runs.some((run) => run.id === query)) return { ok: true, id: query }
  const matches = runs.filter((run) => shortRunId(run.id) === query).map((run) => run.id)
  if (matches.length === 1) return { ok: true, id: matches[0] }
  if (matches.length === 0) return { ok: false, error: `no run matches ${query} (give the last ${SHORT_ID_LENGTH} characters of the id or the full id; see orcapod status --history)` }
  return { ok: false, error: `${query} matches multiple runs: ${matches.join(', ')} (give the full id)` }
}

export function formatStatus(view: StatusView): string {
  const { state, config, now } = view
  return printableLines([
    view.daemonPid === null ? 'daemon: not running (start it with orcapod start)' : `daemon: running (pid ${view.daemonPid})`,
    ...(config === null ? ['config: unreadable (check it with orcapod validate)'] : []),
    ...(state.orcaOutageSince === null ? [] : [`Orca: unreachable since ${clock(state.orcaOutageSince)}`]),
    ...section('Watching', watchedLines(state, config, now)),
    ...section('Pending', [...state.pending].sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt)).map((pending) => pendingLine(pending, state, config, now))),
    ...section('Queue', state.runs.flatMap((run) => (run.phase.kind === 'queued' ? [queuedLine(run, run.phase.since, now)] : []))),
    ...section('Running', state.runs.filter(isActive).map((run) => activeLine(run, now))),
    ...(state.runs.some(unresolved) ? section('Unresolved', state.runs.filter(unresolved).map((run) => `${runLabel(run)} ${incidentLabel(run.incident)} → orcapod incident ${shortRunId(run.id)}`)) : []),
    ...(view.history
      ? section(`History (${state.runs.length})`, [...state.runs].sort(byNewest((run) => run.createdAt)).map(historyLine))
      : section('Recent', finishedRuns(state.runs).slice(0, RECENT_LIMIT).map(({ run, phase }) => `${runLabel(run)} ${finishedText(phase)}`))),
  ].join('\n'))
}

function section(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [`${title}: none`] : [`${title}:`, ...lines.map((line) => `  ${line}`)]
}

function watchedLines(state: State, config: Config | null, now: string): string[] {
  if (config === null) {
    const names = [...new Set([...Object.keys(state.lastPolledAt), ...Object.keys(state.projectErrors)])]
    return names.map((name) => `${name} (${pollText(state, name, now)})`)
  }
  return config.projects.map((project) => (project.enabled ? `${project.name} (${project.githubAccount}, ${pollText(state, project.name, now)})` : `${project.name} (disabled)`))
}

function pollText(state: State, project: string, now: string): string {
  const polledAt = ownValue(state.lastPolledAt, project)
  const error = ownValue(state.projectErrors, project)
  const polled = polledAt === undefined ? 'not polled yet' : `poll ${ago(polledAt, now)}`
  return error === undefined ? polled : `${polled}, watch error: ${error.message} (since ${ago(error.since, now)})`
}

function pendingLine(pending: Pending, state: State, config: Config | null, now: string): string {
  const [project, target, label] = JSON.parse(pending.ruleKey) as [string, string, string]
  const notes = pendingNotes(pending, state, config)
  const count = pending.items.length
  return `${project} / ${target} / ${label} — ${count} ${count === 1 ? 'item' : 'items'}, ${fireTimingText(pending, now)}${notes.length === 0 ? '' : ` (${notes.join(', ')})`}`
}

export function fireTimingText(pending: Pending, now: string): string {
  const untilFire = Date.parse(pending.fireAt) - Date.parse(now)
  return untilFire > 0 ? `launches in ${duration(untilFire)}` : 'due (launches next cycle)'
}

export function pendingNotes(pending: Pending, state: State, config: Config | null): string[] {
  if (config === null) return []
  const project = config.projects.find((p) => p.name === pending.project)
  const rule = project?.rules.find((r) => ruleKey(project.name, r) === pending.ruleKey)
  if (project === undefined || rule === undefined) return ['rule not in config, dropped when due']
  return [
    ...(rule.batch === 'together' ? ['batched'] : []),
    ...(project.enabled && rule.enabled ? [] : ['disabled: no launch until re-enabled']),
    ...(ownValue(state.projectErrors, project.name) === undefined ? [] : ['watch error: no launch until it clears']),
  ]
}

function queuedLine(run: Run, queuedSince: string, now: string): string {
  return `${runLabel(run)} waiting ${duration(Date.parse(now) - Date.parse(queuedSince))}${run.bypassLimit ? ' (--now)' : ''}`
}

export function isActive(run: Run): boolean {
  return run.phase.kind === 'launching' || run.phase.kind === 'starting' || run.phase.kind === 'running'
}

function activeLine(run: Run, now: string): string {
  const since = run.phase.kind === 'launching' ? run.phase.since : (run.startedAt ?? run.createdAt)
  return `${runLabel(run)} ${phaseText(run.phase)} ${duration(Date.parse(now) - Date.parse(since))}`
}

function historyLine(run: Run): string {
  return `${clock(run.createdAt)} ${runLabel(run)} ${phaseText(run.phase)}`
}

function finishedRuns(runs: Run[]): { run: Run; phase: FinishedPhase }[] {
  return runs
    .flatMap((run) => (isFinished(run.phase) ? [{ run, phase: run.phase }] : []))
    .sort(byNewest(({ phase }) => phase.at))
}

export function isFinished(phase: RunPhase): phase is FinishedPhase {
  return phase.kind === 'done' || phase.kind === 'failed' || phase.kind === 'aborted'
}

export function phaseText(phase: RunPhase): string {
  if (isFinished(phase)) return finishedText(phase)
  return phase.kind === 'running' ? `running/${phase.agent}` : phase.kind
}

export function finishedText(phase: FinishedPhase): string {
  if (phase.kind === 'done') return `done ${clock(phase.at)} "${phase.summary}"${tabLeftNote(phase.tabClosed)}`
  return `${phase.kind} ${clock(phase.at)} (${phase.reason})${phase.kind === 'failed' ? tabLeftNote(phase.tabClosed) : ''}`
}

function tabLeftNote(tabClosed: boolean): string {
  return tabClosed ? '' : ' (tab remains)'
}

export function runLabel(run: Run): string {
  return `${shortRunId(run.id)} "${runTitle(run)}"`
}

export function byNewest<T>(timeOf: (value: T) => string): (a: T, b: T) => number {
  return (a, b) => Date.parse(timeOf(b)) - Date.parse(timeOf(a))
}

export function ago(iso: string, now: string): string {
  return `${duration(Date.parse(now) - Date.parse(iso))} ago`
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function clock(iso: string): string {
  const date = new Date(iso)
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}
