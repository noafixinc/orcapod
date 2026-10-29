import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeConfigPath, codexConfigPath, configPath, orcapodHome, lockPath, logPath, panePath, promptsDir, requestsDir, resultPath, runDir, runsDir, stateDir, statePath } from '../src/paths.ts'

const ENV_NAMES = ['ORCAPOD_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))
  for (const name of ENV_NAMES) delete process.env[name]
})

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = saved[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('orcapodHome', () => {
  it('uses ORCAPOD_HOME when it is set', () => {
    process.env.ORCAPOD_HOME = '/tmp/orcapod-test-home'
    expect(orcapodHome()).toBe('/tmp/orcapod-test-home')
  })

  it('is the repository root when ORCAPOD_HOME is not set', () => {
    expect(orcapodHome()).toBe(REPOSITORY_ROOT)
  })

  it('is the repository root when ORCAPOD_HOME is an empty string', () => {
    process.env.ORCAPOD_HOME = ''
    expect(orcapodHome()).toBe(REPOSITORY_ROOT)
  })

  it('re-reads the environment variable on every call', () => {
    process.env.ORCAPOD_HOME = '/tmp/orcapod-a'
    expect(orcapodHome()).toBe('/tmp/orcapod-a')
    delete process.env.ORCAPOD_HOME
    expect(orcapodHome()).toBe(REPOSITORY_ROOT)
  })

  it.each([
    ['relative path', 'sandbox/h', join(process.cwd(), 'sandbox/h')],
    ['whitespace only', '  ', join(process.cwd(), '  ')],
    ['with trailing slash', '/tmp/orcapod-test-home/', '/tmp/orcapod-test-home'],
    ['containing ..', '/tmp/orcapod-a/../orcapod-b', '/tmp/orcapod-b'],
  ])('ORCAPOD_HOME (%s) becomes the resolved absolute path', (_name, value, expected) => {
    process.env.ORCAPOD_HOME = value
    expect(orcapodHome()).toBe(expected)
  })

  it('the default stays the repository root even when cwd changes', () => {
    const cwd = process.cwd()
    const elsewhere = mkdtempSync(join(tmpdir(), 'orcapod-paths-'))
    try {
      process.chdir(elsewhere)
      expect(orcapodHome()).toBe(REPOSITORY_ROOT)
    } finally {
      process.chdir(cwd)
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})

describe('paths under home', () => {
  it('returns the configuration, state, run, and log paths inside the home', () => {
    const home = '/h'
    expect({
      config: configPath(home),
      prompts: promptsDir(home),
      state: stateDir(home),
      stateFile: statePath(home),
      requests: requestsDir(home),
      lock: lockPath(home),
      runs: runsDir(home),
      run: runDir(home, '20261023-0917-3f9a1c'),
      result: resultPath(home, '20261023-0917-3f9a1c'),
      pane: panePath(home, '20261023-0917-3f9a1c'),
      log: logPath(home),
    }).toEqual({
      config: '/h/config.yaml',
      prompts: '/h/prompts',
      state: '/h/state',
      stateFile: '/h/state/state.json',
      requests: '/h/state/requests',
      lock: '/h/state/daemon.lock',
      runs: '/h/runs',
      run: '/h/runs/20261023-0917-3f9a1c',
      result: '/h/runs/20261023-0917-3f9a1c/result.json',
      pane: '/h/runs/20261023-0917-3f9a1c/pane.json',
      log: '/h/logs/orcapod.log',
    })
  })
})

describe('claudeConfigPath', () => {
  it('uses .claude.json under CLAUDE_CONFIG_DIR when it is set', () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-config'
    expect(claudeConfigPath()).toBe('/tmp/claude-config/.claude.json')
  })

  it('uses ~/.claude.json when CLAUDE_CONFIG_DIR is not set', () => {
    expect(claudeConfigPath()).toBe(join(homedir(), '.claude.json'))
  })
})

describe('codexConfigPath', () => {
  it('uses config.toml under CODEX_HOME when it is set', () => {
    process.env.CODEX_HOME = '/tmp/codex-home'
    expect(codexConfigPath()).toBe('/tmp/codex-home/config.toml')
  })

  it('uses ~/.codex/config.toml when CODEX_HOME is not set', () => {
    expect(codexConfigPath()).toBe(join(homedir(), '.codex', 'config.toml'))
  })
})
