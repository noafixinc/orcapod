import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lockPath, requestsDir, stateDir, statePath } from './paths.ts'
import { validIncident, validRecovery, parseProposal } from './incident-contract.ts'
import { ASSOCIATIONS } from './types.ts'
import type { Item, ReadRequest, Request, Rule, RunPhase, State } from './types.ts'

export type StateSnapshot = { kind: 'missing' } | { kind: 'ok'; state: State; mtime: string } | { kind: 'error'; message: string }

function initialState(): State {
  return { version: 1, processed: [], pending: [], runs: [], watchedRules: [], lastPolledAt: {}, projectErrors: {}, orcaOutageSince: null, consumedRequests: [], configStatus: null, daemonInfo: null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const PHASE_KINDS: readonly RunPhase['kind'][] = ['queued', 'launching', 'starting', 'running', 'done', 'failed', 'aborted']

type ShapeCheck = (value: Record<string, unknown>) => string | null

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === 'string'
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isString)
}

function isItemArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isItem)
}

function isRule(value: unknown): value is Rule {
  return isRecord(value)
    && (value.target === 'issue' || value.target === 'pr')
    && isString(value.label)
    && isString(value.kind)
    && (value.ai === 'claude' || value.ai === 'codex')
    && (value.batch === 'each' || value.batch === 'together')
    && typeof value.delayMinutes === 'number'
    && typeof value.enabled === 'boolean'
    && (value.bootstrap === 'skip' || value.bootstrap === 'process')
    && (value.authors === undefined || (Array.isArray(value.authors) && value.authors.every((entry) => ASSOCIATIONS.some((association) => association === entry))))
}

function isProjectSnapshot(value: unknown): boolean {
  return isRecord(value) && isString(value.path) && isString(value.repo) && isString(value.githubAccount)
}

function isOrcaRefOrNull(value: unknown): boolean {
  return value === null || (isRecord(value) && isString(value.handle) && isString(value.tabId) && isString(value.paneKey) && isString(value.ptyId))
}

function fieldError(value: Record<string, unknown>, checks: [field: string, valid: (field: unknown) => boolean, expected: string][]): string | null {
  const failed = checks.find(([field, valid]) => !valid(value[field]))
  return failed === undefined ? null : `${failed[0]} is not ${failed[2]}`
}

const processedShapeError: ShapeCheck = (value) => fieldError(value, [['key', isString, 'a string'], ['seenAt', isString, 'a string']])

const pendingShapeError: ShapeCheck = (value) => fieldError(value, [
  ['ruleKey', isString, 'a string'],
  ['project', isString, 'a string'],
  ['items', isItemArray, 'an array of items'],
  ['fireAt', isString, 'a string'],
])

const runShapeError: ShapeCheck = (value) => {
  const error = fieldError(value, [
    ['id', isString, 'a string'],
    ['id', isRunId, 'a valid run ID'],
    ['project', isString, 'a string'],
    ['target', isProjectSnapshot, 'a path / repo / githubAccount set'],
    ['rule', isRule, 'a valid rule'],
    ['kindName', isString, 'a string'],
    ['items', isItemArray, 'an array of items'],
    ['createdAt', isString, 'a string'],
    ['startedAt', isStringOrNull, 'a string or null'],
    ['phase', isRecord, 'an object'],
    ['history', Array.isArray, 'an array'],
    ['orca', isOrcaRefOrNull, 'a pane reference or null'],
    ['notified', isStringArray, 'an array of strings'],
    ['bypassLimit', (field) => typeof field === 'boolean', 'a boolean'],
    ['manual', (field) => typeof field === 'boolean', 'a boolean'],
    ['lastMessage', isStringOrNull, 'a string or null'],
  ])
  if (error !== null) return error
  if (value.paneRecoveredAt !== undefined && typeof value.paneRecoveredAt !== 'string') return 'paneRecoveredAt is not a string'
  if (value.launchUncertain !== undefined && typeof value.launchUncertain !== 'boolean') return 'launchUncertain is not a boolean'
  if (value.incident !== undefined && !validIncident(value.incident)) return 'incident is malformed'
  if (value.recovery !== undefined && !validRecovery(value.recovery)) return 'recovery is malformed'
  if (value.recoveryResult !== undefined) {
    const result = value.recoveryResult
    if (!isRecord(result) || !['done', 'failed'].includes(String(result.status)) || !isString(result.summary) || !isStringArray(result.links)) return 'recoveryResult is malformed'
    if (result.proposal !== undefined && parseProposal(result.proposal) === null) return 'recoveryResult.proposal is malformed'
    if (result.verification !== undefined && !isStringArray(result.verification)) return 'recoveryResult.verification is malformed'
  }
  const { kind, tabClosed, launchFailed } = value.phase as Record<string, unknown>
  if (!PHASE_KINDS.some((k) => k === kind)) return `phase.kind is not one of ${PHASE_KINDS.join(' / ')}: ${JSON.stringify(kind)}`
  if (kind !== 'failed') return null
  if (typeof tabClosed !== 'boolean') return 'phase.tabClosed is not a boolean'
  return launchFailed === undefined || launchFailed === true ? null : 'phase.launchFailed is not true'
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) > 0
}

function isPositiveNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isCycleErrorOrNull(value: unknown): boolean {
  return value === null || (isRecord(value) && isString(value.at) && isString(value.message))
}

const configStatusShapeError: ShapeCheck = (value) => fieldError(value, [
  ['loadedAt', isString, 'a string'],
  ['sha256', (field) => isString(field) && SHA256_HEX_PATTERN.test(field), '64 lowercase hex digits'],
  ['error', isStringOrNull, 'a string or null'],
])

const daemonInfoShapeError: ShapeCheck = (value) => fieldError(value, [
  ['pid', isPositiveInteger, 'a positive integer'],
  ['startedAt', isString, 'a string'],
  ['lastCycleAt', isString, 'a string'],
  ['lastCycleError', isCycleErrorOrNull, 'an at / message pair or null'],
  ['orcaVersion', isStringOrNull, 'a string or null'],
  ['cycleSeconds', isPositiveNumber, 'a positive number'],
])

function nullableRecordError(name: string, value: unknown, check: ShapeCheck): string | null {
  if (value === null) return null
  if (!isRecord(value)) return `${name} is neither null nor an object`
  const error = check(value)
  return error === null ? null : `${name}.${error}`
}

function elementsError(name: string, list: unknown[], check: ShapeCheck): string | null {
  for (const [i, element] of list.entries()) {
    if (!isRecord(element)) return `${name}[${i}] is not an object`
    const error = check(element)
    if (error !== null) return `${name}[${i}].${error}`
  }
  return null
}

function stateShapeError(value: unknown): string | null {
  if (!isRecord(value)) return 'not an object'
  if (value.version !== 1) return `version is not 1: ${JSON.stringify(value.version)}`
  for (const name of ['processed', 'pending', 'runs', 'watchedRules', 'consumedRequests']) {
    if (!Array.isArray(value[name])) return `${name} is not an array`
  }
  for (const name of ['lastPolledAt', 'projectErrors']) {
    if (!isRecord(value[name])) return `${name} is not an object`
  }
  if (value.orcaOutageSince !== null && typeof value.orcaOutageSince !== 'string') return 'orcaOutageSince is neither a string nor null'
  if (!isStringArray(value.watchedRules)) return 'watchedRules is not an array of strings'
  if (!isStringArray(value.consumedRequests)) return 'consumedRequests is not an array of strings'
  if (!Object.values(value.lastPolledAt as Record<string, unknown>).every(isString)) return 'lastPolledAt has a value that is not a string'
  const projectErrors = Object.values(value.projectErrors as Record<string, unknown>)
  if (!projectErrors.every((error) => isRecord(error) && isString(error.since) && isString(error.message))) return 'projectErrors has a value that is not a since / message pair'
  return nullableRecordError('configStatus', value.configStatus, configStatusShapeError)
    ?? nullableRecordError('daemonInfo', value.daemonInfo, daemonInfoShapeError)
    ?? elementsError('processed', value.processed as unknown[], processedShapeError)
    ?? elementsError('pending', value.pending as unknown[], pendingShapeError)
    ?? elementsError('runs', value.runs as unknown[], runShapeError)
}

function fillFieldsAbsentBefore002(parsed: unknown): void {
  if (!isRecord(parsed)) return
  if (parsed.configStatus === undefined) parsed.configStatus = null
  if (parsed.daemonInfo === undefined) parsed.daemonInfo = null
  if (!Array.isArray(parsed.runs)) return
  for (const run of parsed.runs) {
    if (isRecord(run) && isRecord(run.phase) && run.phase.kind === 'failed' && run.phase.tabClosed === undefined) run.phase.tabClosed = false
  }
}

function brokenStateError(path: string, cause: unknown): Error {
  return new Error(`${path} is corrupt: ${(cause as Error).message}`, { cause })
}

function orBrokenState<T>(path: string, operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    throw brokenStateError(path, error)
  }
}

function parseState(text: string, path: string): State {
  const parsed = orBrokenState<unknown>(path, () => JSON.parse(text))
  fillFieldsAbsentBefore002(parsed)
  const shapeError = stateShapeError(parsed)
  if (shapeError !== null) throw new Error(`${path} is corrupt: ${shapeError}`)
  return parsed as State
}

export function loadState(home: string): State {
  const path = statePath(home)
  if (!existsSync(path)) return initialState()
  return parseState(orBrokenState(path, () => readFileSync(path, 'utf8')), path)
}

export function readStateSnapshot(home: string): StateSnapshot {
  const path = statePath(home)
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'missing' }
    return { kind: 'error', message: brokenStateError(path, error).message }
  }
  try {
    const { mtime, text } = orBrokenState(path, () => ({ mtime: fstatSync(fd).mtime, text: readFileSync(fd, 'utf8') }))
    return { kind: 'ok', state: parseState(text, path), mtime: mtime.toISOString() }
  } catch (error) {
    return { kind: 'error', message: (error as Error).message }
  } finally {
    closeSync(fd)
  }
}

function writeDurably(path: string, content: string): void {
  const fd = openSync(path, 'w')
  try {
    writeFileSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function saveState(home: string, state: State): void {
  mkdirSync(stateDir(home), { recursive: true })
  const path = statePath(home)
  const tmp = `${path}.tmp`
  writeDurably(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, path)
}

export function writeRequest(home: string, req: Request): string {
  const dir = requestsDir(home)
  mkdirSync(dir, { recursive: true })
  const file = `${new Date().toISOString()}-${randomBytes(2).toString('hex')}.json`
  const path = join(dir, file)
  const tmp = `${path}.tmp`
  writeDurably(tmp, `${JSON.stringify(req)}\n`)
  renameSync(tmp, path)
  return file
}

function isItem(value: unknown): value is Item {
  if (!isRecord(value)) return false
  const { author } = value
  return typeof value.project === 'string'
    && typeof value.repo === 'string'
    && (value.target === 'issue' || value.target === 'pr')
    && Number.isInteger(value.number)
    && typeof value.title === 'string'
    && typeof value.url === 'string'
    && Array.isArray(value.labels) && value.labels.every((label) => typeof label === 'string')
    && isRecord(author)
    && typeof author.login === 'string'
    && typeof author.bot === 'boolean'
    && (author.association === 'UNKNOWN' || (ASSOCIATIONS as readonly unknown[]).includes(author.association))
}

function parseRequest(value: unknown): Request | string {
  if (!isRecord(value)) return 'request is not an object'
  switch (value.type) {
    case 'run':
      if (typeof value.project !== 'string') return 'project is not a string'
      if (!isItem(value.item)) return 'item is malformed'
      if (typeof value.kind !== 'string') return 'kind is not a string'
      if (value.ai !== undefined && value.ai !== 'claude' && value.ai !== 'codex') return `ai is not claude / codex: ${JSON.stringify(value.ai)}`
      if (typeof value.now !== 'boolean') return 'now is not a boolean'
      return value.ai === undefined
        ? { type: 'run', project: value.project, item: value.item, kind: value.kind, now: value.now }
        : { type: 'run', project: value.project, item: value.item, kind: value.kind, ai: value.ai, now: value.now }
    case 'approve':
      if (typeof value.runId !== 'string' || typeof value.revision !== 'string' || !SHA256_HEX_PATTERN.test(value.revision)) return 'approve has an invalid runId / revision'
      return { type: 'approve', runId: value.runId, revision: value.revision }
    case 'investigate':
      if (typeof value.runId !== 'string' || typeof value.evidence !== 'string' || value.evidence.length > 16_000) return 'investigate has an invalid runId / evidence'
      return { type: 'investigate', runId: value.runId, evidence: value.evidence }
    case 'stop':
    case 'rerun':
      if (typeof value.runId !== 'string') return 'runId is not a string'
      return { type: value.type, runId: value.runId }
    default:
      return `type is not run / stop / rerun: ${JSON.stringify(value.type)}`
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

export function readRequests(home: string): ReadRequest[] {
  const dir = requestsDir(home)
  if (!existsSync(dir)) return []
  const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
  const requests: ReadRequest[] = []
  for (const file of files) {
    let raw: string
    try {
      raw = readFileSync(join(dir, file), 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue
      requests.push({ file, error: `cannot read: ${(error as Error).message}` })
      continue
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (error) {
      requests.push({ file, error: `not valid JSON: ${(error as Error).message}` })
      continue
    }
    const request = parseRequest(json)
    requests.push(typeof request === 'string' ? { file, error: request } : { file, request })
  }
  return requests
}

export function consumeRequest(home: string, file: string): void {
  rmSync(join(requestsDir(home), file), { force: true })
}

// process.kill throws ERR_INVALID_ARG_TYPE (not ESRCH) for a pid outside int32
const MAX_SIGNALABLE_PID = 2 ** 31 - 1

function readLockHolder(path: string): number | null {
  let content: string
  try {
    content = readFileSync(path, 'utf8').trim()
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
  if (!/^[1-9]\d*$/.test(content)) return null
  const pid = Number(content)
  return pid <= MAX_SIGNALABLE_PID ? pid : null
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false
    if (errorCode(error) === 'EPERM') return true
    throw error
  }
}

function publishLockWithPid(path: string, pid: number): boolean {
  const staged = `${path}.${pid}.tmp`
  writeDurably(staged, `${pid}\n`)
  try {
    linkSync(staged, path)
    return true
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false
    throw error
  } finally {
    rmSync(staged, { force: true })
  }
}

export function acquireDaemonLock(home: string, pid: number): { ok: true } | { ok: false; holder: number } {
  mkdirSync(stateDir(home), { recursive: true })
  const path = lockPath(home)
  for (let attempt = 0; attempt < 2; attempt++) {
    if (publishLockWithPid(path, pid)) return { ok: true }
    const holder = readLockHolder(path)
    if (holder !== null && isAlive(holder)) return { ok: false, holder }
    if (attempt === 0) rmSync(path, { force: true })
  }
  throw new Error(`cannot acquire ${path}: another process recreated it after the stale lock was removed`)
}

export function liveDaemonPid(home: string): number | null {
  const holder = readLockHolder(lockPath(home))
  return holder !== null && isAlive(holder) ? holder : null
}

export function releaseDaemonLock(home: string, pid: number): void {
  const path = lockPath(home)
  if (readLockHolder(path) === pid) rmSync(path, { force: true })
}

export function processedKey(item: Item, label: string): string {
  return JSON.stringify([item.project, item.target, item.number, label])
}

const SHA1_HEX_LENGTH = 40
const RUN_ID_HASH_MIN_LENGTH = 6
const RUN_ID_PATTERN = new RegExp(`^\\d{8}-\\d{4}-[0-9a-f]{${RUN_ID_HASH_MIN_LENGTH},${SHA1_HEX_LENGTH}}$`)

function isRunId(value: unknown): boolean {
  return isString(value) && RUN_ID_PATTERN.test(value)
}

function utcMinutePrefix(now: string): string {
  const iso = new Date(now).toISOString()
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`
}

export function newRunId(now: string, seed: string, existing: ReadonlySet<string>): string {
  const prefix = utcMinutePrefix(now)
  const hash = createHash('sha1').update(seed).digest('hex')
  for (let length = RUN_ID_HASH_MIN_LENGTH; length <= SHA1_HEX_LENGTH; length++) {
    const id = `${prefix}-${hash.slice(0, length)}`
    if (!existing.has(id)) return id
  }
  throw new Error(`run ID keeps colliding with existing runs: ${prefix}-${hash}`)
}
