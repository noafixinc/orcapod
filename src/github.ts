import { execFile } from 'node:child_process'
import type { ExecFileException } from 'node:child_process'
import { ASSOCIATIONS } from './types.ts'
import type { Item, ObservedAssociation, Project, Target } from './types.ts'

const MAX_BUFFER = 64 * 1024 * 1024
const GH_TIMEOUT_MS = 60_000

// Common to the 4 forms gh auth status prints (Logged in / Failed to log in / Timeout trying to log in / Refresh token for … was rejected): https://github.com/cli/cli/blob/trunk/pkg/cmd/auth/status/status.go
const GH_ACCOUNT_LINE = /github\.com account (\S+)/g

interface GhOutput { error: ExecFileException | null; stdout: string; stderr: string }

function gh(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<GhOutput> {
  return new Promise((resolve) => {
    execFile('gh', args, { env, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: GH_TIMEOUT_MS }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr })
    })
  })
}

function failureOf(error: ExecFileException, stderr: string): string {
  if (error.killed === true && typeof error.code !== 'string') return `stopped after ${GH_TIMEOUT_MS / 1000}s without finishing`
  return stderr.trim() || error.message
}

async function ghStdout(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const out = await gh(args, env)
  if (out.error) throw new Error(`gh ${args.join(' ')} failed: ${failureOf(out.error, out.stderr)}`)
  return out.stdout
}

async function tokenEnv(project: Project): Promise<NodeJS.ProcessEnv> {
  const token = (await ghStdout(['auth', 'token', '-u', project.githubAccount, '-h', 'github.com'])).trim()
  if (token === '') throw new Error(`gh auth token returned an empty token (account: ${project.githubAccount})`)
  return { ...process.env, GH_TOKEN: token }
}

function parseJson(stdout: string, endpoint: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`gh api ${endpoint} response is not JSON`)
  }
}

export async function fetchOpenItems(project: Project): Promise<Item[]> {
  const env = await tokenEnv(project)
  const endpoint = `repos/${project.repo}/issues?state=open&per_page=100`
  const stdout = await ghStdout(['api', '--paginate', '--slurp', endpoint], env)
  return parseIssues(parseJson(stdout, endpoint), project.name, project.repo)
}

export async function fetchItem(project: Project, target: Target, number: number): Promise<Item> {
  const env = await tokenEnv(project)
  const endpoint = `repos/${project.repo}/issues/${number}`
  const stdout = await ghStdout(['api', endpoint], env)
  const [item] = parseIssues([[parseJson(stdout, endpoint)]], project.name, project.repo)
  if (item === undefined) throw new Error(`cannot read ${project.repo}#${number}`)
  if (item.target !== target) throw new Error(`${project.repo}#${number} is not ${target === 'pr' ? 'a PR' : 'an issue'}`)
  return item
}

export async function fetchRepoIsPrivate(project: Project): Promise<boolean> {
  const env = await tokenEnv(project)
  const endpoint = `repos/${project.repo}`
  const repo = parseJson(await ghStdout(['api', endpoint], env), endpoint)
  if (!isRecord(repo) || typeof repo.private !== 'boolean') throw new Error(`gh api ${endpoint} response has no private field`)
  return repo.private
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return []
  return labels
    .map((label) => (isRecord(label) ? label.name : label))
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '')
}

function observedAssociation(value: unknown): ObservedAssociation {
  return ASSOCIATIONS.find((association) => association === value) ?? 'UNKNOWN'
}

function parseIssue(raw: unknown, project: string, repo: string): Item | null {
  if (!isRecord(raw)) return null
  const { number } = raw
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null
  return {
    project,
    repo,
    target: raw.pull_request === undefined || raw.pull_request === null ? 'issue' : 'pr',
    number,
    title: stringOr(raw.title, ''),
    url: stringOr(raw.html_url, ''),
    labels: labelNames(raw.labels),
    author: authorOf(raw),
  }
}

function authorOf(raw: Record<string, unknown>): Item['author'] {
  const user = isRecord(raw.user) ? raw.user : null
  const login = stringOr(user?.login, '')
  const identified = login !== '' && typeof user?.type === 'string'
  return {
    login,
    bot: user?.type === 'Bot',
    association: identified ? observedAssociation(raw.author_association) : 'UNKNOWN',
  }
}

export function parseIssues(json: unknown, project: string, repo: string): Item[] {
  if (!Array.isArray(json) || !json.every(Array.isArray)) throw new Error(`${repo} issues response is not an array of pages`)
  return json.flat().flatMap((raw: unknown) => parseIssue(raw, project, repo) ?? [])
}

export async function listGhAccounts(): Promise<string[]> {
  const out = await gh(['auth', 'status'])
  if (out.error && typeof out.error.code !== 'number') throw new Error(`cannot run gh auth status: ${failureOf(out.error, '')}`)
  const names = [...`${out.stdout}\n${out.stderr}`.matchAll(GH_ACCOUNT_LINE)].map((match) => match[1])
  return [...new Set(names)]
}
