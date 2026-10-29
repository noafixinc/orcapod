import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkProposal } from '../src/approval.ts'
import { proposalRevision } from '../src/incident-contract.ts'
import type { Config, Proposal, Run } from '../src/types.ts'

let temp: string
let repo: string
let worktree: string
let config: Config
let source: Run

function git(path: string, ...args: string[]) {
  return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'orcapod-approval-'))
  repo = join(temp, 'repo')
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' })
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.invalid')
  git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'base')
  worktree = join(temp, 'worktree')
  git(repo, 'worktree', 'add', '-b', 'repair', worktree)
  const project = { name: 'todos', path: repo, repo: 'owner/todos', githubAccount: 'me', enabled: true, authors: [], bots: [], rules: [] }
  config = { settings: { maxConcurrentPerProject: 1, launch: { claude: 'claude', codex: 'codex' }, notify: { desktop: false, waitingMinutes: 10, maxRunMinutes: 120, queuedMinutes: 30 } }, kinds: [], projects: [project], prompts: new Map() }
  source = { target: { path: repo, repo: 'owner/todos', githubAccount: 'me' } } as Run
})

afterEach(() => rmSync(temp, { recursive: true, force: true }))

function snapshot(path = worktree) {
  const body: Proposal = { summary: 'fix', cause: 'cause', evidence: ['evidence'], changes: [{ path, head: git(path, 'rev-parse', 'HEAD'), summary: 'fix' }], validation: ['verification passed'], actions: ['apply the fix and check it'], risks: [] }
  return { revision: proposalRevision(body), body }
}

describe('approved artifact', () => {
  it('allows only a clean dedicated worktree of the configured repository', () => {
    expect(() => checkProposal(snapshot(), config, source)).not.toThrow()
    expect(() => checkProposal(snapshot(repo), config, source)).toThrow('dedicated worktree')
  })

  it('cannot apply when HEAD or tracked/untracked files change after approval', () => {
    const approved = snapshot()
    git(worktree, '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'changed')
    expect(() => checkProposal(approved, config, source)).toThrow('has changed')
    const current = snapshot()
    writeFileSync(join(worktree, 'untracked'), 'changed')
    expect(() => checkProposal(current, config, source)).toThrow('has changed')
    git(worktree, 'add', 'untracked')
    expect(() => checkProposal(current, config, source)).toThrow('has changed')
  })

  it('rejects another repository and a swapped approved content', () => {
    const other = join(temp, 'other')
    execFileSync('git', ['clone', repo, other], { stdio: 'ignore' })
    expect(() => checkProposal(snapshot(other), config, source)).toThrow('not an allowed repository')
    const changed = snapshot()
    changed.body.actions.push('another operation')
    expect(() => checkProposal(changed, config, source)).toThrow('revision')
  })
})

describe('preventing bypass of the main working tree restriction', () => {
  it('cannot approve a subdirectory of main as a dedicated worktree', async () => {
    const { mkdirSync } = await import('node:fs')
    const nested = join(repo, 'nested')
    mkdirSync(nested)
    expect(() => checkProposal(snapshot(nested), config, source)).toThrow('dedicated worktree')
  })
})

describe('protection of existing work locations', () => {
  it('does not reuse the configured target as the fix location even when it is itself a linked worktree', () => {
    source.target.path = worktree
    config.projects[0].path = worktree
    expect(() => checkProposal(snapshot(), config, source)).toThrow('dedicated worktree')
  })
})
