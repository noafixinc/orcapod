import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { checkProposal } from './approval.ts'
import { loadConfig } from './config.ts'
import { prepareRun, runTitle } from './launch.ts'
import type { RunDirMode } from './launch.ts'
import { log } from './log.ts'
import { OrcaError, usablePane } from './orca.ts'
import { panePath, resultPath, runDir, stateDir } from './paths.ts'
import { ownValue, setOwnValue } from './records.ts'
import { acquireDaemonLock, consumeRequest, loadState, readRequests, releaseDaemonLock, saveState } from './state.ts'
import { applyClose, applyLaunch, tick } from './tick.ts'
import type { Config, ConfigResult, ConfigStatus, CycleDeps, DaemonInfo, Effect, Item, Observations, OrcaClient, OrcaRef, Project, Run, RunPhase, State } from './types.ts'

const CYCLE_INTERVAL_MS = 20_000
const POLL_INTERVAL_MS = 60_000
const HOOKS_CHECK_AFTER_MS = 60_000
const STARTUP_FAILURE_WAIT_MS = 60_000
const SCREEN_LINES = 6

type DaemonIdentity = Omit<DaemonInfo, 'lastCycleAt' | 'lastCycleError'>
export interface CycleMemory {
  config: Config | null
  configBroken: boolean
  ghAccounts: string[]
  accountsMissingAfterRefresh: string[]
  configStatus: ConfigStatus | null
  daemon: DaemonIdentity
  lastCycleError: DaemonInfo['lastCycleError']
}
type EffectOf<T extends Effect['type']> = Extract<Effect, { type: T }>
type AccountAwareLoad = { loaded: ConfigResult; ghAccounts: string[]; accountsMissingAfterRefresh: string[] }

export async function runCycle(deps: CycleDeps, previous: CycleMemory): Promise<CycleMemory> {
  const now = deps.now().toISOString()
  const { loaded, ghAccounts, accountsMissingAfterRefresh } = await loadConfigRefreshingAccounts(deps, previous)
  const memory: CycleMemory = {
    ...previous,
    ...(await rememberConfig(deps, previous, loaded)),
    ghAccounts,
    accountsMissingAfterRefresh,
    configStatus: configStatusAfter(previous.configStatus, loaded, now),
  }
  if (memory.config === null) return memory
  const config = memory.config

  const before = loadState(deps.home)
  const observations = await observe(deps, before, config, now)
  const daemon = await refreshOrcaVersion(deps.orca, memory.daemon, before, observations)
  const stamped: State = { ...before, configStatus: memory.configStatus, daemonInfo: { ...daemon, lastCycleAt: now, lastCycleError: memory.lastCycleError } }
  const ticked = tick(stamped, observations)
  for (const effect of effectsOf(ticked.effects, 'notify')) await deliver(deps, config, effect)
  saveState(deps.home, ticked.state)
  const relaunching = new Set(before.runs.filter((run) => run.phase.kind === 'launching').map((run) => run.id))
  const after = await runEffects(deps, config, ticked.state, ticked.effects, relaunching, now)
  saveState(deps.home, after)
  for (const effect of effectsOf(ticked.effects, 'consumeRequest')) consumeRequest(deps.home, effect.file)
  recordRunChanges(deps.home, before, after)
  return { ...memory, daemon, lastCycleError: null }
}

function configStatusAfter(previous: ConfigStatus | null, loaded: ConfigResult, now: string): ConfigStatus | null {
  if (!loaded.ok) return previous === null ? null : { ...previous, error: loaded.errors.join('\n') }
  return previous?.sha256 === loaded.sha256 ? { ...previous, error: null } : { loadedAt: now, sha256: loaded.sha256, error: null }
}

async function refreshOrcaVersion(orca: OrcaClient, daemon: DaemonIdentity, before: State, observations: Observations): Promise<DaemonIdentity> {
  const reconnected = before.orcaOutageSince !== null && observations.orca.ok
  if (daemon.orcaVersion !== null && !reconnected) return daemon
  return { ...daemon, orcaVersion: await orcaVersionOf(orca) }
}

async function orcaVersionOf(orca: OrcaClient): Promise<string | null> {
  try {
    return (await orca.status()).version
  } catch {
    return null
  }
}

export async function start(deps: CycleDeps, onStartup?: (ok: boolean) => void): Promise<never> {
  const { home } = deps
  const lock = acquireDaemonLock(home, process.pid)
  if (!lock.ok) {
    console.error(`orcapod start: already running (pid ${lock.holder})`)
    return process.exit(1)
  }
  let ghAccounts: string[]
  try {
    ghAccounts = await deps.ghAccounts()
  } catch (error) {
    console.error(`orcapod start: ${messageOf(error)}`)
    return exitAfterStartupFailure(home, 1, onStartup)
  }
  const loaded = loadConfig(home, { ghAccounts })
  if (!loaded.ok) {
    for (const line of loaded.errors) console.error(line)
    await reportStartupError(deps, loaded.errors)
    return exitAfterStartupFailure(home, 0, onStartup)
  }
  try {
    loadState(home)
  } catch (error) {
    console.error(`orcapod start: ${messageOf(error)}`)
    return exitAfterStartupFailure(home, 1, onStartup)
  }
  rmSync(startupErrorPath(home), { force: true })
  log(home, 'info', `daemon started (pid ${process.pid})`)

  const startedAt = deps.now().toISOString()
  let memory: CycleMemory = {
    config: loaded.config,
    configBroken: false,
    ghAccounts,
    accountsMissingAfterRefresh: [],
    configStatus: { loadedAt: startedAt, sha256: loaded.sha256, error: null },
    daemon: { pid: process.pid, startedAt, orcaVersion: await orcaVersionOf(deps.orca), cycleSeconds: CYCLE_INTERVAL_MS / 1000 },
    lastCycleError: null,
  }
  let cycling = false
  let stopping = false
  const shutdown = (): never => {
    releaseDaemonLock(home, process.pid)
    log(home, 'info', 'daemon stopped')
    return process.exit(0)
  }
  const requestStop = (): void => {
    stopping = true
    if (!cycling) shutdown()
  }
  process.on('SIGTERM', requestStop)
  process.on('SIGINT', requestStop)

  const cycle = async (): Promise<void> => {
    cycling = true
    try {
      memory = await runCycle(deps, memory)
    } catch (error) {
      const message = messageOf(error)
      log(home, 'error', `cycle failed: ${message}`)
      memory = { ...memory, lastCycleError: { at: deps.now().toISOString(), message } }
    }
    cycling = false
    if (stopping) shutdown()
    setTimeout(() => void cycle(), CYCLE_INTERVAL_MS)
  }
  onStartup?.(true)
  void cycle()
  return new Promise<never>(() => {})
}

async function loadConfigRefreshingAccounts(deps: CycleDeps, previous: CycleMemory): Promise<AccountAwareLoad> {
  const loaded = loadConfig(deps.home, { ghAccounts: previous.ghAccounts })
  if (loaded.ok) return { loaded, ghAccounts: previous.ghAccounts, accountsMissingAfterRefresh: [] }
  const unknown = loaded.unknownGithubAccounts
  if (unknown.length === 0 || sameNames(unknown, previous.accountsMissingAfterRefresh)) {
    return { loaded, ghAccounts: previous.ghAccounts, accountsMissingAfterRefresh: previous.accountsMissingAfterRefresh }
  }
  let ghAccounts: string[]
  try {
    ghAccounts = await deps.ghAccounts()
  } catch (error) {
    log(deps.home, 'warn', `cannot reload the gh accounts: ${messageOf(error)}`)
    return { loaded, ghAccounts: previous.ghAccounts, accountsMissingAfterRefresh: unknown }
  }
  log(deps.home, 'info', `githubAccount in the config (${unknown.join(', ')}) is not a known account, so the gh accounts were reloaded: ${ghAccounts.join(', ') || 'none'}`)
  const reloaded = loadConfig(deps.home, { ghAccounts })
  return { loaded: reloaded, ghAccounts, accountsMissingAfterRefresh: reloaded.ok ? [] : reloaded.unknownGithubAccounts }
}

function sameNames(a: string[], b: string[]): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
}

async function rememberConfig(deps: CycleDeps, previous: CycleMemory, loaded: ConfigResult): Promise<Pick<CycleMemory, 'config' | 'configBroken'>> {
  if (loaded.ok) {
    if (previous.configBroken) log(deps.home, 'info', 'config fixed')
    return { config: loaded.config, configBroken: false }
  }
  if (!previous.configBroken) {
    for (const line of loaded.errors) log(deps.home, 'warn', `config broken: ${line}`)
    await sendNotice(deps, previous.config, 'orcapod: config broken', `Keeps running with the previous config. ${summarize(loaded.errors)}`)
  }
  return { config: previous.config, configBroken: true }
}

async function observe(deps: CycleDeps, state: State, config: Config, now: string): Promise<Observations> {
  const requests = readRequests(deps.home)
  const stopTargets = new Set(requests.flatMap((read) => ('request' in read && read.request.type === 'stop' ? [read.request.runId] : [])))
  const [github, orca] = await Promise.all([pollGithub(deps, state, config, now), observeOrca(deps, state, stopTargets, now)])
  return { now, config, github, orca, results: readResults(deps.home, state), panes: readPanes(deps.home, state, stopTargets), requests }
}

async function pollGithub(deps: CycleDeps, state: State, config: Config, now: string): Promise<Observations['github']> {
  const due = config.projects.filter((project) => project.enabled && isPollDue(ownValue(state.lastPolledAt, project.name), now))
  return Object.fromEntries(await Promise.all(due.map(async (project) => [project.name, await pollProject(deps, project)] as const)))
}

function isPollDue(lastPolledAt: string | undefined, now: string): boolean {
  return lastPolledAt === undefined || Date.parse(lastPolledAt) + POLL_INTERVAL_MS <= Date.parse(now)
}

async function pollProject(deps: CycleDeps, project: Project): Promise<{ ok: true; items: Item[] } | { ok: false; error: string }> {
  if (!existsSync(project.path)) return { ok: false, error: `folder not found: ${project.path}` }
  try {
    return { ok: true, items: await deps.github(project) }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

async function observeOrca(deps: CycleDeps, state: State, stopTargets: ReadonlySet<string>, now: string): Promise<Observations['orca']> {
  const watched = state.runs.filter((run) => isObservationTarget(run, stopTargets))
  const paths = [...new Set(watched.map((run) => run.target.path))]
  const hooks = state.runs.some((run) => run.phase.kind === 'starting' && Date.parse(now) - Date.parse(run.phase.since) >= HOOKS_CHECK_AFTER_MS)
  try {
    return { ok: true, ...(await deps.orca.observe({ paths, hooks })) }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

function isObservationTarget(run: Run, stopTargets: ReadonlySet<string>): boolean {
  return isActive(run.phase)
    || run.launchUncertain === true
    || stopTargets.has(run.id)
    || hasTrackableOpenFailedTab(run)
    || hasTrackableOpenResolutionTab(run)
}

function isActive(phase: RunPhase): boolean {
  return phase.kind === 'launching' || phase.kind === 'starting' || phase.kind === 'running'
}

function hasTrackableOpenFailedTab(run: Run): boolean {
  return run.phase.kind === 'failed' && !run.phase.tabClosed && run.orca !== null
}

function hasTrackableOpenResolutionTab(run: Run): boolean {
  return run.orca !== null
    && (run.recovery !== undefined || run.incident !== undefined)
    && (!('tabClosed' in run.phase) || !run.phase.tabClosed)
}

function readResults(home: string, state: State): Observations['results'] {
  const results: Observations['results'] = {}
  for (const run of state.runs) {
    if (run.phase.kind !== 'starting' && run.phase.kind !== 'running') continue
    const path = resultPath(home, run.id)
    if (!existsSync(path)) continue
    try {
      setOwnValue(results, run.id, { raw: readFileSync(path, 'utf8'), mtime: statSync(path).mtime.toISOString() })
    } catch (error) {
      log(home, 'warn', `run ${run.id}: cannot read result.json: ${messageOf(error)}`)
    }
  }
  return results
}

function readPanes(home: string, state: State, stopTargets: ReadonlySet<string>): Observations['panes'] {
  const panes: Observations['panes'] = {}
  for (const run of state.runs) {
    const paneUnknownForStop = stopTargets.has(run.id) && run.orca === null
    const path = panePath(home, run.id)
    if ((run.phase.kind === 'launching' || run.launchUncertain === true || paneUnknownForStop) && existsSync(path)) {
      const pane = paneRefOf(readFileSync(path, 'utf8'))
      if (pane !== null) setOwnValue(panes, run.id, pane)
    }
  }
  return panes
}

function paneRefOf(text: string): OrcaRef | null {
  const fields = jsonObjectOrEmpty(text)
  const field = (name: string): string => (typeof fields[name] === 'string' ? fields[name] : '')
  const ref = { handle: field('handle'), tabId: field('tabId'), paneKey: field('paneKey'), ptyId: '' }
  return usablePane(ref) ? ref : null
}

function jsonObjectOrEmpty(text: string): Record<string, unknown> {
  try {
    const json: unknown = JSON.parse(text)
    return typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function runEffects(deps: CycleDeps, config: Config, state: State, effects: Effect[], relaunching: ReadonlySet<string>, now: string): Promise<State> {
  let current = state
  for (const effect of effectsOf(effects, 'launch')) current = await launch(deps, config, current, effect.runId, relaunching.has(effect.runId) ? 'reuse-relaunch' : 'create', now)
  for (const effect of effectsOf(effects, 'close')) current = await close(deps, current, effect, now)
  for (const effect of effectsOf(effects, 'writeLastMessage')) writeLastMessage(deps.home, effect)
  for (const effect of effectsOf(effects, 'log')) log(deps.home, effect.level, effect.message)
  return current
}

function effectsOf<T extends Effect['type']>(effects: Effect[], type: T): EffectOf<T>[] {
  return effects.filter((effect): effect is EffectOf<T> => effect.type === type)
}

async function launch(deps: CycleDeps, config: Config, state: State, runId: string, dirMode: RunDirMode, now: string): Promise<State> {
  const run = state.runs.find((r) => r.id === runId)
  if (run === undefined) return state
  let creatingTerminal = false
  try {
    if (run.recovery?.stage === 'apply') {
      const source = state.runs.find((candidate) => candidate.id === run.recovery!.sourceRunId)
      if (source?.incident?.status !== 'applying' || source.incident.approvedRevision !== run.recovery.proposal?.revision) throw new Error('the approval has expired')
      checkProposal(run.recovery.proposal!, config, source)
    }
    const prepared = prepareRun(deps.home, run, config, dirMode)
    creatingTerminal = true
    const created = await deps.orca.createTerminal({ worktreePath: run.target.path, title: prepared.title, command: prepared.command })
    if (created.warning !== null) log(deps.home, 'warn', `run ${runId}: terminal create warning: ${created.warning}`)
    return applyLaunch(state, runId, { ok: true, orca: created.ref }, now)
  } catch (error) {
    const message = messageOf(error)
    if (creatingTerminal) run.launchUncertain = true
    if (isOutcomeUnknown(error)) {
      log(deps.home, 'warn', `run ${runId}: terminal create outcome unknown (${message}). Staying in launching and waiting for pane.json; stops as unconfirmed if it does not appear within 5 minutes`)
      return state
    }
    await sendNotice(deps, config, 'orcapod: launch failed', `${runId} "${runTitle(run)}": ${message}`)
    return applyLaunch(state, runId, { ok: false, error: message }, now)
  }
}

function isOutcomeUnknown(error: unknown): boolean {
  return error instanceof OrcaError && error.code === 'exec_failed'
}

async function close(deps: CycleDeps, state: State, effect: EffectOf<'close'>, now: string): Promise<State> {
  try {
    const { ptyKilled } = await deps.orca.closeTerminal(effect.handle)
    if (ptyKilled !== true) log(deps.home, 'warn', `run ${effect.runId}: terminal close did not confirm the stop (ptyKilled: ${ptyKilled})`)
    return applyClose(state, effect.runId, { ok: true, ptyKilled }, now)
  } catch (error) {
    const code = error instanceof OrcaError ? error.code : 'exec_failed'
    const detail = code === 'terminal_handle_stale' ? 'the handle was stale; fetching it again and retrying the close next cycle' : `cannot close the tab (${code}: ${messageOf(error)})`
    log(deps.home, 'warn', `run ${effect.runId}: ${detail}`)
    return applyClose(state, effect.runId, { ok: false, code }, now)
  }
}

function writeLastMessage(home: string, effect: EffectOf<'writeLastMessage'>): void {
  try {
    writeFileSync(join(runDir(home, effect.runId), 'last-message.md'), effect.text)
  } catch (error) {
    log(home, 'warn', `run ${effect.runId}: cannot write last-message.md: ${messageOf(error)}`)
  }
}

async function deliver(deps: CycleDeps, config: Config, effect: EffectOf<'notify'>): Promise<void> {
  let message = effect.message
  if (effect.withScreenOf !== undefined) {
    try {
      const screen = await deps.orca.readScreen(effect.withScreenOf, SCREEN_LINES)
      if (screen.rendered && screen.lines.length > 0) message = `${message}\n${screen.lines.join('\n')}`
    } catch (error) {
      log(deps.home, 'warn', `cannot read the screen (${effect.withScreenOf}): ${messageOf(error)}`)
    }
  }
  await sendNotice(deps, config, effect.title, message)
}

async function sendNotice(deps: CycleDeps, config: Config | null, title: string, message: string): Promise<void> {
  log(deps.home, 'info', `notify ${title}: ${message}`)
  if (config !== null && !config.settings.notify.desktop) return
  try {
    await deps.notify(title, message)
  } catch (error) {
    log(deps.home, 'warn', `cannot send the notification: ${messageOf(error)}`)
  }
}

function recordRunChanges(home: string, before: State, after: State): void {
  const previous = new Map(before.runs.map((run) => [run.id, run]))
  for (const run of after.runs) {
    const old = previous.get(run.id)
    if (old !== undefined && JSON.stringify(old) === JSON.stringify(run)) continue
    if (old?.phase.kind !== run.phase.kind) log(home, 'info', `run ${run.id} "${runTitle(run)}": ${old?.phase.kind ?? 'created'} → ${describePhase(run.phase)}`)
    const dir = runDir(home, run.id)
    if (existsSync(dir)) writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(run, null, 2)}\n`)
  }
}

function describePhase(phase: RunPhase): string {
  switch (phase.kind) {
    case 'running':
      return `running (${phase.agent})`
    case 'done':
      return `done "${phase.summary}"${phase.tabClosed ? '' : ' (tab remains)'}`
    case 'failed':
    case 'aborted':
      return `${phase.kind} (${phase.reason})`
    default:
      return phase.kind
  }
}

function startupErrorPath(home: string): string {
  return join(stateDir(home), 'startup-error.json')
}

async function reportStartupError(deps: CycleDeps, errors: string[]): Promise<void> {
  const path = startupErrorPath(deps.home)
  const content = `${JSON.stringify(errors)}\n`
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return
  await sendNotice(deps, null, 'orcapod: config broken, cannot start', summarize(errors))
  mkdirSync(stateDir(deps.home), { recursive: true })
  writeFileSync(path, content)
}

async function exitAfterStartupFailure(home: string, code: number, onStartup?: (ok: boolean) => void): Promise<never> {
  releaseDaemonLock(home, process.pid)
  onStartup?.(false)
  await sleep(STARTUP_FAILURE_WAIT_MS)
  return process.exit(code)
}

function summarize(errors: string[]): string {
  return errors.length > 1 ? `${errors[0]} (and ${errors.length - 1} more)` : (errors[0] ?? '')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

