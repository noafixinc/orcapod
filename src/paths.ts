import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))

export function orcapodHome(): string {
  const override = process.env.ORCAPOD_HOME
  return resolve(override === undefined || override === '' ? REPOSITORY_ROOT : override)
}

export function configPath(home: string): string {
  return join(home, 'config.yaml')
}

export function promptsDir(home: string): string {
  return join(home, 'prompts')
}

export function stateDir(home: string): string {
  return join(home, 'state')
}

export function statePath(home: string): string {
  return join(stateDir(home), 'state.json')
}

export function requestsDir(home: string): string {
  return join(stateDir(home), 'requests')
}

export function lockPath(home: string): string {
  return join(stateDir(home), 'daemon.lock')
}

export function runsDir(home: string): string {
  return join(home, 'runs')
}

export function runDir(home: string, id: string): string {
  return join(runsDir(home), id)
}

export function resultPath(home: string, id: string): string {
  return join(runDir(home, id), 'result.json')
}

export function panePath(home: string, id: string): string {
  return join(runDir(home, id), 'pane.json')
}

export function logPath(home: string): string {
  return join(home, 'logs', 'orcapod.log')
}

export function claudeConfigPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json')
}

export function codexConfigPath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml')
}
