import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { proposalRevision } from './incident-contract.ts'
import type { Config, ProposalSnapshot, Run } from './types.ts'

function git(path: string, ...args: string[]): string {
  return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function common(path: string): string {
  return realpathSync(git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
}

export function checkProposal(snapshot: ProposalSnapshot, config: Config, source: Run): void {
  if (proposalRevision(snapshot.body) !== snapshot.revision) throw new Error('proposal does not match its revision')
  const allowedPaths = [source.target.path, resolve(import.meta.dirname, '..'), ...config.projects.filter((project) => project.enabled).map((project) => project.path)]
  const protectedRoots = new Set(allowedPaths.flatMap((path) => {
    try { return [realpathSync(path)] } catch { return [] }
  }))
  const allowed = new Set(allowedPaths.flatMap((path) => {
    try { return [common(path)] } catch { return [] }
  }))
  for (const change of snapshot.body.changes) {
    if (!allowed.has(common(change.path))) throw new Error(`change target is not an allowed repository: ${change.path}`)
    if (protectedRoots.has(realpathSync(change.path)) || realpathSync(git(change.path, 'rev-parse', '--show-toplevel')) !== realpathSync(change.path) || realpathSync(git(change.path, 'rev-parse', '--absolute-git-dir')) === common(change.path)) throw new Error(`save the fix at the root of a dedicated worktree, not in the main working tree: ${change.path}`)
    if (git(change.path, 'rev-parse', 'HEAD') !== change.head || git(change.path, 'status', '--porcelain') !== '') throw new Error(`HEAD or working tree of the approved change has changed: ${change.path}`)
  }
}
