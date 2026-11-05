import { join } from 'node:path'
import { configPath, promptsDir } from './paths.ts'
import { cellText, displayWidth, fitWidth } from './terminal-text.ts'
import type { Config } from './types.ts'

export function formatConfig(config: Config, home: string): string {
  const { settings, kinds, projects, prompts } = config
  return [
    `Config: ${cellText(configPath(home))} (version 1)`,
    'Values from disk with defaults applied; the daemon may still be using its previous config.',
    '',
    'Settings',
    table(['Setting', 'Value'], [
      ['maxConcurrentPerProject', String(settings.maxConcurrentPerProject)],
      ['launch.claude', settings.launch.claude],
      ['launch.codex', settings.launch.codex],
      ['notify.desktop', String(settings.notify.desktop)],
      ['notify.waitingMinutes', String(settings.notify.waitingMinutes)],
      ['notify.maxRunMinutes', String(settings.notify.maxRunMinutes)],
      ['notify.queuedMinutes', String(settings.notify.queuedMinutes)],
    ]),
    '',
    `Kinds (${kinds.length})`,
    table(['id', 'name'], kinds.map((kind) => [kind.id, kind.name])),
    '',
    `Projects (${projects.length})`,
    ...projects.flatMap((project) => [
      '',
      `Project: ${cellText(project.name)}`,
      table(['Setting', 'Value'], [
        ['path', project.path],
        ['repo', project.repo],
        ['githubAccount', project.githubAccount],
        ['enabled', String(project.enabled)],
        ['authors', list(project.authors)],
        ['bots', list(project.bots)],
      ]),
      '',
      `Rules (${project.rules.length})`,
      'A rule launches only when both project.enabled and rule.enabled are true.',
      'Rule authors further restrict project.authors; inherit uses project.authors. Bots use project.bots.',
      table(['target', 'label', 'kind', 'ai', 'batch', 'delayMinutes', 'enabled', 'bootstrap', 'authors'], project.rules.map((rule) => [
        rule.target, rule.label, rule.kind, rule.ai, rule.batch, String(rule.delayMinutes),
        String(rule.enabled), rule.bootstrap, rule.authors === undefined ? 'inherit' : list(rule.authors),
      ])),
    ]),
    '',
    `Prompts (${prompts.size})`,
    table(['Template', 'File'], [...prompts.keys()].map((key) => [`${key}.md`, join(promptsDir(home), `${key}.md`)])),
  ].join('\n')
}

function list(values: readonly string[]): string {
  return values.length === 0 ? '(none)' : values.join(', ')
}

function table(headers: string[], rows: string[][]): string {
  const cells = [headers, ...rows].map((row) => row.map(cellText))
  const widths = headers.map((_, column) => Math.max(...cells.map((row) => displayWidth(row[column]))))
  const border = `+${widths.map((width) => '-'.repeat(width + 2)).join('+')}+`
  const lines = cells.map((row) => `| ${row.map((cell, column) => fitWidth(cell, widths[column])).join(' | ')} |`)
  return [border, lines[0], border, ...lines.slice(1), border].join('\n')
}
