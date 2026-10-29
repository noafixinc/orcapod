import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const OSASCRIPT_TIMEOUT_MS = 10_000

function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function notificationScript(title: string, message: string): string {
  return `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`
}

export async function notify(title: string, message: string): Promise<void> {
  await execFileAsync('osascript', ['-e', notificationScript(title, message)], { timeout: OSASCRIPT_TIMEOUT_MS })
}
