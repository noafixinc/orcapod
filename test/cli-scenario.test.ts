import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCycle } from '../src/daemon.ts'
import type { CycleMemory } from '../src/daemon.ts'
import { createOrcaClient } from '../src/orca.ts'
import { loadState, readRequests } from '../src/state.ts'
import type { AgentObservation, CycleDeps, OrcaClient } from '../src/types.ts'
import { publicCli, setupCliHome, STOPPED_WARNING } from './helpers/cli-process.ts'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'orcapod-cli-scenario-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('G8: handoff between public CLIs for a normal run', () => {
  it('the cycle consumes the run request, updates completion, close, and meta from the result of the real launch.sh, and hands them over to status', async () => {
    const { projectPath } = setupCliHome(home)
    const requested = await publicCli(home, 'run', '--project', 'todos', '--issue', '7', '--kind', 'feature', '--ai', 'claude', '--now')
    const requests = readRequests(home)
    expect(requests).toHaveLength(1)
    const request = requests[0]
    if (!('request' in request) || request.request.type !== 'run') throw new Error('not a run request')
    expect(request.request).toEqual({ type: 'run', project: 'todos', kind: 'feature', ai: 'claude', now: true, item: {
      project: 'todos', repo: 'alice/todos', target: 'issue', number: 7, title: 'Work from the public CLI', url: 'https://github.com/alice/todos/issues/7', labels: ['impl'], author: { login: 'alice', bot: false, association: 'OWNER' },
    } })
    expect(requested).toEqual({ code: 0, signal: null, stdout: `request placed: ${request.file} (issue #7 Work from the public CLI / feature / claude / --now)\n`, stderr: STOPPED_WARNING })

    const ref = { handle: 'term-scenario', tabId: 'tab-scenario', paneKey: 'tab-scenario:leaf-scenario', ptyId: 'pty-scenario' }
    const creates: { worktreePath: string; title: string; command: string }[] = []
    const closed: string[] = []
    let agent: AgentObservation | null = null
    let now = new Date('2026-10-29T01:00:00.000Z')
    const orca: OrcaClient = {
      // Unexpected calls fail rather than reaching a real Orca executable.
      ...createOrcaClient('blocked', async () => { throw new Error('unexpected Orca call') }),
      status: async () => ({ running: true, version: 'scenario' }),
      observe: async () => ({ agents: new Map([[projectPath, agent === null ? [] : [agent]]]), terminals: new Map([[projectPath, { complete: true, terminals: creates.length === 0 ? [] : [{ handle: ref.handle, tabId: ref.tabId, leafId: 'leaf-scenario', ptyId: ref.ptyId, orphaned: false, title: '#7 Feature' }] }]]), hooks: null }),
      createTerminal: async (input) => {
        expect(loadState(home).runs.map((run) => run.phase.kind)).toEqual(['launching'])
        expect(readRequests(home)).toHaveLength(1)
        creates.push(input)
        return { ref, warning: null }
      },
      closeTerminal: async (handle) => { closed.push(handle); return { ptyKilled: true } },
    }
    const deps: CycleDeps = { home, orca, github: async () => [], ghAccounts: async () => ['alice'], notify: async () => { throw new Error('desktop=false') }, now: () => now }
    let memory: CycleMemory = { config: null, configBroken: false, ghAccounts: ['alice'], accountsMissingAfterRefresh: [], configStatus: null, daemon: { pid: 4242, startedAt: now.toISOString(), orcaVersion: 'scenario', cycleSeconds: 20 }, lastCycleError: null }
    memory = await runCycle(deps, memory)
    const launched = loadState(home).runs[0]
    const dir = join(home, 'runs', launched.id)
    expect(launched).toMatchObject({ project: request.request.project, items: [request.request.item], rule: { kind: request.request.kind, ai: request.request.ai }, manual: true, bypassLimit: true, phase: { kind: 'starting' }, orca: ref })
    expect(readRequests(home)).toEqual([])
    expect(loadState(home).consumedRequests).toEqual([request.file])
    expect(creates).toEqual([{ worktreePath: projectPath, title: '#7 Feature', command: `bash '${dir}/launch.sh'` }])
    const prompt = readFileSync(join(dir, 'prompt.md'), 'utf8')
    expect(prompt).toContain('alice/todos #7 Work from the public CLI')
    expect(prompt).toContain(`${dir}/result.json`)
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))).toEqual(launched)
    expect(readFileSync(join(dir, 'launch.sh'), 'utf8')).toContain(`cd '${projectPath}'`)

    writeFileSync(join(home, '.local', 'bin', 'gh'), '#!/bin/sh\n[ "$*" = "auth token -u alice -h github.com" ] || exit 97\necho scenario-token\n', { mode: 0o755 })
    writeFileSync(join(home, '.local', 'bin', 'claude'), `#!${process.execPath}
const fs = require('node:fs')
fs.writeFileSync(process.env.SCENARIO_CAPTURE, JSON.stringify({ cwd: process.cwd(), token: process.env.GH_TOKEN, args: process.argv.slice(2) }))
fs.writeFileSync(process.env.SCENARIO_RESULT, JSON.stringify({status:'done',summary:'Finished the work from the public CLI',links:['https://github.com/alice/todos/pull/8']}))
`, { mode: 0o755 })
    const capture = join(home, 'ai-capture.json')
    const result = spawnSync('/bin/bash', [join(dir, 'launch.sh')], { encoding: 'utf8', timeout: 5000, env: {
      HOME: home, PATH: '/usr/bin:/bin', ORCA_TERMINAL_HANDLE: ref.handle, ORCA_TAB_ID: ref.tabId, ORCA_PANE_KEY: ref.paneKey,
      SCENARIO_RESULT: join(dir, 'result.json'), SCENARIO_CAPTURE: capture,
    } })
    expect([result.status, result.signal, result.error, result.stdout, result.stderr]).toEqual([0, null, undefined, '', ''])
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual({ cwd: realpathSync(projectPath), token: 'scenario-token', args: ['--dangerously-skip-permissions', prompt.trimEnd()] })
    expect(JSON.parse(readFileSync(join(dir, 'pane.json'), 'utf8'))).toEqual({ handle: ref.handle, tabId: ref.tabId, paneKey: ref.paneKey })

    const writtenAt = new Date(now.getTime() + 1000)
    utimesSync(join(dir, 'result.json'), writtenAt, writtenAt)
    const resultTime = statSync(join(dir, 'result.json')).mtime
    now = new Date(resultTime.getTime() + 1000)
    agent = { paneKey: ref.paneKey, state: 'working', stateSince: now.toISOString(), agentType: 'claude', toolName: null, lastAssistantMessage: null }
    memory = await runCycle(deps, memory)
    expect(loadState(home).runs[0].phase.kind).toBe('running')
    expect(closed).toEqual([])
    now = new Date(now.getTime() + 1000)
    agent = { ...agent, state: 'done', stateSince: now.toISOString(), lastAssistantMessage: 'Finished' }
    await runCycle(deps, memory)
    const done = loadState(home)
    expect(done.runs).toHaveLength(1)
    expect(done.runs[0]).toMatchObject({ id: launched.id, items: [request.request.item], phase: { kind: 'done', at: now.toISOString(), summary: 'Finished the work from the public CLI', tabClosed: true } })
    expect(closed).toEqual([ref.handle])
    expect(creates).toHaveLength(1)
    expect(done.consumedRequests).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))).toEqual(done.runs[0])
    expect(readFileSync(join(dir, 'last-message.md'), 'utf8')).toBe('Finished')
    const status = await publicCli(home, 'status', '--json')
    expect([status.code, status.signal, status.stderr]).toEqual([0, null, ''])
    expect(JSON.parse(status.stdout)).toEqual(done)
    expect(readRequests(home)).toEqual([])
    expect(readdirSync(join(home, 'runs'))).toEqual([launched.id])
    expect(existsSync(join(home, 'state', 'requests', request.file))).toBe(false)
  })
})
