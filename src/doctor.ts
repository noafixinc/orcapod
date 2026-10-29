import { accessSync, constants, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { checkProjectPaths, loadConfig } from './config.ts'
import { fetchRepoIsPrivate, listGhAccounts } from './github.ts'
import { createOrcaClient, OrcaError } from './orca.ts'
import { claudeConfigPath, codexConfigPath } from './paths.ts'
import { ownValue } from './records.ts'
import { liveDaemonPid } from './state.ts'
import type { Ai, ConfigResult, HooksState, OrcaClient, Project } from './types.ts'

const AIS: readonly Ai[] = ['claude', 'codex']
const PROBE_TITLE = 'orcapod probe'
const PROBE_COMMAND = "bash -c 'echo ORCAPOD_PROBE_OK; sleep 2'; exit"
const PROBE_WAIT_MS = 20_000

export type DoctorLevel = 'OK' | 'NG' | 'WARN'
export interface DoctorLine { level: DoctorLevel; text: string }

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string }

export interface DoctorDeps {
  home: string
  orca: OrcaClient
  ghAccounts: () => Promise<string[]>
  isPrivate: (project: Project) => Promise<boolean>
  findCommand: (command: string) => string | null
  readText: (path: string) => string | null
  daemonPid: () => number | null
}

export interface DoctorFacts {
  orca: Outcome<{ running: boolean; version: string | null }>
  hooks: Outcome<{ enabled: boolean; agents: Record<Ai, HooksState> }>
  ghAccounts: Outcome<string[]>
  config: ConfigResult
  pathErrors: string[]
  commands: { ai: Ai; command: string; found: string | null }[]
  registeredPaths: Outcome<string[]>
  isPrivate: Record<string, Outcome<boolean>>
  claudeConfig: string | null
  codexConfig: string | null
  projectClaudeSettings: Record<string, string | null>
  daemonPid: number | null
}

export function systemDoctorDeps(home: string): DoctorDeps {
  return {
    home,
    orca: createOrcaClient(),
    ghAccounts: listGhAccounts,
    isPrivate: fetchRepoIsPrivate,
    findCommand: findOnLaunchPath,
    readText: readTextOrNull,
    daemonPid: () => liveDaemonPid(home),
  }
}

export async function runDoctor(deps: DoctorDeps, options: { probe: boolean }): Promise<DoctorLine[]> {
  const facts = await collectDoctorFacts(deps)
  const lines = judgeDoctor(facts)
  return options.probe ? [...lines, ...(await probe(deps.orca, facts.config))] : lines
}

export function formatDoctorLine(line: DoctorLine): string {
  return `${line.level.padEnd(4)} ${line.text}`
}

async function collectDoctorFacts(deps: DoctorDeps): Promise<DoctorFacts> {
  const ghAccounts = await outcomeOf(deps.ghAccounts())
  const config = loadConfig(deps.home, { ghAccounts: ghAccounts.ok ? ghAccounts.value : [] })
  const projects = enabledProjects(config)
  const [orca, hooks, registeredPaths, privacy] = await Promise.all([
    outcomeOf(deps.orca.status()),
    outcomeOf(deps.orca.hooksStatus()),
    outcomeOf(deps.orca.registeredPaths()),
    Promise.all(projects.map(async (project) => [project.name, await outcomeOf(deps.isPrivate(project))] as const)),
  ])
  return {
    orca,
    hooks,
    ghAccounts,
    config,
    pathErrors: config.ok ? checkProjectPaths(config.config) : [],
    commands: AIS.map((ai) => {
      const command = launchCommandName(config, ai)
      return { ai, command, found: deps.findCommand(command) }
    }),
    registeredPaths,
    isPrivate: Object.fromEntries(privacy),
    claudeConfig: deps.readText(claudeConfigPath()),
    codexConfig: deps.readText(codexConfigPath()),
    projectClaudeSettings: Object.fromEntries(projects.map((project) => [project.name, deps.readText(join(project.path, '.claude', 'settings.json'))])),
    daemonPid: deps.daemonPid(),
  }
}

export function judgeDoctor(facts: DoctorFacts): DoctorLine[] {
  const projects = enabledProjects(facts.config)
  const usedAis = facts.config.ok ? aisUsedBy(projects) : AIS
  return [
    ...orcaLines(facts.orca),
    ...hooksLines(facts.hooks, usedAis),
    ...ghLines(facts.ghAccounts),
    ...facts.commands.map((command) => commandLine(command, usedAis)),
    ...configLines(facts.config, facts.pathErrors),
    ...(facts.config.ok && !facts.registeredPaths.ok ? [ng(`Orca registration: cannot read the list (${facts.registeredPaths.error})`)] : []),
    ...projects.flatMap((project) => projectLines(project, facts)),
    facts.daemonPid === null ? warn('daemon: not running (start it with orcapod start)') : ok(`daemon: running (pid ${facts.daemonPid})`),
  ]
}

async function probe(orca: OrcaClient, config: ConfigResult): Promise<DoctorLine[]> {
  if (!config.ok) return [ng('probe: cannot try because the config is unreadable')]
  const [project] = enabledProjects(config)
  if (project === undefined) return [ng('probe: cannot try because there is no enabled project')]

  let handle: string
  const lines: DoctorLine[] = []
  try {
    const created = await orca.createTerminal({ worktreePath: project.path, title: PROBE_TITLE, command: PROBE_COMMAND })
    handle = created.ref.handle
    lines.push(ok(`probe create: opened a tab in ${project.name} (handle ${handle}, paneKey ${created.ref.paneKey})${created.warning === null ? '' : `. Warning: ${created.warning}`}`))
  } catch (error) {
    return [ng(`probe create: cannot open a tab in ${project.name} (${describeError(error)})`)]
  }
  try {
    const { exited } = await orca.waitExit(handle, PROBE_WAIT_MS)
    lines.push(exited ? ok('probe wait: the command exited') : ng(`probe wait: not exited after ${PROBE_WAIT_MS / 1000}s`))
  } catch (error) {
    lines.push(ng(`probe wait: cannot wait for exit (${describeError(error)})`))
  }
  try {
    const { ptyKilled } = await orca.closeTerminal(handle)
    lines.push(ok(`probe close: closed the tab (ptyKilled: ${ptyKilled})`))
  } catch (error) {
    lines.push(ng(`probe close: cannot close the tab (${describeError(error)})`))
  }
  return lines
}

function orcaLines(orca: DoctorFacts['orca']): DoctorLine[] {
  if (!orca.ok) return [ng(`Orca: not responding (${orca.error})`)]
  if (!orca.value.running) return [ng('Orca: not running (open Orca)')]
  return [ok(`Orca: running (version ${orca.value.version ?? 'unknown'})`)]
}

function hooksLines(hooks: DoctorFacts['hooks'], usedAis: readonly Ai[]): DoctorLine[] {
  if (!hooks.ok) return [ng(`hooks: cannot read the state (${hooks.error})`)]
  if (!hooks.value.enabled) return [ng('hooks: Orca hooks are disabled (orca agent hooks on)')]
  if (usedAis.length === 0) return [ok('hooks: enabled (no AI is used by the rules)')]
  return usedAis.map((ai) => (hooks.value.agents[ai] === 'installed' ? ok(`hooks: ${ai} installed`) : ng(`hooks: ${ai} is ${hooks.value.agents[ai]} (orca agent hooks on)`)))
}

function ghLines(accounts: DoctorFacts['ghAccounts']): DoctorLine[] {
  if (!accounts.ok) return [ng(`gh: cannot read accounts (${accounts.error})`)]
  if (accounts.value.length === 0) return [ng('gh: no logged-in account (gh auth login)')]
  return [ok(`gh: accounts ${accounts.value.join(', ')}`)]
}

function commandLine(command: DoctorFacts['commands'][number], usedAis: readonly Ai[]): DoctorLine {
  if (command.found !== null) return ok(`${command.ai}: ${command.found}`)
  const missing = `${command.ai}: ${command.command} is not on PATH (including ~/.local/bin and /opt/homebrew/bin)`
  return usedAis.includes(command.ai) ? ng(missing) : warn(`${missing}. Not used by the rules`)
}

function configLines(config: ConfigResult, pathErrors: string[]): DoctorLine[] {
  if (!config.ok) return config.errors.map((error) => ng(`config: ${error}`))
  const { projects, prompts } = config.config
  const ruleCount = projects.reduce((sum, project) => sum + project.rules.length, 0)
  return [ok(`config: projects ${projects.length} / rules ${ruleCount} / prompts ${prompts.size}`), ...pathErrors.map((error) => ng(`config: ${error}`))]
}

function projectLines(project: Project, facts: DoctorFacts): DoctorLine[] {
  const accounts = facts.ghAccounts.ok ? facts.ghAccounts.value : []
  const isPrivate = ownValue(facts.isPrivate, project.name)
  return [
    accounts.includes(project.githubAccount) ? ok(`${project.name}: githubAccount ${project.githubAccount} is in gh`) : ng(`${project.name}: githubAccount ${project.githubAccount} is not in gh auth status`),
    ...(facts.registeredPaths.ok
      ? [facts.registeredPaths.value.includes(project.path) ? ok(`${project.name}: registered in Orca`) : ng(`${project.name}: ${project.path} is not registered in Orca (add the folder in Orca)`)]
      : []),
    ...(isPrivate === undefined ? [] : [privacyLine(project, isPrivate)]),
    ...aisUsedBy([project]).flatMap((ai) => trustLines(project, ai, facts)),
  ]
}

function privacyLine(project: Project, isPrivate: Outcome<boolean>): DoctorLine {
  if (!isPrivate.ok) return ng(`${project.name}: cannot read ${project.repo} (${isPrivate.error})`)
  return isPrivate.value ? ok(`${project.name}: ${project.repo} is private`) : warn(`${project.name}: ${project.repo} is a public repository. Writers are limited by authors / bots`)
}

function trustLines(project: Project, ai: Ai, facts: DoctorFacts): DoctorLine[] {
  const untrusted = ng(`${project.name}: folder trust is not accepted in ${ai} (open ${ai} interactively once in ${project.path} and accept it)`)
  if (ai === 'codex') {
    return [codexTrustLevel(facts.codexConfig ?? '', project.path) === 'trusted' ? ok(`${project.name}: folder trust is accepted in codex`) : untrusted]
  }
  const entry = claudeProjectEntry(facts.claudeConfig, project.path)
  const hooksDialog = hasHooks(ownValue(facts.projectClaudeSettings, project.name) ?? null) && entry?.hasTrustDialogHooksAccepted !== true
    ? [warn(`${project.name}: .claude/settings.json has hooks, and hooks trust (hasTrustDialogHooksAccepted) is not accepted. Launch may stop at a second dialog`)]
    : []
  return [entry?.hasTrustDialogAccepted === true ? ok(`${project.name}: folder trust is accepted in claude`) : untrusted, ...hooksDialog]
}

function claudeProjectEntry(claudeConfig: string | null, path: string): Record<string, unknown> | null {
  const projects = recordOf(recordOf(parseJsonOrNull(claudeConfig))?.projects)
  return projects === null ? null : recordOf(ownValue(projects, path))
}

function hasHooks(settings: string | null): boolean {
  const hooks = recordOf(recordOf(parseJsonOrNull(settings))?.hooks)
  return hooks !== null && Object.keys(hooks).length > 0
}

function codexTrustLevel(toml: string, path: string): string | null {
  let inProjectTable = false
  for (const raw of toml.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inProjectTable = projectTableKey(line) === path
      continue
    }
    if (!inProjectTable) continue
    const value = /^trust_level\s*=\s*"([^"]*)"/.exec(line)?.[1]
    if (value !== undefined) return value
  }
  return null
}

function projectTableKey(header: string): string | null {
  const match = /^\[\s*projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]$/.exec(header)
  if (match === null) return null
  return match[2] ?? match[1].replace(/\\(["\\])/g, '$1')
}

function enabledProjects(config: ConfigResult): Project[] {
  return config.ok ? config.config.projects.filter((project) => project.enabled) : []
}

function aisUsedBy(projects: Project[]): Ai[] {
  const used = new Set(projects.flatMap((project) => project.rules.filter((rule) => rule.enabled).map((rule) => rule.ai)))
  return AIS.filter((ai) => used.has(ai))
}

function launchCommandName(config: ConfigResult, ai: Ai): string {
  return config.ok ? config.config.settings.launch[ai].trim().split(/\s+/)[0] : ai
}

function findOnLaunchPath(command: string): string | null {
  const candidates = command.includes('/')
    ? [command]
    : [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', ...(process.env.PATH ?? '').split(delimiter)].filter((dir) => dir !== '').map((dir) => join(dir, command))
  return candidates.find(isExecutable) ?? null
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function parseJsonOrNull(text: string | null): unknown {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

async function outcomeOf<T>(promise: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}

function describeError(error: unknown): string {
  if (error instanceof OrcaError && error.message !== error.code) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

function ok(text: string): DoctorLine {
  return { level: 'OK', text }
}

function ng(text: string): DoctorLine {
  return { level: 'NG', text }
}

function warn(text: string): DoctorLine {
  return { level: 'WARN', text }
}
