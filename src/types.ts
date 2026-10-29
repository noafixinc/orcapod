export type Ai = 'claude' | 'codex'
export type Target = 'issue' | 'pr'

export interface Rule { target: Target; label: string; kind: string; ai: Ai; batch: 'each' | 'together'; delayMinutes: number; enabled: boolean; bootstrap: 'skip' | 'process'; authors?: Association[] }

// author_association values defined by the GitHub REST API: https://docs.github.com/en/rest/issues/issues#list-repository-issues
export const ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'MANNEQUIN', 'NONE'] as const
export type Association = (typeof ASSOCIATIONS)[number]
export type ObservedAssociation = Association | 'UNKNOWN'

export interface Project { name: string; path: string; repo: string; githubAccount: string; enabled: boolean; authors: Association[]; bots: string[]; rules: Rule[] }
export interface Kind { id: string; name: string }
export interface Settings { maxConcurrentPerProject: number; launch: Record<Ai, string>; notify: { desktop: boolean; waitingMinutes: number; maxRunMinutes: number; queuedMinutes: number } }
export interface Config { settings: Settings; kinds: Kind[]; projects: Project[]; prompts: Map<string, string> }
export type ConfigResult = { ok: true; config: Config; sha256: string } | { ok: false; errors: string[]; unknownGithubAccounts: string[] }

export interface Item { project: string; repo: string; target: Target; number: number; title: string; url: string; labels: string[]; author: { login: string; bot: boolean; association: ObservedAssociation } }
export type GithubSource = (project: Project) => Promise<Item[]>

export interface OrcaRef { handle: string; tabId: string; paneKey: string; ptyId: string }
export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'
export interface AgentObservation { paneKey: string; state: AgentState; stateSince: string; agentType: string | null; toolName: string | null; lastAssistantMessage: string | null }
export interface TerminalObservation { handle: string; tabId: string; leafId: string; ptyId: string | null; orphaned: boolean; title: string | null }
export interface TerminalList { terminals: TerminalObservation[]; complete: boolean }
export type HooksState = 'installed' | 'not_installed' | 'partial' | 'skipped' | 'error' | 'unknown'
export interface OrcaSnapshot { agents: Map<string, AgentObservation[]>; terminals: Map<string, TerminalList>; hooks: { enabled: boolean; agents: Record<Ai, HooksState> } | null }
export interface OrcaClient {
  status(): Promise<{ running: boolean; version: string | null }>
  createTerminal(input: { worktreePath: string; title: string; command: string }): Promise<{ ref: OrcaRef; warning: string | null }>
  listTerminals(worktreePath: string): Promise<TerminalList>
  closeTerminal(handle: string): Promise<{ ptyKilled: boolean | null }>
  worktreePs(): Promise<Map<string, AgentObservation[]>>
  readScreen(handle: string, lines: number): Promise<{ lines: string[]; rendered: boolean }>
  hooksStatus(): Promise<{ enabled: boolean; agents: Record<Ai, HooksState> }>
  waitExit(handle: string, timeoutMs: number): Promise<{ exited: boolean }>
  registeredPaths(): Promise<string[]>
  observe(input: { paths: string[]; hooks: boolean }): Promise<OrcaSnapshot>
}

export interface Processed { key: string; seenAt: string }
export interface Pending { ruleKey: string; project: string; items: Item[]; fireAt: string }
export interface Proposal { summary: string; cause: string; evidence: string[]; changes: { path: string; head: string; summary: string }[]; validation: string[]; actions: string[]; risks: string[] }
export interface ProposalSnapshot { revision: string; body: Proposal }
export interface Incident { status: 'pending' | 'investigating' | 'awaiting_approval' | 'applying' | 'blocked' | 'resolved'; reason: string; updatedAt: string; tasks: string[]; evidence: string[]; revisions: string[]; proposal?: ProposalSnapshot; approvedRevision?: string }
export interface RecoveryTask { sourceRunId: string; stage: 'prepare' | 'apply'; evidence: string[]; proposal?: ProposalSnapshot }
export type ResultFile = { status: 'done' | 'failed'; summary: string; links: string[]; proposal?: Proposal; verification?: string[] }
export interface ProjectSnapshot { path: string; repo: string; githubAccount: string }
export type RunPhase =
  | { kind: 'queued'; since: string }
  | { kind: 'launching'; since: string }
  | { kind: 'starting'; since: string; invalidResultSince?: string }
  | { kind: 'running'; agent: AgentState; agentSince: string; waitingSince?: string; result?: { file: ResultFile; mtime: string }; invalidResultSince?: string; closeAttempts: number }
  | { kind: 'done'; at: string; summary: string; tabClosed: boolean }
  | { kind: 'failed'; at: string; reason: string; tabClosed: boolean; launchFailed?: true }
  | { kind: 'aborted'; at: string; reason: string }
export interface Run { paneRecoveredAt?: string; launchUncertain?: boolean; incident?: Incident; recovery?: RecoveryTask; recoveryResult?: ResultFile; id: string; project: string; target: ProjectSnapshot; rule: Rule; kindName: string; items: Item[]; createdAt: string; startedAt: string | null; phase: RunPhase; history: { kind: RunPhase['kind']; at: string }[]; orca: OrcaRef | null; notified: string[]; bypassLimit: boolean; manual: boolean; lastMessage: string | null }
export interface ConfigStatus { loadedAt: string; sha256: string; error: string | null }
export interface DaemonInfo { pid: number; startedAt: string; lastCycleAt: string; lastCycleError: { at: string; message: string } | null; orcaVersion: string | null; cycleSeconds: number }
export interface State { version: 1; processed: Processed[]; pending: Pending[]; runs: Run[]; watchedRules: string[]; lastPolledAt: Record<string, string>; projectErrors: Record<string, { since: string; message: string }>; orcaOutageSince: string | null; consumedRequests: string[]; configStatus: ConfigStatus | null; daemonInfo: DaemonInfo | null }
export type Request = { type: 'run'; project: string; item: Item; kind: string; ai?: Ai; now: boolean } | { type: 'stop'; runId: string } | { type: 'rerun'; runId: string } | { type: 'investigate'; runId: string; evidence: string } | { type: 'approve'; runId: string; revision: string }
export type ReadRequest = { file: string; request: Request } | { file: string; error: string }

export interface Observations {
  now: string
  config: Config
  github: Record<string, { ok: true; items: Item[] } | { ok: false; error: string }>
  orca: { ok: true; agents: Map<string, AgentObservation[]>; terminals: Map<string, TerminalList>; hooks: { enabled: boolean; agents: Record<Ai, HooksState> } | null } | { ok: false; error: string }
  results: Record<string, { raw: string; mtime: string } | undefined>
  panes: Record<string, OrcaRef | undefined>
  requests: ReadRequest[]
}
export type Effect =
  | { type: 'launch'; runId: string }
  | { type: 'close'; runId: string; handle: string }
  | { type: 'notify'; key: string; title: string; message: string; withScreenOf?: string }
  | { type: 'writeLastMessage'; runId: string; text: string }
  | { type: 'consumeRequest'; file: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }

export interface CycleDeps { home: string; orca: OrcaClient; github: GithubSource; ghAccounts: () => Promise<string[]>; notify: (title: string, message: string) => Promise<void>; now: () => Date }
