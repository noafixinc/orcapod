/* global process, queueMicrotask */
// Loaded only by CLI subprocess tests. Patch OS execution, never CLI decisions.
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'

const home = process.env.ORCAPOD_HOME
const fixture = JSON.parse(readFileSync(join(home, 'exec-fixture.json'), 'utf8'))
const record = (entry) => appendFileSync(join(home, 'exec-calls.jsonl'), `${JSON.stringify({ pid: process.pid, ...entry })}\n`)
record({ type: 'process', args: process.argv.slice(2) })

function output(file, args) {
  record({ type: 'execFile', file, args })
  if (file === 'osascript') return ''
  if (file === 'gh') {
    if (fixture.ghError) throw Object.assign(new Error('isolated gh unavailable'), { code: 'ENOENT' })
    if (args[0] === 'auth' && args[1] === 'status') return 'Logged in to github.com account alice\n'
    if (args[0] === 'auth' && args[1] === 'token') return 'fake-token\n'
    if (args[0] === 'api') {
      if (fixture.apiError) throw Object.assign(new Error('API denied'), { code: 1, stderr: 'API denied\n' })
      if (args.includes('--paginate')) return '[[]]'
      if (args[1] === 'repos/alice/todos') return '{"private":false}'
      if (args[1] === `repos/alice/todos/issues/${fixture.item.number}`) return JSON.stringify(fixture.item)
    }
  }
  if (file === '/Applications/Orca.app/Contents/Resources/bin/orca') {
    let result
    if (args[0] === 'status') result = { app: { running: !fixture.orcaStopped }, runtime: { appVersion: 'test-cli' } }
    else if (args[0] === 'agent') result = { enabled: true, statuses: [{ agent: 'claude', state: 'installed' }, { agent: 'codex', state: 'installed' }] }
    else if (args[0] === 'repo') result = { repos: [{ path: fixture.projectPath }] }
    else if (args[0] === 'worktree') result = { worktrees: [] }
    else if (args[1] === 'create') result = { terminal: { handle: 'term-test', tabId: 'tab-test', paneKey: 'tab-test:leaf-test', ptyId: 'pty-test' } }
    else if (args[1] === 'wait') result = { wait: { satisfied: true } }
    else if (args[1] === 'close') result = { close: { ptyKilled: true } }
    else if (args[1] === 'list') result = { terminals: [], truncated: false }
    else throw new Error(`Unexpected Orca execution: ${args.join(' ')}`)
    return JSON.stringify({ ok: true, result })
  }
  throw new Error(`External execution blocked: ${file} ${args.join(' ')}`)
}

function execFile(file, args, options, callback) {
  if (typeof options === 'function') callback = options
  const child = new EventEmitter()
  queueMicrotask(() => {
    try { callback(null, output(file, args), '') }
    catch (error) { callback(error, '', error.stderr ?? '') }
  })
  return child
}
execFile[promisify.custom] = async (file, args) => ({ stdout: output(file, args), stderr: '' })
childProcess.execFile = execFile

const realSpawn = childProcess.spawn
childProcess.spawn = (file, args, options) => {
  record({ type: 'spawn', file, args })
  if (file !== 'tail') throw new Error(`External spawn blocked: ${file}`)
  if (fixture.tailError) {
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('error', new Error('isolated tail unavailable')))
    return child
  }
  if (fixture.tailCode !== undefined) {
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('exit', fixture.tailCode))
    return child
  }
  const child = realSpawn(file, args, options)
  record({ type: 'tail', pid: child.pid, args })
  return child
}

syncBuiltinESMExports()
