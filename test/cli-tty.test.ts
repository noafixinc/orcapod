import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { shellQuote } from '../src/launch.ts'
import { lockPath, statePath } from '../src/paths.ts'
import { liveDaemonPid, loadState } from '../src/state.ts'
import { CLI, cliEnv, collect, execCalls, setupCliHome } from './helpers/cli-process.ts'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'orcapod-cli-tty-')); setupCliHome(home) })
afterEach(async () => {
  // Includes detached daemons even if an assertion fails before their lock is read.
  for (const { pid } of execCalls(home).filter((call) => call.type === 'process')) {
    try { process.kill(pid, 'SIGTERM') } catch { /* Already exited. */ }
    await expect.poll(() => {
      try { process.kill(pid, 0); return false } catch { return true }
    }).toBe(true)
  }
  rmSync(home, { recursive: true, force: true })
})

async function inTty(args: string[], exit: (output: () => string, quit: () => void) => Promise<void>) {
  // script gives the real CLI a PTY; capture stty before/after to verify raw-mode restoration.
  const command = `stty rows 40 cols 126; before=$(stty -g); ${shellQuote(process.execPath)} ${shellQuote(CLI)} ${args.map(shellQuote).join(' ')}; code=$?; after=$(stty -g); [ "$before" = "$after" ] && echo TTY_RESTORED; echo CLI_CODE=$code; exit "$code"`
  // macOS script cannot tcgetattr Node's socket stdin; cat supplies a normal pipe.
  const child = spawn('/bin/sh', ['-c', `cat | /usr/bin/script -q /dev/null /bin/sh -c ${shellQuote(command)}`], { env: cliEnv(home), stdio: 'pipe' })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const finished = collect(child)
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
  try {
    await expect.poll(() => output, { timeout: 5000 }).toContain('\u001b[?1049h')
    await expect.poll(() => output, { timeout: 5000 }).toContain('q quit')
    expect(output).toContain('orcapod monitor')
    await exit(() => output, () => { child.stdin.write('q') })
    child.stdin.end()
    const result = await finished
    expect([result.code, result.signal, result.stderr]).toEqual([0, null, ''])
    expect(result.stdout).toContain('\u001b[?25h')
    expect(result.stdout).toContain('\u001b[?1049l')
    expect(result.stdout).toContain('TTY_RESTORED')
    expect(result.stdout).toContain('CLI_CODE=0')
    expect(result.stdout.indexOf('\u001b[?1049l')).toBeGreaterThan(result.stdout.indexOf('\u001b[?1049h'))
  } finally {
    clearTimeout(timer)
    child.stdin.end()
    for (const { pid, args: commandArgs } of execCalls(home).filter((call) => call.type === 'process')) {
      if (commandArgs[0] === 'start') continue
      try { process.kill(pid, 'SIGTERM') } catch { /* Already exited. */ }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await finished
  }
}

describe('G1: operates public up/monitor on a real TTY', () => {
  it('after launching via up and rendering, q exits only the screen, and re-running uses the same daemon PID', async () => {
    let daemonPid: number | null = null
    await inTty(['up'], async (_output, quit) => {
      await expect.poll(() => existsSync(statePath(home)), { timeout: 5000 }).toBe(true)
      daemonPid = liveDaemonPid(home)
      expect(daemonPid).not.toBe(null)
      expect(loadState(home).daemonInfo?.pid).toBe(daemonPid)
      quit()
    })
    expect(liveDaemonPid(home)).toBe(daemonPid)
    expect(() => process.kill(daemonPid!, 0)).not.toThrow()
    await inTty(['up'], async (_output, quit) => {
      expect(liveDaemonPid(home)).toBe(daemonPid)
      quit()
    })
    expect(liveDaemonPid(home)).toBe(daemonPid)
    expect(execCalls(home).filter((call) => call.type === 'process' && call.args[0] === 'start')).toHaveLength(1)
    expect(existsSync(lockPath(home))).toBe(true)
  }, 20000)

  it.each(['SIGINT', 'SIGTERM'] as const)('monitor restores the terminal and exits normally on %s', async (signal) => {
    await inTty(['monitor'], async () => {
      const monitors = execCalls(home).filter((call) => call.type === 'process' && call.args[0] === 'monitor')
      expect(monitors).toHaveLength(1)
      process.kill(monitors[0].pid, signal)
    })
    expect(execCalls(home).filter((call) => call.type === 'execFile')).toEqual([])
    expect(existsSync(statePath(home))).toBe(false)
  }, 15000)
})
