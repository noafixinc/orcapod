import { fork } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { liveDaemonPid } from './state.ts'

const CLI = fileURLToPath(new URL('../bin/orcapod.js', import.meta.url))

// The IPC channel acknowledges initialization; a lock alone exists before validation.
export async function ensureDaemon(home: string, cli = CLI, timeoutMs = 90_000): Promise<void> {
  if (liveDaemonPid(home) !== null) return
  const output = join(home, 'logs', 'daemon.log')
  mkdirSync(join(home, 'logs'), { recursive: true })
  const fd = openSync(output, 'a', 0o600)
  let child
  try {
    child = fork(cli, ['start'], {
      detached: true,
      stdio: ['ignore', fd, fd, 'ipc'],
      env: { ...process.env, ORCAPOD_HOME: home },
      execArgv: [],
    })
  } finally {
    closeSync(fd)
  }
  let cleanup: (() => void) | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (reason: string): void => reject(new Error(`${reason}. Details: ${output}`))
      const onMessage = (message: unknown): void => {
        if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'startup' || !('ok' in message)) return
        if (message.ok === true) resolve()
        else fail('daemon failed to start')
      }
      const onError = (error: Error): void => fail(error.message)
      const onExit = (): void => fail('daemon exited before startup completed')
      const onSignal = (): void => fail('startup interrupted')
      const timer = setTimeout(() => fail('daemon startup timed out'), timeoutMs)
      child.on('message', onMessage)
      child.on('error', onError)
      child.on('exit', onExit)
      process.on('SIGINT', onSignal)
      process.on('SIGTERM', onSignal)
      cleanup = () => {
        clearTimeout(timer)
        child.off('message', onMessage)
        child.off('error', onError)
        child.off('exit', onExit)
        process.off('SIGINT', onSignal)
        process.off('SIGTERM', onSignal)
      }
    })
  } catch (error) {
    child.kill('SIGTERM')
    throw error
  } finally {
    cleanup?.()
    if (child.connected) child.disconnect()
    child.unref()
  }
}
