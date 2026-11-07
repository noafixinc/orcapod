import type { Item } from './types.ts'

export interface PromptVars { projectName: string; projectPath: string; repo: string; kindName: string; items: Item[]; runId: string; resultPath: string }

type Render = (vars: PromptVars) => string

const ALWAYS_RENDERERS: [string, Render][] = [
  ['project.name', (vars) => vars.projectName],
  ['project.path', (vars) => vars.projectPath],
  ['repo', (vars) => vars.repo],
  ['kind.name', (vars) => vars.kindName],
  ['items', (vars) => vars.items.map((item) => `- #${item.number} ${item.title} (${item.url})`).join('\n')],
  ['items.count', (vars) => String(vars.items.length)],
  ['run.id', (vars) => vars.runId],
  ['result.path', (vars) => vars.resultPath],
]

const EACH_ONLY_RENDERERS: [string, Render][] = [
  ['item.number', (vars) => String(vars.items.at(0)?.number ?? '')],
  ['item.title', (vars) => vars.items.at(0)?.title ?? ''],
  ['item.url', (vars) => vars.items.at(0)?.url ?? ''],
  ['item.target', (vars) => vars.items.at(0)?.target ?? ''],
]

const RENDERERS = new Map<string, Render>([...ALWAYS_RENDERERS, ...EACH_ONLY_RENDERERS])

export const PROMPT_VARIABLES: readonly string[] = [...RENDERERS.keys()]
export const EACH_ONLY_VARIABLES: readonly string[] = EACH_ONLY_RENDERERS.map(([name]) => name)

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g

export function placeholdersOf(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(PLACEHOLDER), (match) => match[1].trim()))]
}

export function renderPrompt(template: string, vars: PromptVars): string {
  const body = template.replace(PLACEHOLDER, (placeholder, name: string) => RENDERERS.get(name.trim())?.(vars) ?? placeholder)
  return `${body.trimEnd()}\n\n${closingInstructions(vars.resultPath)}`
}

function closingInstructions(resultPath: string): string {
  return `---
## orcapod completion

When the work is finished, write the following JSON to ${resultPath} (the directory exists).

{"status": "done" | "failed", "summary": "1-3 sentence summary", "links": ["URLs of the pull requests or comments you created"]}

- done: you completed the requested work
- failed: you could not complete it. Write in summary the reason and the concrete next action a human must take to resolve it. When you stop because the user has to make a decision, also use failed and write in summary what you need them to decide

Optional "retryAt": an ISO 8601 time with a timezone (for example "2026-11-14T00:00:00+09:00"). Write it only when you held an item for a reason that resolves by itself at a known time, such as a release-age wait; orcapod re-detects the run's still-open items once that time has passed and starts a new run. If several items have different times, write the earliest. Omit it otherwise.

Complete the JSON in a single write (do not write partial content and then append to it. When you rewrite it, rewrite the whole file). Once it is written, end the work. You do not need to exit the CLI (orcapod closes the tab). Also, do not wait for further input. For orcapod, the run is treated as still working until this JSON exists (you may end a turn once in the meantime, for example while waiting for CI).
`
}
