import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configPath, lockPath, promptsDir } from '../src/paths.ts'
import { liveDaemonPid } from '../src/state.ts'
import { ensureDaemon } from '../src/up.ts'

let home: string
let cli: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orcapod-up-'))
  mkdirSync(promptsDir(home), { recursive: true })
  writeFileSync(join(promptsDir(home), 'feature.claude.md'), '{{items}}\n')
  writeFileSync(configPath(home), JSON.stringify({
    version: 1, settings: { notify: { desktop: false } },
    kinds: [{ id: 'feature', name: 'Feature' }],
    projects: [{ name: 'todos', path: home, repo: 'alice/todos', githubAccount: 'alice', rules: [
      { target: 'issue', label: 'impl', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 5 },
    ] }],
  }))
  cli = join(home, 'daemon.mjs')
  writeFileSync(cli, `
    import { writeFileSync } from 'node:fs'
    import { start } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'daemon.ts'))}
    const home = process.env.ORCAPOD_HOME
    writeFileSync(home + '/spawned.pid', String(process.pid))
    process.on('disconnect', () => writeFileSync(home + '/disconnected', 'yes'))
    await start({
      home, now: () => new Date(), ghAccounts: async () => ['alice'], notify: async () => {},
      github: async () => [],
      orca: {
        status: async () => ({ running: true, version: 'test' }),
        observe: async () => ({ agents: new Map(), terminals: new Map(), hooks: null }),
      },
    }, (ok) => process.send({ type: 'startup', ok }))
  `)
})

afterEach(async () => {
  const path = join(home, 'spawned.pid')
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'))
    try { process.kill(pid, 'SIGTERM') } catch { /* Already exited. */ }
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0) } catch { break }
      await sleep(10)
    }
    try { process.kill(pid, 'SIGKILL') } catch { /* Already exited. */ }
  }
  rmSync(home, { recursive: true, force: true })
})

describe('entry point that launches the daemon and connects to the monitor', () => {
  it('waits for the real daemon to finish launching, the daemon keeps running after the IPC is closed, and rerunning uses the same PID', async () => {
    await ensureDaemon(home, cli)
    const pid = liveDaemonPid(home)
    expect(pid).toBe(Number(readFileSync(join(home, 'spawned.pid'), 'utf8')))
    await expect.poll(() => existsSync(join(home, 'disconnected'))).toBe(true)
    expect(() => process.kill(pid!, 0)).not.toThrow()
    await ensureDaemon(home, join(home, 'not-present.mjs'))
    expect(liveDaemonPid(home)).toBe(pid)
    expect(readFileSync(join(home, 'logs', 'orcapod.log'), 'utf8')).toContain('daemon started')
  })

  it('the daemon keeps running even after the parent process that launched it exits', async () => {
    const upModule = join(import.meta.dirname, '..', 'src', 'up.ts')
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { ensureDaemon } from ${JSON.stringify(upModule)}
      await ensureDaemon(${JSON.stringify(home)}, ${JSON.stringify(cli)})
    `], { timeout: 5000 })
    expect(liveDaemonPid(home)).toBe(Number(readFileSync(join(home, 'spawned.pid'), 'utf8')))
  })

  it('exits as a launch failure on an invalid configuration, leaving no lock and pointing to the error log', async () => {
    writeFileSync(configPath(home), 'invalid: true\n')
    await expect(ensureDaemon(home, cli)).rejects.toThrow(`Details: ${join(home, 'logs', 'daemon.log')}`)
    expect(liveDaemonPid(home)).toBe(null)
    expect(existsSync(lockPath(home))).toBe(false)
    expect(readFileSync(join(home, 'logs', 'daemon.log'), 'utf8')).not.toBe('')
  })

  it('detects a child process that dies before startup completes', async () => {
    await expect(ensureDaemon(home, join(home, 'missing.mjs'))).rejects.toThrow('exited before startup completed')
  })

  it('requests termination of a child process that does not finish launching, on timeout', async () => {
    writeFileSync(cli, `
      import { writeFileSync } from 'node:fs'
      writeFileSync(process.env.ORCAPOD_HOME + '/spawned.pid', String(process.pid))
      setInterval(() => {}, 1000)
    `)
    await expect(ensureDaemon(home, cli, 500)).rejects.toThrow('timed out')
    const pid = Number(readFileSync(join(home, 'spawned.pid'), 'utf8'))
    await expect.poll(() => {
      try { process.kill(pid, 0); return false } catch { return true }
    }).toBe(true)
  })

  it.each([{ args: [] }, { args: ['--unknown'] }])('with non-TTY or invalid arguments %j, does not launch the daemon or modify the home', async ({ args }) => {
    const realCli = join(import.meta.dirname, '..', 'bin', 'orcapod.js')
    await expect(promisify(execFile)(process.execPath, [realCli, 'up', ...args], {
      env: { ...process.env, ORCAPOD_HOME: join(home, 'untouched') },
    })).rejects.toMatchObject({
      code: 1, stdout: '', stderr: args.length === 0
        ? 'Run this in a terminal. Use orcapod start to run in the foreground or orcapod status to see the state\n'
        : "orcapod up: Unknown option '--unknown'\nUsage: orcapod up\n",
    })
    expect(existsSync(join(home, 'untouched'))).toBe(false)
  })
})
