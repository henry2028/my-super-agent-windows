/**
 * The contract between the pool and whatever actually runs a Ticket.
 *
 * A worker is a process, not a Session: the pool starts it, can talk to it while it runs, and kills it if it must.
 * DSH and Codex differ in every command, in how a message reaches a running worker, and in what it leaves behind;
 * the pool sees none of that. It sees one handle per Ticket and six operations.
 */

/** Runtime a worker runs under. Recorded per Ticket so a reviewer can tell who did the work. */
export const RUNTIME_NAME = /^[a-z][a-z0-9-]{0,31}$/
export type RuntimeName = string

/** Stable ancestry; workspace placement may change without changing ownership. */
export interface WorkerOwnership {
  ownerSessionId?: string
  rootSessionId?: string
  parentTicketId?: string
  workspaceId?: string
}

export interface WorkerSpec extends WorkerOwnership {
  /** Ticket the worker belongs to; also names its record and directory. */
  ticket: string
  /** Working directory: a prepared Ticket directory or worktree, never the operator's working copy. */
  directory: string
  /** What to do, as one self-contained text. The runtime decides how to turn it into a prompt. */
  prompt: string
  /** Tags that pick experience sections for the briefing and that routing reads. */
  tags?: readonly string[]
  /** Wall-clock limit for this worker; the pool kills the process when it passes. */
  timeoutMs?: number
  /** Environment additions, on top of the one the deployment already builds for workers. */
  env?: Record<string, string>
  /** Runtime this worker must run under; the pool picks the first available one when absent. */
  runtime?: RuntimeName
  /** Session which requested this worker, for the scheduling timeline. */
  ownerSessionId?: string
}

export type WorkerState = 'queued' | 'starting' | 'running' | 'finished' | 'failed' | 'stopped' | 'timeout'

/** What a worker reports about itself, cheap enough to poll for a panel. */
export interface WorkerStatus {
  state: WorkerState
  /** Process id once started; absent while queued. */
  pid?: number
  /** ISO timestamp of the last sign of life the runtime could observe. */
  lastActivity?: string
  /** Exit code once the process ended. */
  exitCode?: number | null
  /** Last line of output or the runtime's own explanation, for the panel and for a handoff. */
  detail?: string
}

export interface WorkerArtifacts {
  /** Human-readable summary the Router posts back; empty when the worker left none. */
  summary: string
  /** Unified diff of the Ticket directory against its base, when the runtime can produce one. */
  diff?: string
}

export interface WorkerHandle {
  readonly ticket: string
  readonly runtime: RuntimeName
  readonly pid: number
  /** Delivers a message to a worker that is still running. Rejects when the runtime cannot take one. */
  post(input: string): Promise<void>
  status(): Promise<WorkerStatus>
  /** Stops the worker and everything it started. Resolves once the process is gone. */
  stop(reason?: string): Promise<void>
  /** What the worker left behind; safe to call after it ended. */
  artifacts(): Promise<WorkerArtifacts>
}

/** How a runtime reports progress and completion back to the pool. */
export interface WorkerIo {
  /** Actual DSH Session announced by the child, never inferred from its cwd. */
  session?(sessionId: string): void
  /** Called with each chunk of worker output; the pool keeps the tail and refreshes lastActivity. */
  output(chunk: string): void
  /** Called once, when the process exits. */
  exited(exitCode: number | null, signal: string | null): void
}

export interface WorkerRuntime {
  readonly name: RuntimeName
  /** Whether this runtime can start a worker at all (binary present, credentials configured). */
  available(): Promise<boolean>
  start(spec: WorkerSpec, io: WorkerIo): Promise<WorkerHandle>
}

/** What the pool returns for one Ticket once its worker ended, however it ended. */
export interface WorkerOutcome {
  ticket: string
  runtime: RuntimeName
  state: WorkerState
  startedAt?: string
  queuedAt?: string
  endedAt: string
  exitCode?: number | null
  artifacts: WorkerArtifacts
}
