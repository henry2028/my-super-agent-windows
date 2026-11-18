/** Tests for the worker pool: order, slots, timeouts, records, and the end of a worker as one outcome. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkerPool } from '../src/pool/pool.ts'
import { WorkerTable } from '../src/pool/table.ts'
import type { WorkerHandle, WorkerIo, WorkerRuntime, WorkerSpec } from '../src/pool/types.ts'

/** A runtime whose workers end only when the test says so, recording the order they started in. */
function controllable() {
  const started: string[] = []
  const exits = new Map<string, (code: number | null) => void>()
  /** Tickets asked to end before they started; a queued Ticket ends the moment it is started. */
  const early = new Map<string, number | null>()
  let running = 0
  let peak = 0
  const runtime: WorkerRuntime = {
    name: 'dsh',
    async available() { return true },
    async start(spec: WorkerSpec, io: WorkerIo): Promise<WorkerHandle> {
      started.push(spec.ticket)
      running += 1
      peak = Math.max(peak, running)
      const finished = new Promise<void>(resolve => {
        exits.set(spec.ticket, code => { running -= 1; io.exited(code, null); resolve() })
        if (early.has(spec.ticket)) { const code = early.get(spec.ticket)!; early.delete(spec.ticket); exits.get(spec.ticket)?.(code) }
      })
      let ended = false
      return {
        ticket: spec.ticket,
        runtime: 'dsh',
        pid: 1000 + started.length,
        async post(): Promise<void> { throw new Error('no channel') },
        async status() { return { state: ended ? 'finished' : 'running' } as const },
        async stop(): Promise<void> { if (!ended) { ended = true; exits.get(spec.ticket)?.(null) } await finished },
        async artifacts() { return { summary: `done ${spec.ticket}` } },
      }
    },
  }
  return {
    runtime, started,
    end: (ticket: string, code: number | null = 0) => {
      const end = exits.get(ticket)
      // A Ticket still queued has no process to end yet; remember it and end it as soon as it starts.
      if (end) end(code)
      else early.set(ticket, code)
    },
    peak: () => peak,
  }
}

let stateDir: string
const spec = (ticket: string): WorkerSpec => ({ ticket, directory: join(stateDir, ticket), prompt: `do ${ticket}` })

beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'pool-')) })
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

describe('worker pool', () => {
  it('retains ownership across heartbeats, exit and reloading the process table', async () => {
    const fake = controllable()
    const pool = new WorkerPool({ stateDir, runtimes: [fake.runtime], heartbeatMs: 5 })
    try {
      const done = pool.submit({ ...spec('owned'), ownerSessionId: 'requester', rootSessionId: 'main-a',
        parentTicketId: 'order-a', workspaceId: 'old-project' })
      await expect.poll(() => fake.started.length).toBe(1)
      await pool.assign('owned', { workspaceId: 'chosen-project', sessionId: 'real-session' })
      await expect.poll(async () => (await pool.records())[0]?.state).toBe('running')
      fake.end('owned', 0)
      await done
      expect(await new WorkerTable(stateDir).read('owned')).toMatchObject({ ownerSessionId: 'requester',
        rootSessionId: 'main-a', parentTicketId: 'order-a', workspaceId: 'chosen-project', sessionId: 'real-session', state: 'finished' })
    } finally { await pool.close() }
  })
  it('returns the actual startup error when no process handle was created', async () => {
    const runtime: WorkerRuntime = { name: 'codex', available: async () => true,
      start: async () => { throw new Error('Codex model catalog is missing') } }
    const pool = new WorkerPool({ stateDir, runtimes: [runtime] })
    try {
      const outcome = await pool.submit(spec('missing-catalog'))
      expect(outcome.state).toBe('failed')
      expect(outcome.artifacts.summary).toBe('Codex model catalog is missing')
    } finally { await pool.close() }
  })
  it('persists queued time and cancels a waiting ticket without starting it', async () => {
    const fake = controllable()
    const pool = new WorkerPool({ stateDir, runtimes: [fake.runtime], maxWorkers: 1 })
    const first = pool.submit(spec('first'))
    await expect.poll(() => fake.started.length).toBe(1)
    const waiting = pool.submit(spec('waiting'))
    expect((await pool.records()).find(row => row.ticket === 'waiting')).toMatchObject({ state: 'queued', queuedAt: expect.any(String) })
    expect(await pool.stop('waiting')).toBe(true)
    expect(await waiting).toMatchObject({ state: 'stopped', queuedAt: expect.any(String) })
    expect((await waiting).startedAt).toBeUndefined()
    fake.end('first'); await first
    expect(fake.started).toEqual(['first'])
    await pool.close()
  })

  it('bounds startup time and lets later tickets use the freed slot', async () => {
    const fake = controllable()
    const base = fake.runtime.start
    let release!: () => void
    const late = new Promise<void>(resolve => { release = resolve })
    fake.runtime.start = async (spec, io) => { if (spec.ticket === 'slow-start') await late; return base(spec, io) }
    const pool = new WorkerPool({ stateDir, runtimes: [fake.runtime], maxWorkers: 1 })
    const slow = pool.submit({ ...spec('slow-start'), timeoutMs: 100 })
    const next = pool.submit(spec('next'))
    expect((await slow).state).toBe('timeout')
    await expect.poll(() => fake.started).toEqual(['next'])
    release()
    await expect.poll(async () => (await pool.records()).find(row => row.ticket === 'slow-start')?.state).toBe('timeout')
    fake.end('next'); await next; await pool.close()
    expect((await pool.records()).find(row => row.ticket === 'slow-start')?.state).toBe('timeout')
  })

  it('stops a starting ticket and does not spawn after its availability check returns', async () => {
    const fake = controllable()
    let release!: () => void
    fake.runtime.available = () => new Promise(resolve => { release = () => resolve(true) })
    const pool = new WorkerPool({ stateDir, runtimes: [fake.runtime], maxWorkers: 1 })
    const result = pool.submit(spec('starting'))
    await expect.poll(() => typeof release).toBe('function')
    expect(await pool.stop('starting')).toBe(true)
    expect((await result).state).toBe('stopped')
    release(); await new Promise(resolve => setTimeout(resolve, 20))
    expect(fake.started).toEqual([])
    await pool.close()
  })

  it('does not leave interrupted queued records looking runnable after a restart', async () => {
    await new WorkerTable(stateDir).write({ ticket: 'old-queue', runtime: 'claude', state: 'queued', directory: stateDir })
    const pool = new WorkerPool({ stateDir, runtimes: [] })
    expect((await pool.records()).find(row => row.ticket === 'old-queue')).toMatchObject({ state: 'failed', endedAt: expect.any(String) })
    await pool.close()
  })

  it('records an explicit stop as stopped rather than failed', async () => {
    const fake = controllable()
    const pool = new WorkerPool({ stateDir, runtimes: [fake.runtime] })
    const outcome = pool.submit(spec('cancel'))
    await expect.poll(() => fake.started.length).toBe(1)
    expect(await pool.stop('cancel')).toBe(true)
    expect((await outcome).state).toBe('stopped')
    expect(await pool.stop('missing')).toBe(false)
    await pool.close()
  })
  it('starts queued Tickets in submission order', async () => {
    const fake = controllable()
    const pool = new WorkerPool({ stateDir, runtimes: [fake.runtime], maxWorkers: 2 })
    const all = ['t1', 't2', 't3', 't4'].map(ticket => pool.submit(spec(ticket)))
    await expect.poll(() => fake.started.length).toBe(2)
    // 只有两个槽，先起的两个必须是先交的两个。
    expect(fake.started).toEqual(['t1', 't2'])
    expect(pool.waiting).toEqual(['t3', 't4'])
    for (const ticket of ['t1', 't2', 't3', 't4']) { fake.end(ticket); await new Promise(resolve => setTimeout(resolve, 0)) }
    await expect.poll(() => fake.started).toEqual(['t1', 't2', 't3', 't4'])
    expect((await Promise.all(all)).map(outcome => outcome.state)).toEqual(['finished', 'finished', 'finished', 'finished'])
  })

  it('never runs more workers than the slots allow', async () => {
    const fake = controllable()
    const pool = new WorkerPool({ stateDir, runtimes: [fake.runtime], maxWorkers: 2 })
    const all = ['a', 'b', 'c', 'd', 'e'].map(ticket => pool.submit(spec(ticket)))
    await expect.poll(() => fake.started.length).toBe(2)
    expect(fake.peak()).toBe(2)
    for (const ticket of ['a', 'b', 'c', 'd', 'e']) { fake.end(ticket); await new Promise(resolve => setTimeout(resolve, 0)) }
    await Promise.all(all)
    expect(fake.peak()).toBe(2)
  })

  it('stops a worker that outlives its timeout and says so', async () => {
    const fake = controllable()
    const pool = new WorkerPool({ stateDir, runtimes: [fake.runtime], maxWorkers: 1, defaultTimeoutMs: 30 })
    const outcome = await pool.submit(spec('slow'))
    expect(outcome.state).toBe('timeout')
    expect((await pool.records())[0]?.state).toBe('timeout')
  })

  it('reports a non-zero exit as failed and keeps the summary the runtime produced', async () => {
    const fake = controllable()
    const pool = new WorkerPool({ stateDir, runtimes: [fake.runtime], maxWorkers: 1 })
    const running = pool.submit(spec('bad'))
    await new Promise(resolve => setTimeout(resolve, 0))
    fake.end('bad', 2)
    const outcome = await running
    expect(outcome.state).toBe('failed')
    expect(outcome.exitCode).toBe(2)
    expect(outcome.artifacts.summary).toBe('done bad')
  })

  it('refuses a Ticket that is already queued or running', async () => {
    const fake = controllable()
    const pool = new WorkerPool({ stateDir, runtimes: [fake.runtime], maxWorkers: 2 })
    const first = pool.submit(spec('t1'))
    await expect(pool.submit(spec('t1'))).rejects.toThrow(/已在本池中/)
    fake.end('t1')
    await first
  })

  it('writes one record per Ticket with its pid and final state', async () => {
    const fake = controllable()
    const pool = new WorkerPool({ stateDir, runtimes: [fake.runtime], maxWorkers: 1 })
    const running = pool.submit(spec('t1'))
    await new Promise(resolve => setTimeout(resolve, 0))
    fake.end('t1')
    await running
    const record = JSON.parse(readFileSync(join(stateDir, 'pool', 'processes', 't1.json'), 'utf8'))
    expect(record).toMatchObject({ ticket: 't1', runtime: 'dsh', state: 'finished', exitCode: 0 })
    expect(record.pid).toBeGreaterThan(0)
    expect(record.endedAt).toBeTruthy()
  })

  it('closes by stopping every running worker', async () => {
    const fake = controllable()
    const pool = new WorkerPool({ stateDir, runtimes: [fake.runtime], maxWorkers: 2 })
    const first = pool.submit(spec('t1'))
    const second = pool.submit(spec('t2'))
    await expect.poll(() => fake.started.length).toBe(2)
    await pool.close('test')
    expect((await Promise.all([first, second])).every(outcome => outcome.state === 'stopped')).toBe(true)
  })

  it('marks a record whose worker process is gone as failed', async () => {
    const fake = controllable()
    const pool = new WorkerPool({ stateDir, runtimes: [fake.runtime], maxWorkers: 1 })
    // The constructor reconciles once already; wait for it so this write is not the one it reaps.
    await new Promise(resolve => setTimeout(resolve, 20))
    await new WorkerTable(stateDir).write({ ticket: 'ghost', runtime: 'codex', state: 'running', directory: stateDir, pid: 999_999 })
    const reaped = await pool.reconcile()
    expect(reaped).toContain('ghost')
    const record = (await pool.records()).find(item => item.ticket === 'ghost')
    expect(record?.state).toBe('failed')
    expect(record?.detail).toMatch(/gone|restarted/)
  })

  it('leaves a record alone while its process still answers', async () => {
    const fake = controllable()
    const pool = new WorkerPool({ stateDir, runtimes: [fake.runtime], maxWorkers: 1 })
    await new Promise(resolve => setTimeout(resolve, 20))
    // This test process is alive, so a record naming it must survive a reconcile untouched.
    await new WorkerTable(stateDir).write({ ticket: 'alive', runtime: 'codex', state: 'running', directory: stateDir, pid: process.pid })
    expect(await pool.reconcile()).toEqual([])
    expect((await pool.records()).find(item => item.ticket === 'alive')?.state).toBe('running')
  })
})
