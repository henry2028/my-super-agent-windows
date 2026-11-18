/**
 * The pool: a fixed number of slots, a queue, and one process per Ticket.
 *
 * The pool owns three things the runtimes must not each invent: who runs now, what happens when a worker never
 * ends, and the record a restarted host reads. Everything a runtime does behind its `WorkerHandle` is invisible here,
 * which is what makes a Codex worker and a DSH worker the same shape to the Router.
 */
import { WorkerTable, type WorkerRecord } from './table.ts'
import type { RuntimeName, WorkerHandle, WorkerIo, WorkerOutcome, WorkerRuntime, WorkerSpec, WorkerState } from './types.ts'

export interface PoolOptions {
  /** Deployment state directory; worker records live under it. */
  stateDir: string
  /** Runtimes this pool may start, by name. */
  runtimes: readonly WorkerRuntime[]
  /** How many workers may run at once. */
  maxWorkers?: number
  /** Picks the runtime for a Ticket; defaults to the first one that is available. */
  choose?: (spec: WorkerSpec) => string | undefined
  /** Wall-clock limit per worker when the spec does not carry one. */
  defaultTimeoutMs?: number
  /** How often the record's last-activity timestamp is refreshed. */
  heartbeatMs?: number
  log?: (line: string) => void
}

interface Queued {
  spec: WorkerSpec
  record: WorkerRecord
  saved: Promise<void>
  resolve: (outcome: WorkerOutcome) => void
}

interface Slot {
  record: WorkerRecord
  handle?: WorkerHandle
  stopping: boolean
  timedOut: boolean
  interrupt: () => void
  done: Promise<void>
}

/** Starts queued workers within the concurrency limit and persists their outcomes. */
export class WorkerPool {
  /** Host callback for indexing a child Session once its durable identity is known. */
  onSession?: (record: WorkerRecord) => Promise<void>
  private readonly table: WorkerTable
  private readonly queue: Queued[] = []
  private readonly active = new Map<string, Slot>()
  private closed = false
  private readonly ready: Promise<unknown>
  private readonly options: Required<Pick<PoolOptions, 'maxWorkers' | 'defaultTimeoutMs' | 'heartbeatMs'>> & PoolOptions

  constructor(options: PoolOptions) {
    this.options = { maxWorkers: 2, defaultTimeoutMs: 30 * 60_000, heartbeatMs: 15_000, ...options }
    if (!Number.isInteger(this.options.maxWorkers) || this.options.maxWorkers < 1) throw new Error('maxWorkers must be a positive integer')
    this.table = new WorkerTable(options.stateDir)
    // A host that stopped mid-flight leaves records saying "running" with a dead pid; fix them before anyone reads.
    this.ready = this.reconcile().catch(error => { this.options.log?.(`Pool recovery failed: ${String(error)}`) })
  }

  /**
   * Marks every record whose worker is no longer alive as failed.
   *
   * Without this a restart leaves zombie records: the panel shows work in progress that nobody is doing, and the
   * Ticket is never reported back. A record counts only while its process answers, which is the one fact a restarted
   * host can still check for itself.
   */
  async reconcile(): Promise<string[]> {
    const reaped: string[] = []
    for (const record of await this.table.list()) {
      if (this.active.has(record.ticket) || this.queue.some(item => item.spec.ticket === record.ticket)) continue
      if (!['queued', 'running', 'starting'].includes(record.state)) continue
      const alive = record.pid !== undefined && (() => { try { process.kill(record.pid!, 0); return true } catch { return false } })()
      if (record.state !== 'queued' && alive) continue
      await this.table.write({ ...record, state: 'failed', endedAt: new Date().toISOString(),
        detail: record.detail ?? 'the process was gone when the pool looked; the host may have restarted while it ran' })
      reaped.push(record.ticket)
    }
    return reaped
  }

  /** Records of every worker this pool knows about, running or not. */
  async records(): Promise<WorkerRecord[]> {
    await this.ready
    await Promise.allSettled(this.queue.map(item => item.saved))
    return this.table.list()
  }

  /** Update the same in-memory record used by heartbeats, so moves cannot be overwritten. */
  async assign(ticket: string, ownership: Pick<WorkerRecord, 'rootSessionId' | 'parentTicketId' | 'workspaceId' | 'sessionId'>): Promise<void> {
    await this.ready
    const record = this.active.get(ticket)?.record ?? this.queue.find(item => item.spec.ticket === ticket)?.record ?? await this.table.read(ticket)
    if (!record) throw new Error(`Unknown worker ${ticket}`)
    Object.assign(record, ownership)
    await this.table.write(record)
  }

  /** Tickets waiting for a slot, oldest first. */
  get waiting(): readonly string[] { return this.queue.map(item => item.spec.ticket) }
  get capacity(): number { return this.options.maxWorkers }

  /** Cancels a queued/starting worker or stops its running process, recording an explicit cancellation. */
  async stop(ticket: string, reason = 'operator request'): Promise<boolean> {
    const index = this.queue.findIndex(item => item.spec.ticket === ticket)
    if (index >= 0) {
      const [job] = this.queue.splice(index, 1)
      const endedAt = new Date().toISOString()
      const record = { ...job!.record, state: 'stopped' as const, endedAt, detail: reason }
      await job!.saved.catch(() => {})
      await this.table.write(record).catch(error => { this.options.log?.(`Cannot persist cancellation of ${ticket}: ${String(error)}`) })
      job!.resolve({ ticket, runtime: record.runtime, state: 'stopped', queuedAt: record.queuedAt, endedAt, artifacts: { summary: reason } })
      this.pump()
      return true
    }
    const slot = this.active.get(ticket)
    if (!slot) return false
    slot.stopping = true
    if (slot.handle) await slot.handle.stop(reason)
    else slot.interrupt()
    await slot.done
    return true
  }

  /**
   * Queues one Ticket and resolves when its worker ended, however it ended.
   * A Ticket already queued or running is refused: two workers writing one directory is the failure this prevents.
   */
  submit(spec: WorkerSpec): Promise<WorkerOutcome> {
    if (this.closed) return Promise.reject(new Error('池已关闭，不再接新工单。'))
    if (this.active.has(spec.ticket) || this.queue.some(item => item.spec.ticket === spec.ticket)) {
      return Promise.reject(new Error(`工单 ${spec.ticket} 已在本池中，不重复派工。`))
    }
    return new Promise<WorkerOutcome>((resolve) => {
      const queuedAt = new Date().toISOString()
      const runtime = (spec.runtime ?? this.options.choose?.(spec) ?? this.options.runtimes[0]?.name ?? 'dsh') as RuntimeName
      const record: WorkerRecord = { ticket: spec.ticket, runtime, state: 'queued', directory: spec.directory, queuedAt,
        rootSessionId: spec.rootSessionId, parentTicketId: spec.parentTicketId, workspaceId: spec.workspaceId,
        ...(spec.ownerSessionId ? { ownerSessionId: spec.ownerSessionId } : {}) }
      // Persist while waiting, not only when a process finally gets its slot.
      const saved = this.ready.then(() => this.table.write(record))
      void saved.catch(() => {})
      this.queue.push({ spec, record, saved, resolve })
      this.pump()
    })
  }

  /** Stops every running worker and drops what waits. */
  async close(reason = 'pool closed'): Promise<void> {
    this.closed = true
    await Promise.all([...this.queue.map(item => item.spec.ticket), ...this.active.keys()].map(ticket => this.stop(ticket, reason)))
  }

  private launching = false

  /**
   * Starts queued Tickets in submission order, one start at a time.
   *
   * Starting is serialized even though running is not: a start costs a few file writes and a spawn, and letting
   * several interleave makes the order Tickets begin depend on disk timing. Concurrency belongs to the workers, not
   * to the bookkeeping that launches them.
   */
  private pump(): void {
    if (this.launching || this.closed) return
    this.launching = true
    void this.drain().finally(() => { this.launching = false; if (!this.closed && this.queue.length && this.active.size < this.options.maxWorkers) this.pump() })
  }

  private async drain(): Promise<void> {
    await this.ready
    while (!this.closed && this.active.size < this.options.maxWorkers && this.queue.length) {
      const job = this.queue.shift()!
      await new Promise<void>(resolve => { void this.run(job, resolve) })
    }
  }

  /** Chooses a runtime, starts the worker, and turns the process's end into one outcome. */
  private async run(job: Queued, onStarted: () => void): Promise<void> {
    const { spec } = job
    let completed!: () => void
    let interrupt!: () => void
    const interrupted = new Promise<never>((_resolve, reject) => { interrupt = () => reject(new Error('Worker startup interrupted')) })
    const record: WorkerRecord = { ...job.record, state: 'starting', startingAt: new Date().toISOString() }
    const slot: Slot = { record, stopping: false, timedOut: false, interrupt, done: new Promise<void>(resolve => { completed = resolve }) }
    this.active.set(spec.ticket, slot)
    // Name the runtime the Ticket asked for before anything starts: a start that fails must not be recorded as
    // another runtime's work, which would send a reader looking in the wrong place.
    // 工单自带的 runtime 优先级最高：调用方明确点名的 runtime 不能被 options.choose 或默认值改写。
    // 之前这里漏掉了 spec.runtime，导致 worker_start 传 dsh 时 ticket 前缀写 dsh、实际却跑了 codex。

    let settle: (exit: { code: number | null; signal: string | null }) => void = () => { /* set below */ }
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => { settle = resolve })
    let lastLine = ''

    const io: WorkerIo = {
      session: sessionId => {
        if (record.sessionId && record.sessionId !== sessionId) throw new Error('Worker changed its Session identity')
        record.sessionId = sessionId
        void this.table.write(record).then(() => this.onSession?.({ ...record })).catch(error => this.options.log?.(`Worker grouping pending: ${String(error)}`))
      },
      output: (chunk) => { lastLine = chunk.trim().split('\n').at(-1) || lastLine; record.lastActivity = new Date().toISOString() },
      exited: (code, signal) => settle({ code, signal }),
    }

    let heartbeat: ReturnType<typeof setInterval> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = async (state: WorkerState, exitCode?: number | null): Promise<WorkerOutcome> => {
      if (heartbeat) clearInterval(heartbeat)
      if (timeout) clearTimeout(timeout)
      record.state = state
      record.endedAt = new Date().toISOString()
      record.exitCode = exitCode
      record.detail ??= lastLine || undefined
      await this.table.write(record).catch(() => { /* 记录写不进去不改变结果 */ })
      if (record.sessionId) await this.onSession?.({ ...record }).catch(error => this.options.log?.(`Worker grouping pending: ${String(error)}`))
      this.active.delete(spec.ticket)
      this.pump()
      const artifacts = await slot.handle?.artifacts().catch(() => ({ summary: record.detail || lastLine })) ?? { summary: record.detail || lastLine }
      completed()
      return { ticket: spec.ticket, runtime: record.runtime, state, queuedAt: record.queuedAt, startedAt: record.startedAt, endedAt: record.endedAt, exitCode, artifacts }
    }

    try {
      // Include availability checks and runtime startup in the wall-clock deadline.
      timeout = setTimeout(() => {
        slot.timedOut = true
        this.options.log?.(`工单 ${spec.ticket} 超过 ${spec.timeoutMs ?? this.options.defaultTimeoutMs}ms，停止 worker。`)
        if (slot.handle) void slot.handle.stop('timeout').finally(() => settle({ code: null, signal: null })).catch(() => {})
        else slot.interrupt()
      }, spec.timeoutMs ?? this.options.defaultTimeoutMs)
      const launch = async () => {
        await job.saved
        if (slot.stopping || slot.timedOut) throw new Error('Worker startup interrupted')
        await this.table.write(record)
        const runtime = await this.chooseRuntime(spec)
        if (slot.stopping || slot.timedOut) throw new Error('Worker startup interrupted')
        record.runtime = runtime.name
        const handle = await runtime.start(spec, io)
        // A slow start may resolve after cancellation or timeout released its slot.
        if (slot.stopping || slot.timedOut) { await handle.stop('startup cancelled'); throw new Error('Worker startup interrupted') }
        slot.handle = handle
        return handle
      }
      const handle = await Promise.race([launch(), interrupted])
      record.pid = handle.pid
      record.state = 'running'
      record.startedAt = record.lastActivity = new Date().toISOString()
      await this.table.write(record)
      // The slot is taken and the process exists: the next queued Ticket may start.
      onStarted()
      heartbeat = setInterval(() => { void this.table.write({ ...record, state: record.state }).catch(() => { /* 面板读不到而已 */ }) }, this.options.heartbeatMs)

      const exit = await exited
      const state: WorkerState = slot.timedOut ? 'timeout' : slot.stopping ? 'stopped' : exit.code === 0 ? 'finished' : 'failed'
      job.resolve(await finish(state, exit.code))
    } catch (error) {
      record.detail = error instanceof Error ? error.message : String(error)
      record.state = 'failed'
      // A start that failed never took a slot for long: release the queue even though no process exists.
      onStarted()
      job.resolve(await finish(slot.timedOut ? 'timeout' : slot.stopping ? 'stopped' : 'failed', null))
    }
  }

  private async chooseRuntime(spec: WorkerSpec): Promise<WorkerRuntime> {
    const wanted = spec.runtime ?? this.options.choose?.(spec)
    const candidates = wanted ? this.options.runtimes.filter(runtime => runtime.name === wanted) : this.options.runtimes
    for (const runtime of candidates) if (await runtime.available()) return runtime
    throw new Error(`没有可用的 runtime：${wanted ?? this.options.runtimes.map(item => item.name).join(', ')}`)
  }
}
