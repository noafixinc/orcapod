import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLI = fileURLToPath(new URL('../../bin/orcapod.js', import.meta.url))
const PRELOAD = fileURLToPath(new URL('../fixtures/exec-preload.mjs', import.meta.url))
export const STOPPED_WARNING = 'warning: the daemon is not running (orcapod start). It processes the request once started\n'

export function setupCliHome(home: string) {
  const projectPath = join(home, 'project')
  mkdirSync(join(projectPath, '.git'), { recursive: true })
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  for (const ai of ['claude', 'codex']) writeFileSync(join(home, '.local', 'bin', ai), '#!/bin/sh\nexit 99\n', { mode: 0o755 })
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [projectPath]: { hasTrustDialogAccepted: true } } }))
  mkdirSync(join(home, 'prompts'), { recursive: true })
  writeFileSync(join(home, 'prompts', 'feature.claude.md'), '{{repo}} #{{item.number}} {{item.title}}\n')
  writeFileSync(join(home, 'prompts', 'feature.codex.md'), '{{repo}} #{{item.number}} {{item.title}}\n')
  const config = {
    version: 1, settings: { notify: { desktop: false } },
    kinds: [{ id: 'feature', name: 'Feature' }],
    projects: [{ name: 'todos', path: projectPath, repo: 'alice/todos', githubAccount: 'alice', rules: [
      { target: 'issue', label: 'impl', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 5, enabled: true },
    ] }],
  }
  writeFileSync(join(home, 'config.yaml'), JSON.stringify(config))
  const item = { number: 7, title: 'Work from the public CLI', html_url: 'https://github.com/alice/todos/issues/7', labels: [{ name: 'impl' }], user: { login: 'alice', type: 'User' }, author_association: 'OWNER' }
  const fixture = { projectPath, item }
  writeFixture(home, fixture)
  return { config, fixture, projectPath }
}

export function writeFixture(home: string, fixture: object): void {
  writeFileSync(join(home, 'exec-fixture.json'), JSON.stringify(fixture))
}

export function cliEnv(home: string): NodeJS.ProcessEnv {
  // Do not inherit a real user's credentials or AI configuration locations.
  return { HOME: home, PATH: '/usr/bin:/bin', ORCAPOD_HOME: home, CLAUDE_CONFIG_DIR: home, CODEX_HOME: join(home, 'codex'), NODE_OPTIONS: `--import=${PRELOAD}` }
}

export interface CliResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
export function collect(child: ChildProcess): Promise<CliResult> {
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

export function cliProcess(home: string, args: string[], ipc = false): ChildProcess {
  return spawn(process.execPath, [CLI, ...args], { env: cliEnv(home), stdio: ipc ? ['pipe', 'pipe', 'pipe', 'ipc'] : 'pipe' })
}

export async function publicCli(home: string, ...args: string[]): Promise<CliResult> {
  const child = cliProcess(home, args)
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  try { return await collect(child) } finally { clearTimeout(timer) }
}

export function execCalls(home: string): { pid: number; type: string; file?: string; args: string[] }[] {
  const path = join(home, 'exec-calls.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as ReturnType<typeof execCalls>[number]) : []
}
