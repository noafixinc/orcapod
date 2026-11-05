import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/config.ts'
import { formatConfig } from '../src/config-view.ts'
import { displayWidth } from '../src/terminal-text.ts'
import type { Config } from '../src/types.ts'

function config(): Config {
  return {
    settings: structuredClone(DEFAULT_SETTINGS),
    kinds: [{ id: 'feature', name: '\u6a5f\u80fd\u958b\u767a 🐳' }],
    projects: [{
      name: 'todos', path: '/Users/you/git/todos', repo: 'acme-corp/todos', githubAccount: 'alice',
      enabled: false, authors: ['OWNER', 'MEMBER'], bots: [],
      rules: [
        { target: 'issue', label: '\u5b9f\u88c5 🐳', kind: 'feature', ai: 'codex', batch: 'each', delayMinutes: 0, enabled: true, bootstrap: 'skip' },
        { target: 'pr', label: '*', kind: 'feature', ai: 'claude', batch: 'together', delayMinutes: 45, enabled: false, bootstrap: 'process', authors: [] },
        { target: 'issue', label: 'review', kind: 'feature', ai: 'claude', batch: 'each', delayMinutes: 5, enabled: true, bootstrap: 'skip', authors: ['MEMBER'] },
      ],
    }],
    prompts: new Map([['feature.codex', 'Do the work.']]),
  }
}

function rows(output: string): string[][] {
  return output.split('\n').filter((line) => line.startsWith('| ')).map((line) => line.slice(2, -2).split(' | ').map((cell) => cell.trim()))
}

describe('configuration tables', () => {
  it('shows disabled projects and every rule option, distinguishes inherited/empty authors, and lists prompt files', () => {
    const value = config()
    value.settings.maxConcurrentPerProject = 7
    value.settings.notify.desktop = false
    const output = formatConfig(value, '/tmp/orcapod')
    const cells = rows(output)
    expect(output).toContain('Config: /tmp/orcapod/config.yaml (version 1)')
    expect(output).toContain('Projects (1)')
    expect(output).toContain('Project: todos')
    expect(output).toContain('Rules (3)')
    expect(cells).toEqual(expect.arrayContaining([
      ['maxConcurrentPerProject', '7'], ['notify.desktop', 'false'],
      ['launch.codex', DEFAULT_SETTINGS.launch.codex], ['notify.maxRunMinutes', '120'],
      ['feature', '\u6a5f\u80fd\u958b\u767a 🐳'], ['path', '/Users/you/git/todos'], ['repo', 'acme-corp/todos'],
      ['githubAccount', 'alice'], ['enabled', 'false'], ['authors', 'OWNER, MEMBER'], ['bots', '(none)'],
      ['issue', '\u5b9f\u88c5 🐳', 'feature', 'codex', 'each', '0', 'true', 'skip', 'inherit'],
      ['pr', '*', 'feature', 'claude', 'together', '45', 'false', 'process', '(none)'],
      ['issue', 'review', 'feature', 'claude', 'each', '5', 'true', 'skip', 'MEMBER'],
      ['feature.codex.md', '/tmp/orcapod/prompts/feature.codex.md'],
    ]))
    expect(output).not.toContain('Do the work.')
  })

  it('keeps table borders aligned for Japanese, emoji, long values and control characters', () => {
    const value = config()
    value.kinds[0].name += '\n\u001b[31m'
    value.settings.launch.codex = `codex ${'a'.repeat(200)}`
    const output = formatConfig(value, '/tmp/orcapod')
    const tables = output.match(/(?:^[+|].*\n?)+/gm) ?? []
    expect(tables.length).toBeGreaterThan(0)
    for (const table of tables) {
      const lines = table.trimEnd().split('\n')
      expect(new Set(lines.map(displayWidth)).size).toBe(1)
    }
    expect([...output].some((char) => char !== '\n' && (char.charCodeAt(0) <= 0x1f || (char.charCodeAt(0) >= 0x7f && char.charCodeAt(0) <= 0x9f)))).toBe(false)
    expect(output).toContain(value.settings.launch.codex)
  })

  it('renders empty collections and keeps multiple projects in configuration order', () => {
    const value = config()
    value.kinds = []
    value.prompts.clear()
    value.projects.push({ ...structuredClone(value.projects[0]), name: 'second', rules: [] })
    const output = formatConfig(value, '/tmp/orcapod')
    expect(output).toContain('Kinds (0)')
    expect(output).toContain('Prompts (0)')
    expect(output).toContain('Rules (0)')
    expect(output.indexOf('Project: todos')).toBeLessThan(output.indexOf('Project: second'))
    value.projects = []
    expect(formatConfig(value, '/tmp/orcapod')).toContain('Projects (0)')
  })
})
