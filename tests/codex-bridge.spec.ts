/** 委派工具契约：非阻塞派工、目录独占、runtime 选择、并发排队、持久结果与通知。 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

// vi.mock 的工厂会被提升到文件顶部，所以假 runtime 必须整体放进 vi.hoisted 里，不能引用外层变量。
const fake = vi.hoisted(() => {
  const ends = new Map<string, () => void>()
  const starts: string[] = []
  const envs: Record<string, string>[] = []
  const runtime = (name: 'codex' | 'dsh' | 'claude') => () => ({
    name,
    available: async () => true,
    start: async (spec: any, io: any) => {
      starts.push(`${name}:${spec.ticket}`)
      if (spec.env) envs.push(spec.env)
      ends.set(spec.ticket, () => io.exited(0, null))
      return { ticket: spec.ticket, runtime: name, pid: 123, status: async () => ({ state: 'running' }),
        stop: async () => io.exited(null, null), artifacts: async () => ({ summary: `${name} did it` }) }
    },
  })
  return { ends, starts, envs, codex: vi.fn(runtime('codex')), dsh: runtime('dsh'), claude: runtime('claude') }
})
vi.mock('../src/pool/codex.ts', () => ({ codexRuntime: fake.codex }))
vi.mock('../src/pool/claude.ts', () => ({ claudeRuntime: fake.claude }))
vi.mock('../src/pool/dsh.ts', () => ({ dshRuntime: fake.dsh }))
import { installWorkers } from '../src/pool/bridge.ts'

/** 装一套桥与假 ctx，返回工具表、发起会话与清理函数。 */
const harness = (directory: string, options: Record<string, unknown> = {}) => {
  // 每个用例从干净的假进程表开始：上一用例的 worker 已在 finally 里结束。
  fake.starts.length = 0; fake.ends.clear(); fake.envs.length = 0
  const tools = new Map<string, any>(); let dispose: (() => Promise<void>) | undefined
  const agent = { id: 'a', followup: vi.fn() }
  const ctx = { tools: { register: (tool: any) => tools.set(tool.name, tool) },
    agents: { get: () => agent }, effect: (setup: any) => { dispose = setup() }, logger: { error: vi.fn() } }
  const pool = installWorkers(ctx as any, directory, options as any)
  return { tools, agent, ctx, pool, cleanup: async () => { await dispose?.() } }
}

it('scopes status and stop to the requesting tree, including after reading persisted records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-ownership-'))
  const { tools, agent, pool, ctx, cleanup } = harness(directory)
  const owners: Record<string, any> = {
    a: { ownerSessionId: 'a', rootSessionId: 'main-a', parentTicketId: 'order-a', workspaceId: 'project-a' },
    b: { ownerSessionId: 'b', rootSessionId: 'main-b', parentTicketId: 'order-b', workspaceId: 'project-b' },
    sibling: { ownerSessionId: 'sibling', rootSessionId: 'main-a', parentTicketId: 'different-order' },
    'main-a': { ownerSessionId: 'main-a', rootSessionId: 'main-a' },
  }
  Object.assign(ctx, { orchestrator: { sessions: { processOwner: async (id: string) => owners[id] } } })
  try {
    const started = await tools.get('worker_start').execute({ directory, prompt: 'work', runtime: 'claude' }, { agent })
    expect(started).toMatchObject(owners.a)
    await expect.poll(async () => (await pool.records())[0]?.rootSessionId).toBe('main-a')
    for (const id of ['b', 'sibling']) {
      expect(await tools.get('worker_status').execute({}, { agent: { id } })).toEqual({ workers: [], queued: [] })
      await expect(tools.get('worker_status').execute({ ticket: started.ticket }, { agent: { id } })).rejects.toThrow('another Session')
      await expect(tools.get('worker_stop').execute({ ticket: started.ticket }, { agent: { id } })).rejects.toThrow('another Session')
    }
    expect((await tools.get('worker_status').execute({}, { agent: { id: 'main-a' } })).workers).toHaveLength(1)
    await expect.poll(() => fake.ends.get(started.ticket)).toBeTypeOf('function')
    fake.ends.get(started.ticket)!()
    await expect.poll(async () => (await tools.get('worker_status').execute({ ticket: started.ticket }, { agent })).record.state).toBe('finished')
  } finally { await cleanup(); await rm(directory, { recursive: true, force: true }) }
})

it('passes persistent Codex connection settings into the native worker runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-settings-'))
  const { cleanup } = harness(directory, { codexProxyUrl: 'http://127.0.0.1:7890', codexHttps: true,
    codexModelCatalog: '/models/current.json', codexConnectTimeoutMs: 12000 })
  try {
    expect(fake.codex).toHaveBeenLastCalledWith({ proxyUrl: 'http://127.0.0.1:7890', https: true,
      modelCatalog: '/models/current.json', connectTimeoutMs: 12000 })
  } finally { await cleanup(); await rm(directory, { recursive: true, force: true }) }
})

it('returns a ticket immediately and later delivers and persists the final result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-bridge-'))
  const { tools, agent, cleanup } = harness(directory)
  try {
    const started = await tools.get('worker_start').execute({ directory, prompt: 'fix it' }, { agent })
    expect(started.ticket).toMatch(/^codex-/)
    expect(started.runtime).toBe('codex')
    await expect(tools.get('worker_start').execute({ directory, prompt: 'overlap' }, { agent })).rejects.toThrow(/already owns/)
    await expect.poll(() => fake.ends.get(started.ticket)).toBeTypeOf('function')
    fake.ends.get(started.ticket)!()
    await expect.poll(() => agent.followup.mock.calls.length).toBe(1)
    const result = await tools.get('worker_status').execute({ ticket: started.ticket })
    expect(result).toMatchObject({ state: 'finished', artifacts: { summary: 'codex did it' } })
    await expect(tools.get('worker_status').execute({ ticket: '../../secret' })).rejects.toThrow('Invalid ticket')
  } finally { await cleanup(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }) }
})

it('passes the model key from the credentials file to a dsh worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-bridge-'))
  const credentials = join(directory, '.credentials.yaml')
  await writeFile(credentials, 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-test-key\n', 'utf8')
  const { tools, agent, cleanup } = harness(directory, { codex: false, credentialsFile: credentials })
  try {
    const started = await tools.get('worker_start').execute({ directory, prompt: 'run tests' }, { agent })
    await expect.poll(() => fake.ends.get(started.ticket)).toBeTypeOf('function')
    // dsh worker 是独立进程，只能靠环境变量拿到模型 key。
    expect(fake.envs.at(-1)).toEqual({ DEEPSEEK_API_KEY: 'sk-test-key' })
    fake.ends.get(started.ticket)!()
  } finally { await cleanup(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }) }
})

it('picks the dsh runtime when Codex is disabled, and rejects an unknown runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-bridge-'))
  const { tools, agent, cleanup } = harness(directory, { codex: false })
  try {
    const started = await tools.get('worker_start').execute({ directory, prompt: 'run tests' }, { agent })
    expect(started.ticket).toMatch(/^dsh-/)
    expect(started.runtime).toBe('dsh')
    await expect(tools.get('worker_start').execute({ directory, prompt: 'x', runtime: 'python' }, { agent }))
      .rejects.toThrow(/Unknown or disabled worker runtime/)
    await expect.poll(() => fake.ends.get(started.ticket)).toBeTypeOf('function')
    fake.ends.get(started.ticket)!()
  } finally { await cleanup(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }) }
})

it('queues the second worker until a slot frees, then starts it', async () => {
  const first = await mkdtemp(join(tmpdir(), 'worker-pool-a-'))
  const second = await mkdtemp(join(tmpdir(), 'worker-pool-b-'))
  const { tools, agent, cleanup } = harness(first, { codex: false, maxWorkers: 1 })
  try {
    const a = await tools.get('worker_start').execute({ directory: first, prompt: 'a' }, { agent })
    const b = await tools.get('worker_start').execute({ directory: second, prompt: 'b' }, { agent })
    // 只有一个槽位：第二张票必须排在队里，直到第一张结束。
    await expect.poll(() => fake.starts.length).toBe(1)
    await expect(tools.get('worker_status').execute({})).resolves.toMatchObject({ queued: [b.ticket] })
    await expect.poll(() => fake.ends.get(a.ticket)).toBeTypeOf('function')
    fake.ends.get(a.ticket)!()
    await expect.poll(() => fake.starts.length).toBe(2)
    await expect.poll(() => fake.ends.get(b.ticket)).toBeTypeOf('function')
    fake.ends.get(b.ticket)!()
    await expect.poll(async () => (await tools.get('worker_status').execute({ ticket: b.ticket })).state).toBe('finished')
  } finally { await cleanup(); await rm(first, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }); await rm(second, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }) }
})
it('routes Claude Code through the same status, completion and stop tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-bridge-'))
  const { tools, agent, cleanup } = harness(directory)
  try {
    const started = await tools.get('worker_start').execute({ directory, prompt: 'fix it', runtime: 'claude' }, { agent })
    expect(started.ticket).toMatch(/^claude-/)
    expect(started.runtime).toBe('claude')
    await expect.poll(() => fake.ends.get(started.ticket)).toBeTypeOf('function')
    expect(fake.starts).toEqual([`claude:${started.ticket}`])
    fake.ends.get(started.ticket)!()
    await expect.poll(() => agent.followup.mock.calls.length).toBe(1)
    expect(await tools.get('worker_status').execute({ ticket: started.ticket })).toMatchObject({ state: 'finished', runtime: 'claude', artifacts: { summary: 'claude did it' } })
    const stopped = await tools.get('worker_start').execute({ directory, prompt: 'cancel', runtime: 'claude' }, { agent })
    await expect.poll(() => fake.ends.get(stopped.ticket)).toBeTypeOf('function')
    await expect.poll(async () => {
      try { return await tools.get('worker_stop').execute({ ticket: stopped.ticket }) } catch { return undefined }
    }).toMatchObject({ stopped: true })
    await expect.poll(async () => (await tools.get('worker_status').execute({ ticket: stopped.ticket })).state).toBe('stopped')
  } finally { await cleanup(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }) }
})

it('reserves a directory atomically when worker_start calls arrive together', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-race-'))
  const { tools, agent, cleanup } = harness(directory)
  try {
    const calls = await Promise.allSettled([1, 2].map(() => tools.get('worker_start').execute({ directory, prompt: 'same workspace' }, { agent })))
    expect(calls.filter(call => call.status === 'fulfilled')).toHaveLength(1)
    expect(calls.filter(call => call.status === 'rejected')).toHaveLength(1)
  } finally { await cleanup(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }) }
})
