import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { checkProposal } from './approval.ts'
import { formatIncident } from './incident-contract.ts'
import { checkProjectPaths, loadConfig } from './config.ts'
import { start } from './daemon.ts'
import { formatDoctorLine, runDoctor, systemDoctorDeps } from './doctor.ts'
import { fetchItem, fetchOpenItems, listGhAccounts } from './github.ts'
import { notify } from './notify.ts'
import { monitorText, processTerminal, runMonitor } from './monitor.ts'
import { ensureDaemon } from './up.ts'
import { createOrcaClient } from './orca.ts'
import { orcapodHome, logPath } from './paths.ts'
import { liveDaemonPid, loadState, writeRequest } from './state.ts'
import { formatStatus, resolveRunId } from './status.ts'
import type { Ai, Target } from './types.ts'

interface Command { usage: string; run: (args: string[]) => Promise<number> }

const LOG_TAIL_LINES = '200'
const MONITOR_USAGE = 'orcapod monitor [--interval <seconds>] [--log-lines <N>]'
const MONITOR_INTERVAL_SECONDS = { min: 0.2, max: 60, default: '1' }
const MONITOR_LOG_LINES = { min: 1, max: 10000, default: '200' }

const COMMANDS = new Map<string, Command>([
  ['validate', { usage: 'orcapod validate', run: validate }],
  ['doctor', { usage: 'orcapod doctor [--probe]', run: diagnose }],
  ['status', { usage: 'orcapod status [--json] [--history]', run: showStatus }],
  ['up', { usage: 'orcapod up', run: up }],
  ['start', { usage: 'orcapod start', run: startDaemon }],
  ['run', { usage: 'orcapod run --project <name> (--issue <n> | --pr <n>) --kind <id> [--ai claude|codex] [--now]', run: requestRun }],
  ['stop', { usage: 'orcapod stop [<run.id>]', run: stop }],
  ['rerun', { usage: 'orcapod rerun <run.id>', run: (args) => requestForRun('rerun', args) }],
  ['incident', { usage: 'orcapod incident <run.id>', run: showIncident }],
  ['investigate', { usage: 'orcapod investigate <run.id> [--evidence <text>]', run: investigate }],
  ['approve', { usage: 'orcapod approve <run.id> <revision>', run: approve }],
  ['logs', { usage: 'orcapod logs [-f]', run: showLogs }],
  ['monitor', { usage: MONITOR_USAGE, run: monitor }],
])

async function validate(args: string[]): Promise<number> {
  parseArgs({ args, options: {}, allowPositionals: false })
  const result = loadConfig(orcapodHome(), { ghAccounts: await listGhAccounts() })
  if (!result.ok) return reportErrors(result.errors)
  const pathErrors = checkProjectPaths(result.config)
  if (pathErrors.length > 0) return reportErrors(pathErrors)
  const { projects, prompts } = result.config
  const ruleCount = projects.reduce((sum, project) => sum + project.rules.length, 0)
  console.log(`OK: projects ${projects.length} / rules ${ruleCount} / prompts ${prompts.size}`)
  return 0
}

async function diagnose(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { probe: { type: 'boolean', default: false } }, allowPositionals: false })
  const lines = await runDoctor(systemDoctorDeps(orcapodHome()), { probe: values.probe })
  for (const line of lines) console.log(formatDoctorLine(line))
  return lines.some((line) => line.level === 'NG') ? 1 : 0
}

async function showStatus(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean', default: false }, history: { type: 'boolean', default: false } }, allowPositionals: false })
  const home = orcapodHome()
  const state = loadState(home)
  if (values.json) {
    console.log(JSON.stringify(state, null, 2))
    return 0
  }
  const ghAccounts = await listGhAccounts().catch((error: unknown) => {
    console.error(`warning: cannot read the gh accounts, so the config is not checked (${error instanceof Error ? error.message : String(error)})`)
    return []
  })
  const loaded = loadConfig(home, { ghAccounts })
  console.log(formatStatus({ state, config: loaded.ok ? loaded.config : null, daemonPid: liveDaemonPid(home), now: new Date().toISOString(), history: values.history }))
  return 0
}

async function startDaemon(args: string[]): Promise<number> {
  parseArgs({ args, options: {}, allowPositionals: false })
  return start({ home: orcapodHome(), orca: createOrcaClient(), github: fetchOpenItems, ghAccounts: listGhAccounts, notify, now: () => new Date() }, process.send === undefined ? undefined : (ok) => {
    process.send?.({ type: 'startup', ok })
  })
}

async function up(args: string[]): Promise<number> {
  parseArgs({ args, options: {}, allowPositionals: false })
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    return reportErrors(['Run this in a terminal. Use orcapod start to run in the foreground or orcapod status to see the state'])
  }
  await ensureDaemon(orcapodHome())
  return monitor([])
}

async function stop(args: string[]): Promise<number> {
  if (args.length > 0) return requestForRun('stop', args)
  const pid = liveDaemonPid(orcapodHome())
  if (pid !== null) {
    try {
      process.kill(pid, 'SIGTERM')
      console.log(`asked the daemon to stop (pid ${pid}). It exits when the current cycle finishes`)
      return 0
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  console.log('daemon is not running')
  return 0
}

async function requestRun(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { project: { type: 'string' }, issue: { type: 'string' }, pr: { type: 'string' }, kind: { type: 'string' }, ai: { type: 'string' }, now: { type: 'boolean', default: false } },
    allowPositionals: false,
  })
  const parsed = parseRunArgs(values)
  if (typeof parsed === 'string') return reportErrors([parsed])
  const home = orcapodHome()
  const loaded = loadConfig(home, { ghAccounts: await listGhAccounts() })
  if (!loaded.ok) return reportErrors(loaded.errors)
  const { config } = loaded
  const project = config.projects.find((p) => p.name === parsed.project)
  if (project === undefined) return reportErrors([`--project: ${parsed.project} is not in the config (choices: ${config.projects.map((p) => p.name).join(', ') || 'none'})`])
  if (!config.kinds.some((k) => k.id === parsed.kind)) return reportErrors([`--kind: ${parsed.kind} is not in kinds (choices: ${config.kinds.map((k) => k.id).join(', ') || 'none'})`])
  const ai = parsed.ai ?? project.rules.find((r) => r.enabled && r.kind === parsed.kind)?.ai
  if (ai === undefined) return reportErrors([`--ai: required because ${project.name} has no enabled rule for kind ${parsed.kind}`])
  if (!config.prompts.has(`${parsed.kind}.${ai}`)) return reportErrors([`prompts/${parsed.kind}.${ai}.md is missing`])

  const item = await fetchItem(project, parsed.target, parsed.number)
  const file = writeRequest(home, { type: 'run', project: project.name, item, kind: parsed.kind, ai, now: parsed.now })
  console.log(`request placed: ${file} (${item.target} #${item.number} ${item.title} / ${parsed.kind} / ${ai}${parsed.now ? ' / --now' : ''})`)
  warnIfDaemonStopped(home)
  return 0
}

interface RunArgs { project: string; target: Target; number: number; kind: string; ai: Ai | undefined; now: boolean }

function parseRunArgs(values: { project?: string; issue?: string; pr?: string; kind?: string; ai?: string; now?: boolean }): RunArgs | string {
  if (values.project === undefined) return '--project is required'
  if ((values.issue === undefined) === (values.pr === undefined)) return 'exactly one of --issue or --pr is required'
  const target: Target = values.issue !== undefined ? 'issue' : 'pr'
  const number = values.issue ?? values.pr ?? ''
  if (!/^[1-9]\d*$/.test(number)) return `--${target}: must be a positive integer (got: ${number})`
  if (values.kind === undefined) return '--kind is required'
  if (values.ai !== undefined && values.ai !== 'claude' && values.ai !== 'codex') return `--ai: must be claude or codex (got: ${values.ai})`
  return { project: values.project, target, number: Number(number), kind: values.kind, ai: values.ai, now: values.now ?? false }
}

async function requestForRun(type: 'stop' | 'rerun', args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true })
  if (positionals.length !== 1) return reportErrors([`give exactly one run id (see orcapod status). Usage: orcapod ${type} <run.id>`])
  const home = orcapodHome()
  const resolved = resolveRunId(loadState(home).runs, positionals[0])
  if (!resolved.ok) return reportErrors([resolved.error])
  if (type === 'rerun' && loadState(home).runs.find((run) => run.id === resolved.id)?.recovery !== undefined) return reportErrors(['an incident run cannot be rerun. Check the original run with orcapod incident'])
  const file = writeRequest(home, { type, runId: resolved.id })
  console.log(`request placed: ${file} (${type} ${resolved.id})`)
  warnIfDaemonStopped(home)
  return 0
}

function incidentRun(query: string) {
  const state = loadState(orcapodHome())
  const resolved = resolveRunId(state.runs, query)
  if (!resolved.ok) throw new Error(resolved.error)
  const run = state.runs.find((candidate) => candidate.id === resolved.id)!
  if (run.recovery !== undefined || run.phase.kind !== 'failed') throw new Error('give the original failed run')
  return run
}

async function showIncident(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true })
  if (positionals.length !== 1) throw new Error('give exactly one original run ID')
  console.log(formatIncident(incidentRun(positionals[0])))
  return 0
}

async function investigate(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args, options: { evidence: { type: 'string', default: '' } }, allowPositionals: true })
  if (positionals.length !== 1) throw new Error('give exactly one original run ID')
  const run = incidentRun(positionals[0])
  if (run.incident !== undefined && !['blocked', 'awaiting_approval'].includes(run.incident.status)) throw new Error('cannot start an investigation for an incident that is under investigation, being applied or resolved')
  const evidence = values.evidence.trim()
  if (evidence.length > 16_000) throw new Error('added evidence must be 16000 characters or fewer')
  if (run.incident?.tasks.length && (evidence === '' || run.incident.evidence.includes(evidence))) throw new Error('a new investigation needs added evidence different from the previous one')
  const home = orcapodHome()
  const file = writeRequest(home, { type: 'investigate', runId: run.id, evidence })
  console.log(`investigation request placed: ${file} (the original work is not rerun)`)
  warnIfDaemonStopped(home)
  return 0
}

async function approve(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true })
  if (positionals.length !== 2) throw new Error('give the original run ID and the revision shown by orcapod incident')
  const run = incidentRun(positionals[0])
  const proposal = run.incident?.proposal
  if (run.incident?.status !== 'awaiting_approval' || proposal?.revision !== positionals[1]) throw new Error('does not match the revision awaiting approval')
  const home = orcapodHome()
  const loaded = loadConfig(home, { ghAccounts: await listGhAccounts() })
  if (!loaded.ok) return reportErrors(loaded.errors)
  checkProposal(proposal!, loaded.config, run)
  const file = writeRequest(home, { type: 'approve', runId: run.id, revision: positionals[1] })
  console.log(`approval request placed: ${file} (${positionals[1]})`)
  warnIfDaemonStopped(home)
  return 0
}

async function showLogs(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { follow: { type: 'boolean', short: 'f', default: false } }, allowPositionals: false })
  const path = logPath(orcapodHome())
  if (!existsSync(path)) return reportErrors([`no log: ${path}`])
  const tail = spawn('tail', ['-n', LOG_TAIL_LINES, ...(values.follow ? ['-f'] : []), path], { stdio: 'inherit' })
  return new Promise((resolve, reject) => {
    tail.once('error', reject)
    tail.once('exit', (code) => resolve(code ?? 1))
  })
}

async function monitor(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { interval: { type: 'string', default: MONITOR_INTERVAL_SECONDS.default }, 'log-lines': { type: 'string', default: MONITOR_LOG_LINES.default } },
    allowPositionals: false,
  })
  const intervalSeconds = Number(values.interval)
  if (!(intervalSeconds >= MONITOR_INTERVAL_SECONDS.min && intervalSeconds <= MONITOR_INTERVAL_SECONDS.max)) {
    return reportErrors([`--interval: must be a number of seconds from ${MONITOR_INTERVAL_SECONDS.min} to ${MONITOR_INTERVAL_SECONDS.max} (got: ${values.interval})`, `Usage: ${MONITOR_USAGE}`])
  }
  const logLines = Number(values['log-lines'])
  if (!/^[1-9]\d*$/.test(values['log-lines']) || logLines < MONITOR_LOG_LINES.min || logLines > MONITOR_LOG_LINES.max) {
    return reportErrors([`--log-lines: must be an integer from ${MONITOR_LOG_LINES.min} to ${MONITOR_LOG_LINES.max} (got: ${values['log-lines']})`, `Usage: ${MONITOR_USAGE}`])
  }
  const home = orcapodHome()
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    console.log(monitorText(home, new Date()))
    return 0
  }
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  process.on('SIGINT', abort)
  process.on('SIGTERM', abort)
  try {
    await runMonitor({ home, intervalMs: intervalSeconds * 1000, logLines, terminal: processTerminal(), now: () => new Date(), signal: controller.signal })
  } finally {
    process.off('SIGINT', abort)
    process.off('SIGTERM', abort)
  }
  return 0
}

function warnIfDaemonStopped(home: string): void {
  if (liveDaemonPid(home) === null) console.error('warning: the daemon is not running (orcapod start). It processes the request once started')
}

function reportErrors(errors: string[]): number {
  for (const line of errors) console.error(line)
  return 1
}

function usage(): string {
  return ['Usage:', ...Array.from(COMMANDS.values(), (command) => `  ${command.usage}`)].join('\n')
}

async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv
  const command = name === undefined ? undefined : COMMANDS.get(name)
  if (command === undefined) {
    console.error(usage())
    return 1
  }
  try {
    return await command.run(args)
  } catch (error) {
    console.error(`orcapod ${name}: ${error instanceof Error ? error.message : String(error)}`)
    if (isArgumentError(error)) console.error(`Usage: ${command.usage}`)
    return 1
  }
}

function isArgumentError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS_')
}

process.exitCode = await main(process.argv.slice(2))
