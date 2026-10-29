import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { logPath } from './paths.ts'
import type { Effect } from './types.ts'

export type LogLevel = Extract<Effect, { type: 'log' }>['level']

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function localTimestamp(date: Date): string {
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  return `${day} ${time}`
}

export function log(home: string, level: LogLevel, message: string): void {
  const line = `${localTimestamp(new Date())} ${level} ${message}\n`
  const path = logPath(home)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, line)
  process.stdout.write(line)
}
