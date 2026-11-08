import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { EACH_ONLY_VARIABLES, placeholdersOf, PROMPT_VARIABLES, renderPrompt } from '../src/prompt.ts'
import type { PromptVars } from '../src/prompt.ts'
import type { Item } from '../src/types.ts'

const CLOSING = `---
## orcapod completion

When the work is finished, write the following JSON to /h/runs/20261023-0917-3f9a1c/result.json (the directory exists).

{"status": "done" | "failed", "summary": "1-3 sentence summary", "links": ["URLs of the pull requests or comments you created"]}

- done: you completed the requested work
- failed: you could not complete it. Write in summary the reason and the concrete next action a human must take to resolve it. When you stop because the user has to make a decision, also use failed and write in summary what you need them to decide

Optional "retryAt": an ISO 8601 time with a timezone (for example "2026-11-14T00:00:00+09:00"). Write it only when you held an item for a reason that resolves by itself at a known time, such as a release-age wait; orcapod re-detects the run's still-open items once that time has passed and starts a new run. If several items have different times, write the earliest. Omit it otherwise.

Complete the JSON in a single write (do not write partial content and then append to it. When you rewrite it, rewrite the whole file). Once it is written, end the work. You do not need to exit the CLI (orcapod closes the tab). Also, do not wait for further input. For orcapod, the run is treated as still working until this JSON exists (you may end a turn once in the meantime, for example while waiting for CI).
`

const CLOSING_PHRASES = ['in a single write', 'do not wait for further input', 'orcapod closes the tab', 'treated as still working until this JSON exists']

function item(number: number, title: string): Item {
  return {
    project: 'todos',
    repo: 'alice/todos',
    target: 'issue',
    number,
    title,
    url: `https://github.com/alice/todos/issues/${number}`,
    labels: ['impl'],
    author: { login: 'alice', bot: false, association: 'OWNER' },
  }
}

function vars(items: Item[]): PromptVars {
  return {
    projectName: 'todos',
    projectPath: '/Users/alice/git/todos',
    repo: 'alice/todos',
    kindName: 'Feature',
    items,
    runId: '20261023-0917-3f9a1c',
    resultPath: '/h/runs/20261023-0917-3f9a1c/result.json',
  }
}

describe('renderPrompt', () => {
  it('expands all variables and appends the closing instructions at the end', () => {
    const template = [
      '{{project.name}} | {{project.path}} | {{repo}} | {{kind.name}}',
      '{{items.count}} items',
      '{{items}}',
      '#{{item.number}} {{item.title}} {{item.url}} {{item.target}}',
      '{{run.id}} {{result.path}}',
    ].join('\n')
    expect(renderPrompt(template, vars([item(123, 'Faster search')]))).toBe(`todos | /Users/alice/git/todos | alice/todos | Feature
1 items
- #123 Faster search (https://github.com/alice/todos/issues/123)
#123 Faster search https://github.com/alice/todos/issues/123 issue
20261023-0917-3f9a1c /h/runs/20261023-0917-3f9a1c/result.json

${CLOSING}`)
  })

  it('allows whitespace inside the braces, as in {{ items }}', () => {
    expect(renderPrompt('{{ items }}\n{{  items.count}}', vars([item(1, 'a'), item(2, 'b')]))).toBe(`- #1 a (https://github.com/alice/todos/issues/1)
- #2 b (https://github.com/alice/todos/issues/2)
2

${CLOSING}`)
  })

  it('trims trailing newlines of the template before appending the closing instructions', () => {
    expect(renderPrompt('Body\n\n\n', vars([item(1, 'a')]))).toBe(`Body

${CLOSING}`)
  })

  it('does not expand {{…}} or $& contained in substituted values', () => {
    expect(renderPrompt('{{item.title}}', vars([item(7, '{{run.id}} $& $1')]))).toBe(`{{run.id}} $& $1

${CLOSING}`)
  })

  it('leaves unknown variables and prototype names as they are', () => {
    expect(renderPrompt('{{unknown}} {{constructor}} {{toString}}', vars([item(1, 'a')]))).toBe(`{{unknown}} {{constructor}} {{toString}}

${CLOSING}`)
  })

  it('A13-3: the closing instructions keep every clause and the result.json keys and values', () => {
    const prompt = renderPrompt('{{items}}', vars([item(1, 'a')]))
    for (const phrase of [...CLOSING_PHRASES, '"status"', '"summary"', '"links"', '"retryAt"', '"done"', '"failed"']) expect(prompt).toContain(phrase)
  })
})

describe('placeholdersOf', () => {
  it('returns them in order of appearance without duplicates, with the whitespace inside the braces removed', () => {
    expect(placeholdersOf('{{repo}} {{ item.number }} {{repo}} {{item.number}} {{ unknown name }} {{}}')).toEqual(['repo', 'item.number', 'unknown name', ''])
  })

  it('empty when there are no variables', () => {
    expect(placeholdersOf('no variables { } {{ x')).toEqual([])
  })
})

describe('variable listing', () => {
  it('prompt variables, and item.* usable only with batch: each', () => {
    expect(PROMPT_VARIABLES).toEqual(['project.name', 'project.path', 'repo', 'kind.name', 'items', 'items.count', 'run.id', 'result.path', 'item.number', 'item.title', 'item.url', 'item.target'])
    expect(EACH_ONLY_VARIABLES).toEqual(['item.number', 'item.title', 'item.url', 'item.target'])
  })
})

describe('incident removal: I5', () => {
  it('K5-1: every configured kind and AI combination receives the complete new failed instruction', () => {
    const example = parse(readFileSync(join(import.meta.dirname, '..', 'examples', 'config.yaml'), 'utf8')) as { kinds: { id: string; name: string }[] }
    for (const kind of example.kinds) {
      for (const ai of ['claude', 'codex']) {
        const prompt = renderPrompt(`${kind.id}.${ai}: {{kind.name}}`, { ...vars([item(1, 'work')]), kindName: kind.name })
        expect(prompt).toBe(`${kind.id}.${ai}: ${kind.name}\n\n${CLOSING}`)
        expect(prompt).toContain('Write in summary the reason and the concrete next action a human must take to resolve it.')
      }
    }
  })
})
