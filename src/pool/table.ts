/**
 * The pool's record of every worker it started, written where a restarted host can still read it.
 *
 * One JSON file per Ticket, replaced atomically: a half-written record would make a panel or a recovery pass
 * believe a worker is in a state it never reached.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeName, WorkerState, WorkerOwnership } from './types.ts'

export interface WorkerRecord extends WorkerOwnership {
  ticket: string
  runtime: RuntimeName
  state: WorkerState
  /** Working directory the worker owns. */
  directory: string
  pid?: number
  /** ISO timestamps. */
  startedAt?: string
  queuedAt?: string
  startingAt?: string
  ownerSessionId?: string
  sessionId?: string
  endedAt?: string
  exitCode?: number | null
  /** Last sign of life, for the panel; a worker quiet for a long time is worth a look. */
  lastActivity?: string
  detail?: string
}

/** Durable per-ticket process records, replaced atomically. */
export class WorkerTable {
  private readonly root: string
  private readonly writes = new Map<string, Promise<void>>()
  constructor(stateDir: string) { this.root = join(stateDir, 'pool', 'processes') }

  private file(ticket: string): string { return join(this.root, `${ticket.replaceAll(/[^A-Za-z0-9_.-]/g, '_')}.json`) }

  write(record: WorkerRecord): Promise<void> {
    // A slow heartbeat must never overwrite a newer terminal state.
    const snapshot = { ...record }
    const writing = (this.writes.get(record.ticket) ?? Promise.resolve()).catch(() => {}).then(() => this.replace(snapshot))
    this.writes.set(record.ticket, writing)
    void writing.finally(() => { if (this.writes.get(record.ticket) === writing) this.writes.delete(record.ticket) }).catch(() => {})
    return writing
  }

  private async replace(record: WorkerRecord): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const file = this.file(record.ticket)
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', 'utf8')
    await rename(temporary, file)
  }

  async read(ticket: string): Promise<WorkerRecord | undefined> {
    try { return JSON.parse(await readFile(this.file(ticket), 'utf8')) as WorkerRecord } catch { return undefined }
  }

  async list(): Promise<WorkerRecord[]> {
    await Promise.allSettled([...this.writes.values()])
    const names = await readdir(this.root).catch(() => [] as string[])
    const records: WorkerRecord[] = []
    for (const name of names.filter(name => name.endsWith('.json'))) {
      try { records.push(JSON.parse(await readFile(join(this.root, name), 'utf8')) as WorkerRecord) } catch { /* A record being replaced; the next pass sees it. */ }
    }
    return records.sort((a, b) => a.ticket.localeCompare(b.ticket))
  }

  async remove(ticket: string): Promise<void> { await rm(this.file(ticket), { force: true }) }
}
