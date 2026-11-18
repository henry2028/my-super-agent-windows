/** 进程执行器：一票一进程、回执决定状态、进程结束时接住攒下的跟话。 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ProcessExecutor } from '../src/executor/process.ts'

const fake = vi.hoisted(() => ({
  specs: [] as any[],
  ends: new Map<string, (code?: number) => void>(),
  runtime: {
    name: 'dsh',
    available: async () => true,
    start: async (spec: any, io: any) => {
      fake.specs.push(spec)
      fake.ends.set(spec.ticket, (code = 0) => io.exited(code, null))
      return { ticket: spec.ticket, runtime: 'dsh', pid: 4242, status: async () => ({ state: 'running' }),
        stop: async () => io.exited(null, null), artifacts: async () => ({ summary: 'from process' }) }
    },
  },
}))

/** 只实现执行器用到的那部分宿主。 */
const harness = async (report: string | undefined) => {
  // 每个用例从干净的假进程表开始：上一用例的 worker 已在 finally 里关掉。
  fake.specs.length = 0; fake.ends.clear()
  const stateDir = await mkdtemp(join(tmpdir(), 'process-executor-'))
  const directory = join(stateDir, 'work', 't1')
  const settings = { executor: { workerTimeoutMinutes: 30, workerProfile: 'headless', prepare: '', directory: '', blockedCommands: [], model: null, mode: 'process' } }
  let ticket: any = {
    id: 't1', title: '修一个 typo', ended: undefined, undelivered: [], inputs: [],
    assignments: [{ id: 'as-1', state: 'running', startedAt: '2026-11-07T00:00:00.000Z' }],
    execution: { directory, assignment: '把 README 里的错字改掉' },
  }
  const reports: any[] = []
  const engine = {
    assignmentStarted: vi.fn(), inputsDelivered: vi.fn(), inputsRead: vi.fn(),
    report: vi.fn((_id: string, value: any) => { reports.push(value) }),
  }
  const subprocess = { spawn: () => ({ done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } } }) }
  const host = {
    context: { logger: { info: () => {}, warn: () => {}, error: () => {} }, subprocess },
    engine, store: { tickets: { get: () => ticket }, settings: () => settings, atomic: (work: () => void) => work() },
    machine: { stateDir, maxWorkers: 2 }, closing: () => false, paused: () => false,
    lifetime: new AbortController().signal, environment: () => [],
  }
  const executor = new ProcessExecutor(host as never, { runtimes: [fake.runtime as never] })
  const writeReport = async (text: string) => { await mkdir(join(directory, '.superagent'), { recursive: true }); await writeFile(join(directory, '.superagent', 'report.md'), text, 'utf8') }
  return { executor, engine, reports, directory, stateDir, writeReport, ticketOf: () => ticket, setTicket: (next: any) => { ticket = next } }
}

it('starts one process per ticket and reports what the report file says', async () => {
  const h = await harness(undefined)
  try {
    h.executor.start(h.ticketOf(), h.ticketOf().assignments[0])
    await expect.poll(() => fake.specs.length).toBe(1)
    expect(fake.specs[0]).toMatchObject({ ticket: 't1', directory: h.directory, runtime: 'dsh' })
    expect(fake.specs[0].prompt).toContain('把 README 里的错字改掉')
    expect(h.engine.assignmentStarted).toHaveBeenCalledWith('t1', 'as-1')
    await h.writeReport('waiting\n错字已改，跑过 tsc')
    fake.ends.get('t1')!(0)
    await expect.poll(() => h.reports.length).toBe(1)
    expect(h.reports[0]).toMatchObject({ state: 'waiting', summary: '错字已改，跑过 tsc' })
  } finally {
    await h.executor.shutdown()
    await rm(h.stateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
  }
})

it('reports failed when the process fails, whatever the file says', async () => {
  const h = await harness(undefined)
  try {
    h.executor.start(h.ticketOf(), h.ticketOf().assignments[0])
    await expect.poll(() => fake.specs.length).toBe(1)
    await h.writeReport('waiting\n其实没做完')
    fake.ends.get('t1')!(1)
    await expect.poll(() => h.reports.length).toBe(1)
    expect(h.reports[0].state).toBe('failed')
  } finally {
    await h.executor.shutdown()
    await rm(h.stateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
  }
})

it('queues a person follow-up for the next process instead of pretending to steer', async () => {
  const h = await harness(undefined)
  try {
    const ticket = h.ticketOf()
    h.executor.start(ticket, ticket.assignments[0])
    await expect.poll(() => fake.specs.length).toBe(1)
    // 进程在跑时人补了一句话：记为已投递、已读，等这一轮结束再起一个进程接着做。
    const withInput = { ...ticket, undelivered: ['in-1'], inputs: [{ id: 'in-1', kind: 'text', text: '顺便把标题也改一下' }] }
    h.setTicket(withInput)
    h.executor.deliver(withInput, withInput.assignments[0])
    expect(h.engine.inputsDelivered).toHaveBeenCalledWith('t1', 'as-1', ['in-1'])
    expect(h.engine.inputsRead).toHaveBeenCalledWith('t1', ['in-1'])
    await h.writeReport('waiting\n先做完了第一件')
    fake.ends.get('t1')!(0)
    await expect.poll(() => fake.specs.length).toBe(2)
  } finally {
    await h.executor.shutdown()
    await rm(h.stateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
  }
})
