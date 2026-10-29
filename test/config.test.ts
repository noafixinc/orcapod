import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { checkProjectPaths, isAllowedAuthor, loadConfig, ruleKey } from '../src/config.ts'
import type { Config, Item, Project, Rule } from '../src/types.ts'

type Fields = Record<string, unknown>
interface Doc { [key: string]: unknown; kinds: Fields[]; projects: (Fields & { rules: Fields[] })[] }

const GH = { ghAccounts: ['acme-developer', 'taylor'] }

const FEATURE_PROMPT = 'Implement issue #{{item.number}} "{{item.title}}" of {{repo}}.\n{{item.url}}\n'
const DEPENDABOT_PROMPT = 'Handle {{items.count}} dependabot PRs of {{repo}}.\n\n{{items}}\n'
const BASE_PROMPTS: Record<string, string> = { 'feature.claude': FEATURE_PROMPT, 'dependabot.claude': DEPENDABOT_PROMPT }

const ALL_ASSOCIATIONS = 'OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, FIRST_TIMER, FIRST_TIME_CONTRIBUTOR, MANNEQUIN, NONE'
const ALL_VARIABLES = 'project.name, project.path, repo, kind.name, items, items.count, run.id, result.path, item.number, item.title, item.url, item.target'

function baseDoc(): Doc {
  return {
    version: 1,
    kinds: [
      { id: 'feature', name: 'Feature' },
      { id: 'dependabot', name: 'Dependabot update' },
    ],
    projects: [
      {
        name: 'todos',
        path: '/Users/alice/git/todos',
        repo: 'alice/todos',
        githubAccount: 'acme-developer',
        rules: [
          { target: 'issue', label: 'impl', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 5 },
          { target: 'pr', label: 'dependencies', kind: 'dependabot', ai: 'claude', batch: 'together', delayMinutes: 30 },
        ],
      },
    ],
  }
}

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function setup(config: Doc | string, prompts: Record<string, string> = BASE_PROMPTS): string {
  const home = tempDir('orcapod-config-')
  writeFileSync(join(home, 'config.yaml'), typeof config === 'string' ? config : stringify(config))
  mkdirSync(join(home, 'prompts'))
  for (const [key, text] of Object.entries(prompts)) writeFileSync(join(home, 'prompts', `${key}.md`), text)
  return home
}

function errorsOf(home: string): string[] {
  const result = loadConfig(home, GH)
  return result.ok ? [] : result.errors
}

function configOf(home: string): Config {
  const result = loadConfig(home, GH)
  if (!result.ok) throw new Error(result.errors.join('\n'))
  return result.config
}

function withDoc(mutate: (doc: Doc) => void): Doc {
  const doc = baseDoc()
  mutate(doc)
  return doc
}

function gitRepo(origin: string | null): string {
  const dir = tempDir('orcapod-repo-')
  execFileSync('git', ['init', '-q', dir])
  if (origin !== null) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin])
  return dir
}

function derivedRepo(projectPath: string): { repo: string } | { errors: string[] } {
  const home = setup(withDoc((doc) => {
    doc.projects[0].path = projectPath
    delete doc.projects[0].repo
  }))
  const result = loadConfig(home, GH)
  return result.ok ? { repo: result.config.projects[0].repo } : { errors: result.errors }
}

describe('loadConfig: valid configuration', () => {
  it('per-rule authors distinguishes omitted from an empty array', () => {
    const project = configOf(setup(withDoc((doc) => { doc.projects[0].rules[1].authors = [] }))).projects[0]
    expect(project.rules[0].authors).toBeUndefined()
    expect(project.rules[1].authors).toEqual([])
  })

  it('fills defaults and reads every existing prompt when ok: true', () => {
    const home = setup(baseDoc(), { ...BASE_PROMPTS, 'feature.codex': '{{repo}}' })
    expect(loadConfig(home, GH)).toEqual({
      ok: true,
      config: {
        settings: {
          maxConcurrentPerProject: 2,
          launch: { claude: 'claude --dangerously-skip-permissions', codex: 'codex --dangerously-bypass-approvals-and-sandbox' },
          notify: { desktop: true, waitingMinutes: 10, maxRunMinutes: 120, queuedMinutes: 30 },
        },
        kinds: [
          { id: 'feature', name: 'Feature' },
          { id: 'dependabot', name: 'Dependabot update' },
        ],
        projects: [
          {
            name: 'todos',
            path: '/Users/alice/git/todos',
            repo: 'alice/todos',
            githubAccount: 'acme-developer',
            enabled: true,
            authors: ['OWNER', 'MEMBER', 'COLLABORATOR'],
            bots: ['dependabot[bot]'],
            rules: [
              { target: 'issue', label: 'impl', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 5, enabled: true, bootstrap: 'skip' },
              { target: 'pr', label: 'dependencies', kind: 'dependabot', ai: 'claude', batch: 'together', delayMinutes: 30, enabled: true, bootstrap: 'skip' },
            ],
          },
        ],
        prompts: new Map([
          ['feature.claude', FEATURE_PROMPT],
          ['feature.codex', '{{repo}}'],
          ['dependabot.claude', DEPENDABOT_PROMPT],
        ]),
      },
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
  })

  it('A32: the sha256 of ok is the sha256 (hex) of the raw bytes of config.yaml', () => {
    const home = setup('version: 1\nkinds:\n  - id: feature\n    name: Feature\nprojects: []\n')
    const result = loadConfig(home, GH)
    expect(result.ok ? result.sha256 : result.errors).toBe('aba9156bd6c5884da3cabbbf0170172d1f3d9ff600fd8dc447bae74ea158bad3')
  })

  it('A32: two configurations differing only in 0x80 versus 0x81 inside quotes are both ok with the same content, and their sha256 values differ', () => {
    const withByte = (byte: number): string => {
      const home = setup('')
      writeFileSync(join(home, 'config.yaml'), Buffer.concat([Buffer.from('version: 1\nkinds:\n  - id: feature\n    name: "a'), Buffer.from([byte]), Buffer.from('"\nprojects: []\n')]))
      return home
    }
    const a = loadConfig(withByte(0x80), GH)
    const b = loadConfig(withByte(0x81), GH)
    if (!a.ok || !b.ok) throw new Error('both should be ok')
    expect(a.config.kinds).toEqual([{ id: 'feature', name: 'a�' }])
    expect(b.config).toEqual(a.config)
    expect(a.sha256).not.toBe(b.sha256)
  })

  it('partially specified settings fill the rest with defaults', () => {
    const home = setup(withDoc((doc) => {
      doc.settings = { maxConcurrentPerProject: 1, launch: { codex: 'codex' }, notify: { desktop: false, waitingMinutes: 15 } }
    }))
    expect(configOf(home).settings).toEqual({
      maxConcurrentPerProject: 1,
      launch: { claude: 'claude --dangerously-skip-permissions', codex: 'codex' },
      notify: { desktop: false, waitingMinutes: 15, maxRunMinutes: 120, queuedMinutes: 30 },
    })
  })

  it('uses written values as they are and keeps the label exactly as written', () => {
    const home = setup(withDoc((doc) => {
      Object.assign(doc.projects[0], { enabled: false, authors: [], bots: [] })
      Object.assign(doc.projects[0].rules[0], { label: ' Impl ', enabled: false, bootstrap: 'process', delayMinutes: 0 })
    }))
    const project = configOf(home).projects[0]
    expect({ enabled: project.enabled, authors: project.authors, bots: project.bots, rule: project.rules[0] }).toEqual({
      enabled: false,
      authors: [],
      bots: [],
      rule: { target: 'issue', label: ' Impl ', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 0, enabled: false, bootstrap: 'process' },
    })
  })

  it.each([
    ['maxConcurrentPerProject 1', (doc: Doc) => { doc.settings = { maxConcurrentPerProject: 1 } }],
    ['maxConcurrentPerProject 100', (doc: Doc) => { doc.settings = { maxConcurrentPerProject: 100 } }],
    ['notify minutes 10080', (doc: Doc) => { doc.settings = { notify: { waitingMinutes: 10080, maxRunMinutes: 10080, queuedMinutes: 1 } } }],
    ['delayMinutes 0', (doc: Doc) => { doc.projects[0].rules[0].delayMinutes = 0 }],
    ['delayMinutes 10080', (doc: Doc) => { doc.projects[0].rules[0].delayMinutes = 10080 }],
    ['the same label with a different target is a different rule', (doc: Doc) => { Object.assign(doc.projects[0].rules[1], { label: 'impl' }) }],
    ['a different project can use the same (target, label)', (doc: Doc) => { doc.projects.push({ ...structuredClone(doc.projects[0]), name: 'todos-2' }) }],
    ['name containing . _ -', (doc: Doc) => { doc.projects[0].name = 'my_app.v2-x' }],
    ['the prompt referenced by a disabled rule may be missing', (doc: Doc) => { Object.assign(doc.projects[0].rules[0], { kind: 'dependabot', ai: 'codex', enabled: false }) }],
    ['authors with every association', (doc: Doc) => { doc.projects[0].authors = ALL_ASSOCIATIONS.split(', ') }],
  ])('boundary value %s is accepted', (_name, mutate) => {
    expect(errorsOf(setup(withDoc(mutate)))).toEqual([])
  })
})

describe('loadConfig: breaking validation rules one at a time', () => {
  it.each<[string, (doc: Doc) => void, string[]]>([
    ['version is 2', (doc) => { doc.version = 2 }, ['version: 1 is required (got: 2)']],
    ['version is missing', (doc) => { delete doc.version }, ['version: 1 is required (got: none)']],
    ['settings is an array', (doc) => { doc.settings = [] }, ['settings: must be a mapping (got: [])']],
    ['maxConcurrentPerProject 0', (doc) => { doc.settings = { maxConcurrentPerProject: 0 } }, ['settings.maxConcurrentPerProject: must be an integer from 1 to 100 (got: 0)']],
    ['maxConcurrentPerProject 101', (doc) => { doc.settings = { maxConcurrentPerProject: 101 } }, ['settings.maxConcurrentPerProject: must be an integer from 1 to 100 (got: 101)']],
    ['maxConcurrentPerProject 1.5', (doc) => { doc.settings = { maxConcurrentPerProject: 1.5 } }, ['settings.maxConcurrentPerProject: must be an integer from 1 to 100 (got: 1.5)']],
    ['maxConcurrentPerProject is a string', (doc) => { doc.settings = { maxConcurrentPerProject: '2' } }, ['settings.maxConcurrentPerProject: must be an integer from 1 to 100 (got: "2")']],
    ['launch.claude is an empty string', (doc) => { doc.settings = { launch: { claude: '' } } }, ['settings.launch.claude: must be a non-empty string (got: "")']],
    ['launch.codex is a number', (doc) => { doc.settings = { launch: { codex: 1 } } }, ['settings.launch.codex: must be a non-empty string (got: 1)']],
    ['notify.desktop is a string', (doc) => { doc.settings = { notify: { desktop: 'yes' } } }, ['settings.notify.desktop: must be true or false (got: "yes")']],
    ['notify minutes are 0 and 10081', (doc) => { doc.settings = { notify: { waitingMinutes: 0, maxRunMinutes: 10081, queuedMinutes: -1 } } }, [
      'settings.notify.waitingMinutes: must be an integer from 1 to 10080 (got: 0)',
      'settings.notify.maxRunMinutes: must be an integer from 1 to 10080 (got: 10081)',
      'settings.notify.queuedMinutes: must be an integer from 1 to 10080 (got: -1)',
    ]],
    ['duplicate kinds id', (doc) => { doc.kinds.push({ id: 'feature', name: 'Another name' }) }, ['kinds[2].id: "feature" duplicates kinds[0]']],
    ['kinds id contains .', (doc) => { doc.kinds.push({ id: 'a.b', name: 'x' }) }, ['kinds[2].id: "a.b" is not allowed (letters, digits, _ and - only)']],
    ['kinds name is missing', (doc) => { delete doc.kinds[0].name }, ['kinds[0].name: required']],
    ['kinds is not an array', (doc) => { doc.kinds = 'feature' as unknown as Fields[] }, [
      'kinds: must be an array (got: "feature")',
      'projects[0].rules[0].kind: "feature" is not in kinds (choices: none)',
      'projects[0].rules[1].kind: "dependabot" is not in kinds (choices: none)',
    ]],
    ['projects is missing', (doc) => { delete (doc as Fields).projects }, ['projects: required']],
    ['C36: name contains /', (doc) => { doc.projects[0].name = 'a/b' }, ['projects[0].name: "a/b" is not allowed (letters, digits, _, . and - only)']],
    ['name contains "', (doc) => { doc.projects[0].name = 'a"b' }, ['projects[0].name: "a\\"b" is not allowed (letters, digits, _, . and - only)']],
    ['duplicate name', (doc) => { doc.projects.push(structuredClone(doc.projects[0])) }, ['projects[1].name: "todos" duplicates projects[0]']],
    ['path is a relative path', (doc) => { doc.projects[0].path = 'git/todos' }, ['projects[0].path: must be an absolute path (got: "git/todos")']],
    ['path is missing', (doc) => { delete doc.projects[0].path }, ['projects[0].path: required']],
    ['repo is not in owner/name form', (doc) => { doc.projects[0].repo = 'todos' }, ['projects[0].repo: must be in owner/name form (got: "todos")']],
    ['githubAccount is not in gh', (doc) => { doc.projects[0].githubAccount = 'nobody' }, ['projects[0].githubAccount: "nobody" is not an account in gh auth status (choices: acme-developer, taylor)']],
    ['enabled is a string', (doc) => { doc.projects[0].enabled = 'no' }, ['projects[0].enabled: must be true or false (got: "no")']],
    ['C44: authors contains lowercase owner', (doc) => { doc.projects[0].authors = ['owner'] }, [`projects[0].authors[0]: "owner" is not one of ${ALL_ASSOCIATIONS}`]],
    ['C44: authors contains UNKNOWN', (doc) => { doc.projects[0].authors = ['OWNER', 'UNKNOWN'] }, [`projects[0].authors[1]: "UNKNOWN" is not one of ${ALL_ASSOCIATIONS}`]],
    ['rule authors is a string', (doc) => { doc.projects[0].rules[0].authors = 'OWNER' }, ['projects[0].rules[0].authors: must be an array (got: "OWNER")']],
    ['rule authors contains an unknown value', (doc) => { doc.projects[0].rules[0].authors = ['UNKNOWN'] }, [`projects[0].rules[0].authors[0]: "UNKNOWN" is not one of ${ALL_ASSOCIATIONS}`]],
    ['C44: bots is not an array', (doc) => { doc.projects[0].bots = 'dependabot[bot]' }, ['projects[0].bots: must be an array (got: "dependabot[bot]")']],
    ['bots contains an empty string', (doc) => { doc.projects[0].bots = [''] }, ['projects[0].bots[0]: must be a non-empty string (got: "")']],
    ['rules is empty', (doc) => { doc.projects[0].rules = [] }, ['projects[0].rules: at least 1 rule is required']],
    ['rules is missing', (doc) => { delete (doc.projects[0] as Fields).rules }, ['projects[0].rules: required']],
    ['target is issues', (doc) => { doc.projects[0].rules[0].target = 'issues' }, ['projects[0].rules[0].target: "issues" is not one of issue, pr']],
    ['target is missing', (doc) => { delete doc.projects[0].rules[0].target }, ['projects[0].rules[0].target: required (choices: issue, pr)']],
    ['label is whitespace only', (doc) => { doc.projects[0].rules[0].label = '  ' }, ['projects[0].rules[0].label: must be a non-empty string (got: "  ")']],
    ['(target, label) duplicated apart from case and whitespace', (doc) => { Object.assign(doc.projects[0].rules[1], { target: 'issue', label: ' IMPL ' }) }, ['projects[0].rules[1].label: issue / "impl" duplicates rules[0]']],
    ['kind is not in kinds', (doc) => { doc.projects[0].rules[1].kind = 'featur' }, ['projects[0].rules[1].kind: "featur" is not in kinds (choices: feature, dependabot)']],
    ['ai is gpt', (doc) => { doc.projects[0].rules[0].ai = 'gpt' }, ['projects[0].rules[0].ai: "gpt" is not one of claude, codex']],
    ['batch is all', (doc) => { doc.projects[0].rules[0].batch = 'all' }, ['projects[0].rules[0].batch: "all" is not one of each, together']],
    ['C36: delayMinutes 10081', (doc) => { doc.projects[0].rules[0].delayMinutes = 10081 }, ['projects[0].rules[0].delayMinutes: must be an integer from 0 to 10080 (got: 10081)']],
    ['delayMinutes -1', (doc) => { doc.projects[0].rules[0].delayMinutes = -1 }, ['projects[0].rules[0].delayMinutes: must be an integer from 0 to 10080 (got: -1)']],
    ['delayMinutes 1.5', (doc) => { doc.projects[0].rules[0].delayMinutes = 1.5 }, ['projects[0].rules[0].delayMinutes: must be an integer from 0 to 10080 (got: 1.5)']],
    ['delayMinutes is missing', (doc) => { delete doc.projects[0].rules[0].delayMinutes }, ['projects[0].rules[0].delayMinutes: required']],
    ['rule enabled is a string', (doc) => { doc.projects[0].rules[0].enabled = 'yes' }, ['projects[0].rules[0].enabled: must be true or false (got: "yes")']],
    ['bootstrap is always', (doc) => { doc.projects[0].rules[0].bootstrap = 'always' }, ['projects[0].rules[0].bootstrap: "always" is not one of skip, process']],
    ['the prompt referenced by an enabled rule is missing', (doc) => { doc.projects[0].rules[0].ai = 'codex' }, ['prompts/feature.codex.md: missing (referenced by projects[0].rules[0])']],
    ['collects all violations', (doc) => {
      doc.version = 2
      doc.projects[0].rules[1].kind = 'featur'
      doc.projects[0].rules[0].delayMinutes = 10081
    }, [
      'version: 1 is required (got: 2)',
      'projects[0].rules[0].delayMinutes: must be an integer from 0 to 10080 (got: 10081)',
      'projects[0].rules[1].kind: "featur" is not in kinds (choices: feature, dependabot)',
    ]],
  ])('%s', (_name, mutate, expected) => {
    expect(errorsOf(setup(withDoc(mutate)))).toEqual(expected)
  })
})

describe('loadConfig: config.yaml itself', () => {
  it('file is missing', () => {
    const home = tempDir('orcapod-config-')
    expect(errorsOf(home)).toEqual([`config.yaml: cannot read (ENOENT: no such file or directory, open '${home}/config.yaml')`])
  })

  it('a YAML syntax error is reduced to one line', () => {
    expect(errorsOf(setup('version: 1\nkinds: [a\n'))).toEqual(['config.yaml: not valid YAML (Flow sequence in block collection must be sufficiently indented and end with a ] at line 3, column 1)'])
  })

  it('a duplicate key is a YAML error', () => {
    expect(errorsOf(setup('version: 1\nversion: 1\n'))).toEqual(['config.yaml: not valid YAML (Map keys must be unique at line 2, column 1)'])
  })

  it('empty file', () => {
    expect(errorsOf(setup(''))).toEqual(['config.yaml: must be a mapping (got: null)'])
  })

  it('X1-4: a YAML with a circular reference (version: &v [*v]) returns an error line without throwing', () => {
    const home = setup('version: &v [*v]\nkinds: []\nprojects: []\n')
    expect(loadConfig(home, GH)).toEqual({ ok: false, errors: ['version: 1 is required (got: unprintable value (circular reference?))'], unknownGithubAccounts: [] })
  })

  it('X1-4: does not throw for fields that show a circular-reference value in errors (settings / rules elements)', () => {
    const home = setup(withDoc((doc) => { doc.version = 1 }))
    writeFileSync(join(home, 'config.yaml'), `${stringify(baseDoc())}settings: &s\n  maxConcurrentPerProject: [*s]\n`)
    expect(errorsOf(home)).toEqual(['settings.maxConcurrentPerProject: must be an integer from 1 to 100 (got: unprintable value (circular reference?))'])
  })
})

describe('loadConfig: githubAccount mismatch', () => {
  it('returns githubAccount values missing from gh in unknownGithubAccounts without duplicates (a cue for the daemon to reload accounts)', () => {
    const home = setup(withDoc((doc) => {
      doc.projects[0].githubAccount = 'newcomer'
      doc.projects.push({ ...structuredClone(doc.projects[0]), name: 'other' })
    }))
    const result = loadConfig(home, GH)
    expect(result.ok ? null : result.unknownGithubAccounts).toEqual(['newcomer'])
    expect(loadConfig(home, { ghAccounts: ['newcomer'] }).ok).toBe(true)
  })

  it('A52: with empty ghAccounts, a project that specifies githubAccount is still ok: false', () => {
    const result = loadConfig(setup(baseDoc()), { ghAccounts: [] })
    expect(result).toEqual({ ok: false, errors: ['projects[0].githubAccount: "acme-developer" is not an account in gh auth status (choices: none)'], unknownGithubAccounts: ['acme-developer'] })
  })

  it("ghAccounts: 'unchecked' skips account validation, is ok even for a githubAccount missing from gh, and does not rely on a substring match of the string 'unchecked'", () => {
    const home = setup(withDoc((doc) => {
      doc.projects[0].githubAccount = 'newcomer'
      doc.projects.push({ ...structuredClone(doc.projects[0]), name: 'other', githubAccount: 'check' })
    }))
    const result = loadConfig(home, { ghAccounts: 'unchecked' })
    expect(result.ok ? result.config.projects.map((p) => p.githubAccount) : result.errors).toEqual(['newcomer', 'check'])
  })

  it("ghAccounts: 'unchecked' with other fields broken leaves unknownGithubAccounts empty", () => {
    const home = setup(withDoc((doc) => {
      doc.projects[0].githubAccount = 'newcomer'
      doc.version = 2
    }))
    expect(loadConfig(home, { ghAccounts: 'unchecked' })).toEqual({ ok: false, errors: ['version: 1 is required (got: 2)'], unknownGithubAccounts: [] })
  })
})

describe('loadConfig: prompts', () => {
  it('C26: an error when the prompt of a together rule contains {{ item.number }}', () => {
    const home = setup(baseDoc(), { ...BASE_PROMPTS, 'dependabot.claude': '{{items}}\n{{ item.number }} {{item.url}}' })
    expect(errorsOf(home)).toEqual([
      'prompts/dependabot.claude.md: {{item.number}} cannot be used in a batch: together rule (todos / pr / dependencies)',
      'prompts/dependabot.claude.md: {{item.url}} cannot be used in a batch: together rule (todos / pr / dependencies)',
    ])
  })

  it('C26: the same prompt passes for an each rule', () => {
    const home = setup(withDoc((doc) => { doc.projects[0].rules[1].batch = 'each' }), { ...BASE_PROMPTS, 'dependabot.claude': '{{ item.number }}' })
    expect(errorsOf(home)).toEqual([])
  })

  it('when both each and together rules reference the same prompt, the error is on the together side', () => {
    const home = setup(withDoc((doc) => {
      doc.projects[0].rules.push({ target: 'issue', label: 'bulk', kind: 'feature', ai: 'claude', batch: 'together', delayMinutes: 0 })
    }))
    expect(errorsOf(home)).toEqual([
      'prompts/feature.claude.md: {{item.number}} cannot be used in a batch: together rule (todos / issue / bulk)',
      'prompts/feature.claude.md: {{item.title}} cannot be used in a batch: together rule (todos / issue / bulk)',
      'prompts/feature.claude.md: {{item.url}} cannot be used in a batch: together rule (todos / issue / bulk)',
    ])
  })

  it('rejects item.* even for a disabled together rule', () => {
    const home = setup(withDoc((doc) => { doc.projects[0].rules[1].enabled = false }), { ...BASE_PROMPTS, 'dependabot.claude': '{{item.title}}' })
    expect(errorsOf(home)).toEqual(['prompts/dependabot.claude.md: {{item.title}} cannot be used in a batch: together rule (todos / pr / dependencies)'])
  })

  it('an unknown variable is an error even in a prompt no rule references', () => {
    const home = setup(baseDoc(), { ...BASE_PROMPTS, 'feature.codex': '{{itme.number}} {{constructor}}' })
    expect(errorsOf(home)).toEqual([
      `prompts/feature.codex.md: {{itme.number}} is an unknown variable (choices: ${ALL_VARIABLES})`,
      `prompts/feature.codex.md: {{constructor}} is an unknown variable (choices: ${ALL_VARIABLES})`,
    ])
  })

  it('does not read from the file system the prompt of a kind whose id violates the rules', () => {
    const home = setup(withDoc((doc) => { doc.kinds.push({ id: '../x', name: 'x' }) }))
    writeFileSync(join(home, 'x.claude.md'), '{{bogus}}')
    expect(errorsOf(home)).toEqual(['kinds[2].id: "../x" is not allowed (letters, digits, _ and - only)'])
  })
})

describe('loadConfig: deriving repo', () => {
  it.each([
    ['SSH alias', 'git@github.com.taylor:acme-corp/orcapod.git', 'acme-corp/orcapod'],
    ['SSH', 'git@github.com:alice/todos.git', 'alice/todos'],
    ['SSH without .git', 'git@github.com:alice/todos', 'alice/todos'],
    ['https', 'https://github.com/alice/my.repo.git', 'alice/my.repo'],
    ['https without .git', 'https://github.com/alice/todos', 'alice/todos'],
  ])('derives owner/name from %s origin', (_name, origin, expected) => {
    expect(derivedRepo(gitRepo(origin))).toEqual({ repo: expected })
  })

  it('an origin that is not GitHub is an error', () => {
    expect(derivedRepo(gitRepo('git@gitlab.com:alice/todos.git'))).toEqual({ errors: ['projects[0].repo: cannot derive repo (origin is not a GitHub URL)'] })
  })

  it('does not show credentials embedded in the URL in the error line', () => {
    expect(derivedRepo(gitRepo('https://x-access-token:s3cret@example.com/alice/todos.git'))).toEqual({ errors: ['projects[0].repo: cannot derive repo (origin is not a GitHub URL)'] })
  })

  it('attaches the git error when origin is missing', () => {
    expect(derivedRepo(gitRepo(null))).toEqual({ errors: ["projects[0].repo: cannot derive repo (git remote get-url origin failed: error: No such remote 'origin')"] })
  })

  it('cannot derive when path is missing', () => {
    expect(derivedRepo('/nonexistent/orcapod-config-test')).toEqual({ errors: ['projects[0].repo: cannot derive repo (path does not exist)'] })
  })

  it('does not look at origin when repo is written', () => {
    const home = setup(withDoc((doc) => {
      doc.projects[0].path = gitRepo('git@github.com:alice/todos.git')
      doc.projects[0].repo = 'bob/fork'
    }))
    expect(configOf(home).projects[0].repo).toBe('bob/fork')
  })
})

describe('checkProjectPaths', () => {
  it('reports a nonexistent path and a path without .git as error lines', () => {
    const missing = '/nonexistent/orcapod-config-test'
    const plain = tempDir('orcapod-plain-')
    const repo = gitRepo(null)
    const home = setup(withDoc((doc) => {
      doc.projects = [missing, plain, repo].map((path, i) => ({ ...structuredClone(doc.projects[0]), name: `p${i}`, path }))
    }))
    expect(checkProjectPaths(configOf(home))).toEqual([
      'projects[0].path: "/nonexistent/orcapod-config-test" does not exist',
      `projects[1].path: "${plain}" has no .git`,
    ])
  })
})

describe('ruleKey', () => {
  const rule = (target: Rule['target'], label: string): Rule => ({ target, label, kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 0, enabled: true, bootstrap: 'skip' })

  it('a JSON array string of the label trimmed and lowercased', () => {
    expect(ruleKey('todos', rule('issue', ' Impl '))).toBe('["todos","issue","impl"]')
  })

  it('different pairs yield different keys even for names and labels containing / or "', () => {
    expect(ruleKey('a/b', rule('issue', 'c'))).toBe('["a/b","issue","c"]')
    expect(ruleKey('a', rule('issue', 'b/c'))).toBe('["a","issue","b/c"]')
    expect(ruleKey('a', rule('pr', 'say "hi"'))).toBe('["a","pr","say \\"hi\\""]')
  })
})

describe('isAllowedAuthor', () => {
  it('rule permission is the intersection with project permission and is inherited only when omitted', () => {
    const p: Project = { name: 'todos', path: '/', repo: 'alice/todos', githubAccount: 'taylor', enabled: true, authors: ['OWNER'], bots: [], rules: [] }
    const i: Item = { project: 'todos', repo: p.repo, target: 'issue', number: 1, title: '', url: '', labels: [], author: { login: 'alice', bot: false, association: 'OWNER' } }
    const r: Rule = { target: 'issue', label: '*', kind: 'feature', ai: 'codex', batch: 'together', delayMinutes: 5, enabled: true, bootstrap: 'skip' }
    expect(isAllowedAuthor(p, i, r)).toBe(true)
    expect(isAllowedAuthor(p, i, { ...r, authors: ['OWNER'] })).toBe(true)
    expect(isAllowedAuthor(p, i, { ...r, authors: ['MEMBER'] })).toBe(false)
    expect(isAllowedAuthor({ ...p, authors: [] }, i, { ...r, authors: ['OWNER'] })).toBe(false)
  })

  const project = (overrides: Partial<Project> = {}): Project => ({
    name: 'todos',
    path: '/Users/alice/git/todos',
    repo: 'alice/todos',
    githubAccount: 'acme-developer',
    enabled: true,
    authors: ['OWNER', 'MEMBER', 'COLLABORATOR'],
    bots: ['dependabot[bot]'],
    rules: [],
    ...overrides,
  })
  const item = (author: Item['author'], repo = 'alice/todos'): Item => ({
    project: 'todos', repo, target: 'pr', number: 7, title: 't', url: 'https://github.com/alice/todos/pull/7', labels: ['dependencies'], author,
  })

  it.each<[string, Project, Item, boolean]>([
    ['human OWNER', project(), item({ login: 'alice', bot: false, association: 'OWNER' }), true],
    ['human COLLABORATOR', project(), item({ login: 'carol', bot: false, association: 'COLLABORATOR' }), true],
    ['human NONE', project(), item({ login: 'mallory', bot: false, association: 'NONE' }), false],
    ['UNKNOWN is rejected even when authors contains NONE', project({ authors: ['NONE'] }), item({ login: 'x', bot: false, association: 'UNKNOWN' }), false],
    ['dependabot matching bots (association NONE)', project(), item({ login: 'dependabot[bot]', bot: true, association: 'NONE' }), true],
    ['bot not in bots', project(), item({ login: 'github-actions[bot]', bot: true, association: 'NONE' }), false],
    ['bot name is an exact match (case-sensitive)', project(), item({ login: 'Dependabot[bot]', bot: true, association: 'NONE' }), false],
    ['a bot is judged by bots even if OWNER', project({ bots: [] }), item({ login: 'owner-bot[bot]', bot: true, association: 'OWNER' }), false],
    ['a human using a bot name is judged by authors', project(), item({ login: 'dependabot[bot]', bot: false, association: 'NONE' }), false],
    ['a bot with an empty login is always false', project({ bots: [''] }), item({ login: '', bot: true, association: 'NONE' }), false],
    ['X1-6: a human with an empty login is false even with authors: [NONE]', project({ authors: ['NONE'] }), item({ login: '', bot: false, association: 'NONE' }), false],
    ['X1-6: a human with an empty login is false even if OWNER', project(), item({ login: '', bot: false, association: 'OWNER' }), false],
    ['false even for OWNER when the source repo differs', project(), item({ login: 'alice', bot: false, association: 'OWNER' }, 'bob/B'), false],
    ['with authors: [], every human is false', project({ authors: [] }), item({ login: 'alice', bot: false, association: 'OWNER' }), false],
    ['with bots: [], every bot is false', project({ bots: [] }), item({ login: 'dependabot[bot]', bot: true, association: 'NONE' }), false],
  ])('%s', (_name, p, i, expected) => {
    expect(isAllowedAuthor(p, i)).toBe(expected)
  })
})
