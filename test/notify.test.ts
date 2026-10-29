import { describe, expect, it } from 'vitest'
import { notificationScript } from '../src/notify.ts'

describe('notificationScript', () => {
  it('builds an AppleScript of display notification <message> with title <title>', () => {
    expect(notificationScript('orcapod', 'run 3f9a1c: done')).toBe('display notification "run 3f9a1c: done" with title "orcapod"')
  })

  it('escapes " and \\', () => {
    expect(notificationScript('a "b" \\c', 'path C:\\x "quoted"')).toBe('display notification "path C:\\\\x \\"quoted\\"" with title "a \\"b\\" \\\\c"')
  })

  it('for the sequence \\" escapes \\ first so it does not break out of the string', () => {
    expect(notificationScript('t', '\\" & do shell script "x')).toBe('display notification "\\\\\\" & do shell script \\"x" with title "t"')
  })

  it('leaves newlines and single quotes as they are', () => {
    expect(notificationScript('t', "line 1\nit's")).toBe("display notification \"line 1\nit's\" with title \"t\"")
  })
})
