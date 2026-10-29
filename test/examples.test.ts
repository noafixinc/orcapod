import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const EXAMPLES = join(REPOSITORY_ROOT, 'examples')
const PLACEHOLDER_ACCOUNT = 'your-github-login'
const COPY_COMMANDS = ['cp -n examples/config.yaml config.yaml', 'mkdir -p prompts', 'cp -n examples/prompts/*.md prompts/']
const EXPECTED_PROMPTS = ['dependabot.claude', 'feature.claude']

let scratch: string
let savedPath: string | undefined

beforeEach(() => {
  savedPath = process.env.PATH
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'orcapod-examples-')))
})

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
  rmSync(scratch, { recursive: true, force: true })
})

function loadWithEmptyPath(home: string) {
  const before = process.env.PATH
  process.env.PATH = ''
  try {
    return loadConfig(home, { ghAccounts: [PLACEHOLDER_ACCOUNT] })
  } finally {
    if (before === undefined) delete process.env.PATH
    else process.env.PATH = before
  }
}

function loaded(home: string) {
  const result = loadWithEmptyPath(home)
  if (!result.ok) throw new Error(`loadConfig failed: ${JSON.stringify(result)}`)
  return result.config
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

// Each README line runs independently, including after cp -n declines a copy.
function runCopyCommands(cwd: string) {
  return COPY_COMMANDS.map((line) => {
    const { status, signal, error, stdout, stderr } = spawnSync('/bin/sh', ['-c', line], { cwd, encoding: 'utf8' })
    return { status, signal, error, stdout, stderr }
  })
}

function copyResults(statuses: number[]) {
  return statuses.map((status) => ({ status, signal: null, error: undefined, stdout: '', stderr: '' }))
}

function promptNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3)).sort()
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function ownerSpecificPatterns(): RegExp[] {
  const origin = spawnSync('git', ['-C', REPOSITORY_ROOT, 'remote', 'get-url', 'origin'], { encoding: 'utf8' })
  const owner = origin.status === 0 ? /[:/]([^/:]+)\/[^/]+$/.exec(origin.stdout.trim())?.[1] : undefined
  return [
    new RegExp(escapeRegExp(homedir())),
    /\/Users\/(?!you\/)[^/\s'"]+/,
    ...(owner === undefined ? [] : [new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(owner)}(?![A-Za-z0-9-])`)]),
  ]
}

function homeWithExamples(): string {
  const home = join(scratch, 'home')
  mkdirSync(home)
  cpSync(EXAMPLES, join(home, 'examples'), { recursive: true })
  return home
}

describe('E1: the examples pass every configuration check, and every shipped prompt is checked', () => {
  it('X1: loading examples with an empty PATH is ok, with 1 project and 2 rules in total', () => {
    const config = loaded(EXAMPLES)
    expect(config.projects).toHaveLength(1)
    expect(config.projects.flatMap((project) => project.rules)).toHaveLength(2)
  })

  it('X2: the set of loaded prompts matches the set of actual files in examples/prompts/ exactly', () => {
    const names = [...loaded(EXAMPLES).prompts.keys()].sort()
    expect(names).toEqual(EXPECTED_PROMPTS)
    expect(names).toEqual(promptNames(join(EXAMPLES, 'prompts')))
  })

  it('X3: every enabled rule in examples/config.yaml has examples/prompts/<kind>.<ai>.md', () => {
    const doc = parse(readFileSync(join(EXAMPLES, 'config.yaml'), 'utf8')) as { projects: { rules: { kind: string; ai: string; enabled?: boolean }[] }[] }
    const rules = doc.projects[0].rules.filter((rule) => rule.enabled !== false)
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) expect(existsSync(join(EXAMPLES, 'prompts', `${rule.kind}.${rule.ai}.md`))).toBe(true)
  })
})

describe('E2: user-specific items match the placeholders exactly and contain no owner-specific values', () => {
  it('X4: name, path, githubAccount, and repo of projects[0] match the placeholders exactly', () => {
    const project = loaded(EXAMPLES).projects[0]
    expect({ name: project.name, path: project.path, githubAccount: project.githubAccount, repo: project.repo }).toEqual({
      name: 'your-project',
      path: '/Users/you/git/your-repo',
      githubAccount: 'your-github-login',
      repo: 'your-org/your-repo',
    })
  })

  it('X5a: no file under examples/ (name and full text) contains owner-specific values (the home of the execution environment, the origin owner, real user paths other than /Users/you)', () => {
    const files = listFiles(EXAMPLES)
    expect(files.length).toBeGreaterThan(0)
    const forbidden = ownerSpecificPatterns()
    expect(forbidden.length).toBeGreaterThanOrEqual(2)
    const hits: string[] = []
    for (const file of files) {
      const rel = relative(EXAMPLES, file)
      const text = `${rel}\n${readFileSync(file, 'utf8')}`
      for (const pattern of forbidden) if (pattern.test(text)) hits.push(`${rel}: ${pattern}`)
    }
    expect(hits).toEqual([])
  })
})

describe('E3: the shipped examples are not ignored', () => {
  function checkIgnore(paths: string[]): { status: number; ignored: string[] } {
    const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: REPOSITORY_ROOT, input: paths.join('\n'), encoding: 'utf8' })
    if (result.error !== undefined) throw new Error(`git check-ignore failed to start: ${result.error.message}`)
    if (result.status !== 0 && result.status !== 1) throw new Error(`git check-ignore failed: status=${result.status} stderr=${result.stderr}`)
    return { status: result.status, ignored: result.stdout.split('\n').filter((line) => line !== '') }
  }

  it('X5: passing every file listed under examples/ to git check-ignore gives exit code 1 and empty output', () => {
    const files = listFiles(EXAMPLES).map((file) => relative(REPOSITORY_ROOT, file))
    expect(files.sort()).toEqual(['examples/config.yaml', 'examples/prompts/dependabot.claude.md', 'examples/prompts/feature.claude.md'])
    expect(checkIgnore(files)).toEqual({ status: 1, ignored: [] })
  })

  it('X5b: checkIgnore throws an exception when git check-ignore terminates abnormally (exit code 128)', () => {
    const before = process.env.GIT_CONFIG_COUNT
    process.env.GIT_CONFIG_COUNT = '1'
    try {
      expect(() => checkIgnore(['examples/config.yaml'])).toThrow(/status=128/)
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_COUNT
      else process.env.GIT_CONFIG_COUNT = before
    }
  })
})

describe('E4: a home made with the README copy commands also passes the checks, and re-running does not overwrite', () => {
  it.each([
    ['README.md', '## Install'],
    ['README.ja.md', '## \u5c0e\u5165'],
  ])('X6: in %s, the code block of the "%s" section contains COPY_COMMANDS as 3 consecutive lines', (file, heading) => {
    const readme = readFileSync(join(REPOSITORY_ROOT, file), 'utf8')
    const start = readme.indexOf(`\n${heading}\n`)
    expect(start).toBeGreaterThanOrEqual(0)
    const rest = readme.slice(start + 1)
    const next = rest.indexOf('\n## ', 1)
    const section = next === -1 ? rest : rest.slice(0, next)
    const blocks = [...section.matchAll(/```[^\n]*\n([\s\S]*?)\n```/g)].map((m) => m[1])
    expect(blocks.some((block) => block.includes(COPY_COMMANDS.join('\n')))).toBe(true)
  })

  it('X7: running COPY_COMMANDS on a home without the copy destination passes the checks and creates no prompts/prompts', () => {
    const home = homeWithExamples()
    expect(runCopyCommands(home)).toEqual(copyResults([0, 0, 0]))
    expect([...loaded(home).prompts.keys()].sort()).toEqual(EXPECTED_PROMPTS)
    expect(existsSync(join(home, 'prompts', 'prompts'))).toBe(false)
  })

  it('X8: running COPY_COMMANDS on a home with an empty prompts/ gives the same result as X7', () => {
    const home = homeWithExamples()
    mkdirSync(join(home, 'prompts'))
    expect(runCopyCommands(home)).toEqual(copyResults([0, 0, 0]))
    expect([...loaded(home).prompts.keys()].sort()).toEqual(EXPECTED_PROMPTS)
    expect(existsSync(join(home, 'prompts', 'prompts'))).toBe(false)
  })

  it('X9: a rewritten config.yaml and prompts are not overwritten when COPY_COMMANDS is re-run', () => {
    const home = homeWithExamples()
    expect(runCopyCommands(home)).toEqual(copyResults([0, 0, 0]))
    const configFile = join(home, 'config.yaml')
    const promptFile = join(home, 'prompts', 'feature.claude.md')
    const editedConfig = readFileSync(configFile, 'utf8').replace('your-project', 'edited-project')
    expect(editedConfig).toContain('edited-project')
    const editedPrompt = `${readFileSync(promptFile, 'utf8')}\n- edited`
    writeFileSync(configFile, editedConfig)
    writeFileSync(promptFile, editedPrompt)
    expect(runCopyCommands(home)).toEqual(copyResults([1, 0, 1]))
    expect(readFileSync(configFile, 'utf8')).toBe(editedConfig)
    expect(readFileSync(promptFile, 'utf8')).toBe(editedPrompt)
  })

  it('X10: on re-run, even if the cp on line 1 exits non-zero, line 3 runs and the missing prompts are filled in', () => {
    const home = homeWithExamples()
    expect(runCopyCommands(home)).toEqual(copyResults([0, 0, 0]))
    const missing = join(home, 'prompts', 'dependabot.claude.md')
    rmSync(missing)
    const existingConfig = `${readFileSync(join(home, 'config.yaml'), 'utf8')}\n# locally edited\n`
    const existingPrompt = `${readFileSync(join(home, 'prompts', 'feature.claude.md'), 'utf8')}\n- local instruction\n`
    writeFileSync(join(home, 'config.yaml'), existingConfig)
    writeFileSync(join(home, 'prompts', 'feature.claude.md'), existingPrompt)
    expect(runCopyCommands(home)).toEqual(copyResults([1, 0, 1]))
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(existingConfig)
    expect(readFileSync(join(home, 'prompts', 'feature.claude.md'), 'utf8')).toBe(existingPrompt)
    expect(readFileSync(missing, 'utf8')).toBe(readFileSync(join(EXAMPLES, 'prompts', 'dependabot.claude.md'), 'utf8'))
  })
})
