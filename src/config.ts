import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parse } from 'yaml'
import { configPath, promptsDir } from './paths.ts'
import { EACH_ONLY_VARIABLES, placeholdersOf, PROMPT_VARIABLES } from './prompt.ts'
import { ASSOCIATIONS } from './types.ts'
import type { Ai, Association, Config, ConfigResult, Item, Kind, Project, Rule, Settings, Target } from './types.ts'

const AIS: readonly Ai[] = ['claude', 'codex']
const TARGETS: readonly Target[] = ['issue', 'pr']
const BATCHES: readonly Rule['batch'][] = ['each', 'together']
const BOOTSTRAPS: readonly Rule['bootstrap'][] = ['skip', 'process']

const MINUTES_LIMIT = 10080
const CONCURRENCY_LIMIT = 100
const GIT_TIMEOUT_MS = 10_000

const PROJECT_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/
const KIND_ID_PATTERN = /^[A-Za-z0-9_-]+$/
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const GITHUB_REMOTE_PATTERNS = [
  /^git@github\.com(?:\.[A-Za-z0-9_-]+)?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/,
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
]

export const DEFAULT_SETTINGS: Settings = {
  maxConcurrentPerProject: 2,
  launch: { claude: 'claude --dangerously-skip-permissions', codex: 'codex --dangerously-bypass-approvals-and-sandbox' },
  notify: { desktop: true, waitingMinutes: 10, maxRunMinutes: 120, queuedMinutes: 30 },
}
const DEFAULT_AUTHORS: Association[] = ['OWNER', 'MEMBER', 'COLLABORATOR']
const DEFAULT_BOTS = ['dependabot[bot]']

type Errors = string[]
type Fields = Record<string, unknown>
type KnownGhAccounts = readonly string[] | 'unchecked'

export function loadConfig(home: string, env: { ghAccounts: KnownGhAccounts }): ConfigResult {
  try {
    return parseConfig(home, env)
  } catch (error) {
    return { ok: false, errors: [`config.yaml: unexpected exception while loading (${firstLine(messageOf(error))})`], unknownGithubAccounts: [] }
  }
}

function parseConfig(home: string, env: { ghAccounts: KnownGhAccounts }): ConfigResult {
  const errors: Errors = []
  const read = readDocument(errors, configPath(home))
  if (read === null) return { ok: false, errors, unknownGithubAccounts: [] }
  const { document, sha256 } = read

  if (document.version !== 1) errors.push(`version: 1 is required (got: ${show(document.version)})`)
  const settings = readSettings(errors, document.settings)
  const kinds = readKinds(errors, document.kinds)
  const projects = readProjects(errors, document.projects, { kinds, ghAccounts: env.ghAccounts })
  const promptKindIds = kinds.map((kind) => kind.id).filter((id) => KIND_ID_PATTERN.test(id))
  const prompts = readPrompts(errors, home, promptKindIds)
  checkPromptUsage(errors, prompts, projects, promptKindIds)

  if (errors.length > 0) return { ok: false, errors, unknownGithubAccounts: unknownAccountsOf(projects, env.ghAccounts) }
  return { ok: true, config: { settings, kinds, projects, prompts }, sha256 }
}

function unknownAccountsOf(projects: Project[], ghAccounts: KnownGhAccounts): string[] {
  if (ghAccounts === 'unchecked') return []
  return [...new Set(projects.map((project) => project.githubAccount).filter((account) => account !== '' && !ghAccounts.includes(account)))]
}

export function checkProjectPaths(config: Config): string[] {
  return config.projects.flatMap((project, i) => {
    if (!existsSync(project.path)) return [`projects[${i}].path: ${show(project.path)} does not exist`]
    if (!existsSync(join(project.path, '.git'))) return [`projects[${i}].path: ${show(project.path)} has no .git`]
    return []
  })
}

export function ruleKey(project: string, rule: Rule): string {
  return JSON.stringify([project, rule.target, rule.label.trim().toLowerCase()])
}

export function isAllowedAuthor(project: Project, item: Item, rule?: Rule): boolean {
  if (item.repo !== project.repo) return false
  const { login, bot, association } = item.author
  if (login === '') return false
  if (bot) return project.bots.includes(login)
  return project.authors.some((allowed) => allowed === association)
    && (rule?.authors === undefined || rule.authors.some((allowed) => allowed === association))
}

function readDocument(errors: Errors, file: string): { document: Fields; sha256: string } | null {
  let raw: Buffer
  try {
    raw = readFileSync(file)
  } catch (error) {
    errors.push(`config.yaml: cannot read (${firstLine(messageOf(error))})`)
    return null
  }
  const sha256 = createHash('sha256').update(raw).digest('hex')
  let document: unknown
  try {
    document = parse(raw.toString('utf8'))
  } catch (error) {
    errors.push(`config.yaml: not valid YAML (${firstLine(messageOf(error)).replace(/:$/, '')})`)
    return null
  }
  if (!isFields(document)) {
    errors.push(`config.yaml: must be a mapping (got: ${show(document)})`)
    return null
  }
  return { document, sha256 }
}

function readSettings(errors: Errors, value: unknown): Settings {
  const settings = readFields(errors, 'settings', value)
  const launch = readFields(errors, 'settings.launch', settings.launch)
  const notify = readFields(errors, 'settings.notify', settings.notify)
  const minutes = (key: 'waitingMinutes' | 'maxRunMinutes' | 'queuedMinutes') =>
    readInteger(errors, `settings.notify.${key}`, notify[key], { min: 1, max: MINUTES_LIMIT }, DEFAULT_SETTINGS.notify[key])
  return {
    maxConcurrentPerProject: readInteger(errors, 'settings.maxConcurrentPerProject', settings.maxConcurrentPerProject, { min: 1, max: CONCURRENCY_LIMIT }, DEFAULT_SETTINGS.maxConcurrentPerProject),
    launch: {
      claude: readText(errors, 'settings.launch.claude', launch.claude, DEFAULT_SETTINGS.launch.claude),
      codex: readText(errors, 'settings.launch.codex', launch.codex, DEFAULT_SETTINGS.launch.codex),
    },
    notify: {
      desktop: readBoolean(errors, 'settings.notify.desktop', notify.desktop, DEFAULT_SETTINGS.notify.desktop),
      waitingMinutes: minutes('waitingMinutes'),
      maxRunMinutes: minutes('maxRunMinutes'),
      queuedMinutes: minutes('queuedMinutes'),
    },
  }
}

function readKinds(errors: Errors, value: unknown): Kind[] {
  const kinds = readList(errors, 'kinds', value).map((entry, i) => {
    const path = `kinds[${i}]`
    const fields = readFields(errors, path, entry)
    const id = readText(errors, `${path}.id`, fields.id)
    if (id !== '' && !KIND_ID_PATTERN.test(id)) errors.push(`${path}.id: ${show(id)} is not allowed (letters, digits, _ and - only)`)
    return { id, name: readText(errors, `${path}.name`, fields.name) }
  })
  reportDuplicates(errors, kinds.map((kind) => ({ key: kind.id, shown: show(kind.id) })), (i) => `kinds[${i}].id`, (first) => `kinds[${first}]`)
  return kinds
}

function readProjects(errors: Errors, value: unknown, context: { kinds: Kind[]; ghAccounts: KnownGhAccounts }): Project[] {
  const projects = readList(errors, 'projects', value).map((entry, i) => readProject(errors, `projects[${i}]`, entry, context))
  reportDuplicates(errors, projects.map((project) => ({ key: project.name, shown: show(project.name) })), (i) => `projects[${i}].name`, (first) => `projects[${first}]`)
  return projects
}

function readProject(errors: Errors, path: string, value: unknown, context: { kinds: Kind[]; ghAccounts: KnownGhAccounts }): Project {
  const fields = readFields(errors, path, value)

  const name = readText(errors, `${path}.name`, fields.name)
  if (name !== '' && !PROJECT_NAME_PATTERN.test(name)) errors.push(`${path}.name: ${show(name)} is not allowed (letters, digits, _, . and - only)`)

  const projectPath = readText(errors, `${path}.path`, fields.path)
  const hasAbsolutePath = isAbsolute(projectPath)
  if (projectPath !== '' && !hasAbsolutePath) errors.push(`${path}.path: must be an absolute path (got: ${show(projectPath)})`)

  const githubAccount = readText(errors, `${path}.githubAccount`, fields.githubAccount)
  if (githubAccount !== '' && context.ghAccounts !== 'unchecked' && !context.ghAccounts.includes(githubAccount)) {
    errors.push(`${path}.githubAccount: ${show(githubAccount)} is not an account in gh auth status (choices: ${candidates(context.ghAccounts)})`)
  }

  const rules = readList(errors, `${path}.rules`, fields.rules).map((entry, j) => readRule(errors, `${path}.rules[${j}]`, entry, context.kinds))
  if (Array.isArray(fields.rules) && rules.length === 0) errors.push(`${path}.rules: at least 1 rule is required`)
  reportDuplicates(errors, rules.map(ruleIdentity), (j) => `${path}.rules[${j}].label`, (first) => `rules[${first}]`)

  return {
    name,
    path: projectPath,
    repo: readRepo(errors, `${path}.repo`, fields.repo, hasAbsolutePath ? projectPath : null),
    githubAccount,
    enabled: readBoolean(errors, `${path}.enabled`, fields.enabled, true),
    authors: readList(errors, `${path}.authors`, fields.authors, DEFAULT_AUTHORS).map((entry, k) => readChoice(errors, `${path}.authors[${k}]`, entry, ASSOCIATIONS)),
    bots: readList(errors, `${path}.bots`, fields.bots, DEFAULT_BOTS).map((entry, k) => readText(errors, `${path}.bots[${k}]`, entry)),
    rules,
  }
}

function ruleIdentity(rule: Rule): { key: string; shown: string } {
  const label = rule.label.trim().toLowerCase()
  return label === '' ? { key: '', shown: '' } : { key: JSON.stringify([rule.target, label]), shown: `${rule.target} / ${show(label)}` }
}

function readRule(errors: Errors, path: string, value: unknown, kinds: Kind[]): Rule {
  const fields = readFields(errors, path, value)
  const kind = readText(errors, `${path}.kind`, fields.kind)
  const kindIds = kinds.map((k) => k.id)
  if (kind !== '' && !kindIds.includes(kind)) errors.push(`${path}.kind: ${show(kind)} is not in kinds (choices: ${candidates(kindIds)})`)
  return {
    target: readChoice(errors, `${path}.target`, fields.target, TARGETS),
    label: readText(errors, `${path}.label`, fields.label),
    kind,
    ai: readChoice(errors, `${path}.ai`, fields.ai, AIS),
    batch: readChoice(errors, `${path}.batch`, fields.batch, BATCHES),
    delayMinutes: readInteger(errors, `${path}.delayMinutes`, fields.delayMinutes, { min: 0, max: MINUTES_LIMIT }),
    enabled: readBoolean(errors, `${path}.enabled`, fields.enabled, true),
    bootstrap: readChoice(errors, `${path}.bootstrap`, fields.bootstrap, BOOTSTRAPS, 'skip'),
    ...(fields.authors === undefined ? {} : { authors: readList(errors, `${path}.authors`, fields.authors).map((entry, k) => readChoice(errors, `${path}.authors[${k}]`, entry, ASSOCIATIONS)) }),
  }
}

function readRepo(errors: Errors, path: string, value: unknown, projectPath: string | null): string {
  if (value !== undefined) {
    const repo = readText(errors, path, value)
    if (repo !== '' && !REPO_PATTERN.test(repo)) errors.push(`${path}: must be in owner/name form (got: ${show(repo)})`)
    return repo
  }
  if (projectPath === null) return ''
  const derived = deriveRepo(projectPath)
  if (!derived.ok) errors.push(`${path}: cannot derive repo (${derived.reason})`)
  return derived.ok ? derived.repo : ''
}

function deriveRepo(projectPath: string): { ok: true; repo: string } | { ok: false; reason: string } {
  if (!existsSync(projectPath)) return { ok: false, reason: 'path does not exist' }
  let url: string
  try {
    url = execFileSync('git', ['-C', projectPath, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS }).trim()
  } catch (error) {
    return { ok: false, reason: `git remote get-url origin failed: ${firstLine(messageOf(error))}` }
  }
  for (const pattern of GITHUB_REMOTE_PATTERNS) {
    const repo = pattern.exec(url)?.[1]
    if (repo !== undefined) return { ok: true, repo }
  }
  return { ok: false, reason: 'origin is not a GitHub URL' }
}

function readPrompts(errors: Errors, home: string, kindIds: string[]): Map<string, string> {
  const prompts = new Map<string, string>()
  for (const kindId of kindIds) {
    for (const ai of AIS) {
      const key = `${kindId}.${ai}`
      const file = join(promptsDir(home), `${key}.md`)
      if (!existsSync(file)) continue
      try {
        prompts.set(key, readFileSync(file, 'utf8'))
      } catch (error) {
        errors.push(`${promptLabel(key)}: cannot read (${firstLine(messageOf(error))})`)
      }
    }
  }
  return prompts
}

function checkPromptUsage(errors: Errors, prompts: Map<string, string>, projects: Project[], kindIds: string[]): void {
  for (const [key, template] of prompts) {
    for (const name of placeholdersOf(template)) {
      if (!PROMPT_VARIABLES.includes(name)) errors.push(`${promptLabel(key)}: {{${name}}} is an unknown variable (choices: ${candidates(PROMPT_VARIABLES)})`)
    }
  }
  projects.forEach((project, i) => project.rules.forEach((rule, j) => {
    const key = `${rule.kind}.${rule.ai}`
    const template = prompts.get(key)
    if (template === undefined) {
      if (rule.enabled && kindIds.includes(rule.kind)) errors.push(`${promptLabel(key)}: missing (referenced by projects[${i}].rules[${j}])`)
      return
    }
    if (rule.batch !== 'together') return
    for (const name of placeholdersOf(template)) {
      if (EACH_ONLY_VARIABLES.includes(name)) errors.push(`${promptLabel(key)}: {{${name}}} cannot be used in a batch: together rule (${project.name} / ${rule.target} / ${rule.label})`)
    }
  }))
}

function promptLabel(key: string): string {
  return `prompts/${key}.md`
}

function reportDuplicates(errors: Errors, entries: { key: string; shown: string }[], pathOf: (i: number) => string, firstLabel: (first: number) => string): void {
  const firstIndex = new Map<string, number>()
  entries.forEach(({ key, shown }, i) => {
    if (key === '') return
    const first = firstIndex.get(key)
    if (first === undefined) firstIndex.set(key, i)
    else errors.push(`${pathOf(i)}: ${shown} duplicates ${firstLabel(first)}`)
  })
}

function readFields(errors: Errors, path: string, value: unknown): Fields {
  if (value === undefined) return {}
  if (isFields(value)) return value
  errors.push(`${path}: must be a mapping (got: ${show(value)})`)
  return {}
}

function readList(errors: Errors, path: string, value: unknown, fallback?: readonly unknown[]): unknown[] {
  if (value === undefined && fallback !== undefined) return [...fallback]
  if (Array.isArray(value)) return value
  errors.push(value === undefined ? `${path}: required` : `${path}: must be an array (got: ${show(value)})`)
  return []
}

function readText(errors: Errors, path: string, value: unknown, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value === 'string' && value.trim() !== '') return value
  errors.push(value === undefined ? `${path}: required` : `${path}: must be a non-empty string (got: ${show(value)})`)
  return ''
}

function readInteger(errors: Errors, path: string, value: unknown, range: { min: number; max: number }, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max) return value
  errors.push(value === undefined ? `${path}: required` : `${path}: must be an integer from ${range.min} to ${range.max} (got: ${show(value)})`)
  return range.min
}

function readBoolean(errors: Errors, path: string, value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  errors.push(`${path}: must be true or false (got: ${show(value)})`)
  return fallback
}

function readChoice<T extends string>(errors: Errors, path: string, value: unknown, choices: readonly T[], fallback?: T): T {
  if (value === undefined && fallback !== undefined) return fallback
  const choice = choices.find((c) => c === value)
  if (choice !== undefined) return choice
  errors.push(value === undefined ? `${path}: required (choices: ${candidates(choices)})` : `${path}: ${show(value)} is not one of ${candidates(choices)}`)
  return choices[0]
}

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function show(value: unknown): string {
  if (value === undefined) return 'none'
  try {
    return JSON.stringify(value)
  } catch {
    return 'unprintable value (circular reference?)'
  }
}

function candidates(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ')
}

function messageOf(error: unknown): string {
  const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : ''
  if (stderr !== '') return stderr
  return error instanceof Error ? error.message : String(error)
}

function firstLine(text: string): string {
  return text.split('\n')[0]
}
