import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { log } from '../src/log.ts'
import { logPath } from '../src/paths.ts'

let home: string
let savedTz: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orcapod-log-'))
  savedTz = process.env.TZ
  process.env.TZ = 'Asia/Tokyo'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  if (savedTz === undefined) delete process.env.TZ
  else process.env.TZ = savedTz
  rmSync(home, { recursive: true, force: true })
})

describe('log', () => {
  it('creates logs/ if missing, appends a line of local time, level, and message, and also writes it to stdout', () => {
    vi.setSystemTime(new Date('2026-10-23T00:12:00.000Z'))
    log(home, 'info', 'poll todos: open 14 items')
    vi.setSystemTime(new Date('2026-10-23T00:17:05.000Z'))
    log(home, 'warn', 'terminal create: surface background')

    expect(readFileSync(logPath(home), 'utf8')).toBe(
      '2026-10-23 09:12:00 info poll todos: open 14 items\n'
      + '2026-10-23 09:17:05 warn terminal create: surface background\n',
    )
    expect(vi.mocked(process.stdout.write).mock.calls).toEqual([
      ['2026-10-23 09:12:00 info poll todos: open 14 items\n'],
      ['2026-10-23 09:17:05 warn terminal create: surface background\n'],
    ])
  })
})
