import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareRun, runTitle, shellQuote } from '../src/launch.ts'
import type { Config, Item, Run } from '../src/types.ts'

const item: Item = {
  project: 'todos',
  repo: 'alice/todos',
  target: 'issue',
  number: 123,
  title: 'Inventory list',
  url: 'https://github.com/alice/todos/issues/123',
  labels: ['impl'],
  author: { login: 'alice', bot: false, association: 'OWNER' },
}

function runAt(projectPath: string, overrides: Partial<Run> = {}): Run {
  return {
    id: '20261023-0917-3f9a1c',
    project: 'todos',
    target: { path: projectPath, repo: 'alice/todos', githubAccount: 'taylor' },
    rule: { target: 'issue', label: 'impl', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 5, enabled: true, bootstrap: 'skip' },
    kindName: 'Feature',
    items: [item],
    createdAt: '2026-10-23T00:12:00.000Z',
    startedAt: null,
    phase: { kind: 'launching', since: '2026-10-23T00:17:00.000Z' },
    history: [{ kind: 'queued', at: '2026-10-23T00:12:00.000Z' }, { kind: 'launching', at: '2026-10-23T00:17:00.000Z' }],
    orca: null,
    notified: [],
    bypassLimit: false,
    manual: false,
    lastMessage: null,
    ...overrides,
  }
}

function configWith(launchClaude: string): Config {
  return {
    settings: {
      maxConcurrentPerProject: 2,
      launch: { claude: launchClaude, codex: 'codex --dangerously-bypass-approvals-and-sandbox' },
      notify: { desktop: true, waitingMinutes: 10, maxRunMinutes: 120, queuedMinutes: 30 },
    },
    kinds: [{ id: 'feature', name: 'Feature' }],
    projects: [],
    prompts: new Map([['feature.claude', 'Implement issue #{{item.number}} "{{item.title}}" of {{repo}}.\n']]),
  }
}

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orcapod-launch-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('shellQuote', () => {
  it('wraps in single quotes and turns an inner \' into \'\\\'\'', () => {
    expect(shellQuote('/Users/alice/git/todos')).toBe("'/Users/alice/git/todos'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote('')).toBe("''")
    expect(shellQuote('$HOME "x" `y`')).toBe("'$HOME \"x\" `y`'")
  })
})

describe('runTitle', () => {
  it('each gives #<number> <kind name>, together gives <kind name> ×<count>', () => {
    expect(runTitle(runAt('/p'))).toBe('#123 Feature')
    const together = runAt('/p', { rule: { ...runAt('/p').rule, batch: 'together' }, kindName: 'Dependabot update', items: [item, { ...item, number: 124 }] })
    expect(runTitle(together)).toBe('Dependabot update ×2')
  })
})

describe('prepareRun', () => {
  it('writes prompt.md, meta.json and launch.sh to runs/<id>/, and the command sent to Orca is bash followed by the quoted launch.sh path', () => {
    const run = runAt('/Users/alice/git/todos')
    const prepared = prepareRun(home, run, configWith('claude --dangerously-skip-permissions'))
    const dir = join(home, 'runs', '20261023-0917-3f9a1c')
    expect(prepared).toEqual({ launchScript: join(dir, 'launch.sh'), title: '#123 Feature', command: `bash '${dir}/launch.sh'` })
    expect(readFileSync(join(dir, 'launch.sh'), 'utf8')).toBe(`#!/bin/bash
set -euo pipefail
printf '{"handle":"%s","tabId":"%s","paneKey":"%s"}\\n' "\${ORCA_TERMINAL_HANDLE-}" "\${ORCA_TAB_ID-}" "\${ORCA_PANE_KEY-}" > '${dir}/pane.json'
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
GH_TOKEN="$(gh auth token -u 'taylor' -h github.com)"
[ -n "$GH_TOKEN" ] || { echo 'orcapod: cannot obtain GH_TOKEN' >&2; exit 1; }
export GH_TOKEN
cd '/Users/alice/git/todos'
exec claude --dangerously-skip-permissions "$(cat '${dir}/prompt.md')"
`)
    const prompt = readFileSync(join(dir, 'prompt.md'), 'utf8')
    expect(prompt.startsWith('Implement issue #123 "Inventory list" of alice/todos.\n\n---\n## orcapod completion\n\n')).toBe(true)
    expect(prompt).toContain(`write the following JSON to ${dir}/result.json`)
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))).toEqual(run)
  })

  it('C30: the command starts with bash, followed by a path beginning with a single quote', () => {
    const { command } = prepareRun(home, runAt('/p'), configWith('claude'))
    expect(command.startsWith("bash '")).toBe(true)
  })

  it('throws and writes nothing when runs/<id>/ already exists', () => {
    mkdirSync(join(home, 'runs', '20261023-0917-3f9a1c'), { recursive: true })
    expect(() => prepareRun(home, runAt('/p'), configWith('claude'))).toThrow('EEXIST')
    expect(existsSync(join(home, 'runs', '20261023-0917-3f9a1c', 'launch.sh'))).toBe(false)
  })

  it('X1-9: with reuse-relaunch, uses the existing runs/<id>/ and rewrites the prompt.md, meta.json and launch.sh written by the previous launch', () => {
    const dir = join(home, 'runs', '20261023-0917-3f9a1c')
    prepareRun(home, runAt('/old'), configWith('claude'))
    const relaunched = runAt('/new')
    const prepared = prepareRun(home, relaunched, configWith('claude --model opus'), 'reuse-relaunch')
    expect(prepared.command).toBe(`bash '${dir}/launch.sh'`)
    expect(readFileSync(join(dir, 'launch.sh'), 'utf8')).toContain(`cd '/new'\nexec claude --model opus "$(cat '${dir}/prompt.md')"\n`)
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))).toEqual(relaunched)
  })

  it('throws without creating the directory when the configuration has no prompt for the kind × AI', () => {
    const codexRun = runAt('/p', { rule: { ...runAt('/p').rule, ai: 'codex' } })
    expect(() => prepareRun(home, codexRun, configWith('claude'))).toThrow('prompts/feature.codex.md is missing')
    expect(existsSync(join(home, 'runs', '20261023-0917-3f9a1c'))).toBe(false)
  })

  it("C36: launch.sh passes bash -n even for a path containing ' or whitespace", () => {
    const { launchScript } = prepareRun(join(home, "dev 'flow"), runAt("/Users/o'brien/git/my project"), configWith('claude'))
    const check = spawnSync('bash', ['-n', launchScript], { encoding: 'utf8' })
    expect([check.status, check.stderr]).toEqual([0, ''])
  })
})

describe('running launch.sh (C29)', () => {
  let bin: string
  let projectPath: string
  let marker: string

  beforeEach(() => {
    bin = join(home, '.local', 'bin')
    mkdirSync(bin, { recursive: true })
    projectPath = join(home, "it's project")
    mkdirSync(projectPath)
    marker = join(home, 'ai-started')
    writeExecutable(join(bin, 'fake-ai'), `#!/bin/bash\nprintf 'cwd=%s\\ntoken=%s\\nargc=%s\\nfirst=%s\\n' "$PWD" "$GH_TOKEN" "$#" "$1" > ${shellQuote(marker)}\nprintf '%s' "$2" > ${shellQuote(`${marker}.prompt`)}\n`)
  })

  function writeExecutable(path: string, body: string): void {
    writeFileSync(path, body)
    chmodSync(path, 0o755)
  }

  function runLaunch(ghBody: string): { status: number | null; signal: NodeJS.Signals | null; error: Error | undefined; stdout: string; stderr: string; launchScript: string } {
    writeExecutable(join(bin, 'gh'), ghBody)
    const { launchScript } = prepareRun(join(home, 'orcapod'), runAt(projectPath), configWith('fake-ai --print'))
    const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ORCA_TERMINAL_HANDLE: 'term_1', ORCA_TAB_ID: 'tab-1', ORCA_PANE_KEY: 'tab-1:leaf-1' }
    const result = spawnSync('bash', [launchScript], { env, encoding: 'utf8' })
    return { status: result.status, signal: result.signal, error: result.error, stdout: result.stdout, stderr: result.stderr, launchScript }
  }

  it('with a succeeding gh, writes pane.json, passes GH_TOKEN, and runs the launch command in the project folder with the prompt as a single argument', () => {
    const { status, signal, error, stdout, stderr } = runLaunch('#!/bin/bash\n[ "$*" = "auth token -u taylor -h github.com" ] || exit 9\necho gho_fake\n')
    expect([status, signal, error, stdout, stderr]).toEqual([0, null, undefined, '', ''])
    const dir = join(home, 'orcapod', 'runs', '20261023-0917-3f9a1c')
    expect(readFileSync(join(dir, 'pane.json'), 'utf8')).toBe('{"handle":"term_1","tabId":"tab-1","paneKey":"tab-1:leaf-1"}\n')
    expect(readFileSync(marker, 'utf8')).toBe(`cwd=${projectPath}\ntoken=gho_fake\nargc=2\nfirst=--print\n`)
    expect(readFileSync(`${marker}.prompt`, 'utf8')).toBe(readFileSync(join(dir, 'prompt.md'), 'utf8').replace(/\n+$/, ''))
  })

  it('Q5: with a failing gh, exits with code 1, prints the reason to stderr, and does not call the launch command', () => {
    const { status, signal, error, stdout, stderr } = runLaunch('#!/bin/bash\necho "no account" >&2\nexit 1\n')
    expect([status, signal, error, stdout, stderr]).toEqual([1, null, undefined, '', 'no account\n'])
    expect(existsSync(marker)).toBe(false)
  })

  it('when gh returns an empty string, reports that GH_TOKEN cannot be obtained, exits with code 1, and does not call the launch command', () => {
    const { status, signal, error, stdout, stderr } = runLaunch('#!/bin/bash\necho ""\n')
    expect([status, signal, error, stdout, stderr]).toEqual([1, null, undefined, '', 'orcapod: cannot obtain GH_TOKEN\n'])
    expect(existsSync(marker)).toBe(false)
  })

  it.each(['', ' --no-daemon', " '--no-daemon'", ' --', ' --no-daemon --', ' --no-daemon --cd /tmp/codex --'])('Codex does not use the shared server, and an existing --no-daemon is not duplicated and is placed before -- (%s)', (option) => {
    writeExecutable(join(bin, 'gh'), '#!/bin/bash\necho gho_fake\n')
    writeExecutable(join(bin, 'fake-codex'), `#!/bin/bash\nprintf '%s\\0' "$@" > ${shellQuote(marker)}\nprintf '%s' "$ORCA_PANE_KEY" > ${shellQuote(`${marker}.pane`)}\n`)
    const config = configWith('claude')
    config.settings.launch.codex = `fake-codex --model 'model with spaces'${option}`
    config.prompts.set('feature.codex', 'Work on {{repo}}')
    const { launchScript } = prepareRun(home, runAt(projectPath, { rule: { ...runAt(projectPath).rule, ai: 'codex' } }), config)
    const result = spawnSync('bash', [launchScript], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ORCA_PANE_KEY: 'own-tab:own-leaf' }, encoding: 'utf8' })
    expect([result.status, result.signal, result.error, result.stdout, result.stderr]).toEqual([0, null, undefined, '', ''])
    const args = readFileSync(marker, 'utf8').split('\0').slice(0, -1)
    expect(args.slice(0, -1)).toEqual(['--model', 'model with spaces', '--no-daemon', ...(option.includes('--cd') ? ['--cd', '/tmp/codex'] : []), ...(option.endsWith(' --') ? ['--'] : [])])
    expect(args.at(-1)).toBe(readFileSync(join(home, 'runs', '20261023-0917-3f9a1c', 'prompt.md'), 'utf8').trimEnd())
    expect(readFileSync(`${marker}.pane`, 'utf8')).toBe('own-tab:own-leaf')
  })

  it('keeps the stderr redirect of a custom Codex launch command', () => {
    writeExecutable(join(bin, 'gh'), '#!/bin/bash\necho gho_fake\n')
    writeExecutable(join(bin, 'fake-codex'), '#!/bin/bash\necho codex-diagnostic >&2\n')
    const config = configWith('claude')
    const stderrPath = join(home, "it's stderr.log")
    config.settings.launch.codex = `fake-codex 2>${shellQuote(stderrPath)}`
    config.prompts.set('feature.codex', 'Work on {{repo}}')
    const { launchScript } = prepareRun(home, runAt(projectPath, { rule: { ...runAt(projectPath).rule, ai: 'codex' } }), config)
    const result = spawnSync('bash', [launchScript], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' })
    expect([result.status, result.signal, result.error, result.stdout, result.stderr]).toEqual([0, null, undefined, '', ''])
    expect(readFileSync(stderrPath, 'utf8')).toBe('codex-diagnostic\n')
  })

  it.each([['--', ''], ['--', ' --'], ['-u codex --', ' --'], ['-iu codex --', ' --'], ['-iucodex --', ' --']])('distinguishes the %s of env itself from the %s of Codex when inserting the option', (envOptions, option) => {
    writeExecutable(join(bin, 'gh'), '#!/bin/bash\necho gho_fake\n')
    writeExecutable(join(bin, 'codex'), `#!/bin/bash\n[ "$ORCAPOD_TEST" = ok ] || exit 9\nprintf '%s\\0' "$@" > ${shellQuote(marker)}\n`)
    const config = configWith('claude')
    config.settings.launch.codex = `env ${envOptions} ORCAPOD_TEST=ok ${shellQuote(join(bin, 'codex'))} --model 'model with spaces'${option}`
    config.prompts.set('feature.codex', 'Work on {{repo}}')
    const { launchScript } = prepareRun(home, runAt(projectPath, { rule: { ...runAt(projectPath).rule, ai: 'codex' } }), config)
    const result = spawnSync('bash', [launchScript], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' })
    expect([result.status, result.signal, result.error, result.stdout, result.stderr]).toEqual([0, null, undefined, '', ''])
    expect(readFileSync(marker, 'utf8').split('\0').slice(0, -2)).toEqual(['--model', 'model with spaces', '--no-daemon', ...(option ? ['--'] : [])])
  })
})

describe('incident recovery launch', () => {
  it('passes the failure evidence and the pre-approval scope instead of the normal original prompt', () => {
    const run = runAt('/repo', { recovery: { sourceRunId: '20261023-0800-abcdef', stage: 'prepare', evidence: ['database name mismatch'] }, kindName: 'Incident investigation' })
    const config = configWith('claude')
    config.prompts.clear()
    const prepared = prepareRun(home, run, config)
    const prompt = readFileSync(join(home, 'runs', run.id, 'prompt.md'), 'utf8')
    expect(prepared.title).toBe('Incident investigation abcdef')
    expect(prompt).toContain('It is not a rerun of the original work')
    expect(prompt).toContain('push, pull request creation, merge, messaging other people, expanding database privileges and production operations are forbidden')
    expect(prompt).toContain('database name mismatch')
    expect(prompt).toContain('"proposal"')
    expect(prompt).not.toContain('Implement issue #123 "Inventory list"')
  })
})
