import { expect, it, vi } from 'vitest'
import { feishu, startRuntime } from './fixtures/host.ts'
import { KV } from '../src/kv.ts'
import { WorkerPool } from '../src/pool/pool.ts'
import { WorkerTable } from '../src/pool/table.ts'

it('distinguishes independent main sessions even with the same cwd, and resolves cold descendants', async () => {
  const h = await startRuntime()
  try {
    h.ctx.sessionPersistence.list = vi.fn(async () => [
      { header: { id: 'child-a', parentSession: 'main-a' } },
      { header: { id: 'main-a', cwd: '/same' } }, { header: { id: 'main-b', cwd: '/same' } },
    ] as never)
    expect(await h.runtime.sessions.processOwner('child-a')).toMatchObject({ ownerSessionId: 'child-a', rootSessionId: 'main-a' })
    expect(await h.runtime.sessions.processOwner('main-b')).toMatchObject({ rootSessionId: 'main-b' })
    h.ctx.sessionPersistence.list = vi.fn(async () => [] as never)
    // Persisted parents remain useful when only the directly requested agent is loaded.
    expect(h.runtime.store.get(KV.sessions.parent('child-a'))).toBe('main-a')
  } finally { await h.stop() }
})

it('persists process ancestry and groups the exact child session without absorbing a cwd neighbor', async () => {
  const h = await startRuntime(undefined, directory => new WorkerPool({ stateDir: directory, runtimes: [] }))
  try {
    const one = await h.acceptedTicket(feishu('1', 'repair'))
    const table = new WorkerTable(h.directory)
    await h.runtime.workers!.records()
    h.ctx.sessionPersistence.list = vi.fn(async () => [
      { header: { id: one.sessionId, cwd: '/ticket' } },
      { header: { id: 'exact-child', cwd: '/shared' } }, { header: { id: 'unrelated', cwd: '/shared' } },
    ] as never)
    const record = { ticket: 'dsh-123', runtime: 'dsh' as const, state: 'finished' as const, directory: '/shared',
      ownerSessionId: one.sessionId, sessionId: 'exact-child', exitCode: 0 }
    await table.write(record)
    await h.runtime.sessions.attachProcess(record)
    expect(await table.read(record.ticket)).toMatchObject({ rootSessionId: h.runtime.masterId, parentTicketId: one.ticket.id })
    expect(h.runtime.store.get(KV.sessions.parent('exact-child'))).toBe(one.sessionId)
    expect(await h.runtime.sessions.processOwner('exact-child')).toMatchObject({ rootSessionId: h.runtime.masterId, parentTicketId: one.ticket.id })
    const group = (h.ctx.workspaceRegistry as unknown as { groupSession: ReturnType<typeof vi.fn> }).groupSession
    expect(group).toHaveBeenCalledWith(h.directory, 'exact-child')
    expect(group).not.toHaveBeenCalledWith(h.directory, 'unrelated')
    // Startup reconciliation can reconstruct the relationship from durable records.
    group.mockClear()
    await h.runtime.sessions.groupProcesses()
    expect(group).toHaveBeenCalledWith(h.directory, 'exact-child')
    const forged = { ...record, rootSessionId: 'other-main' }
    await expect(h.runtime.sessions.attachProcess(forged)).rejects.toThrow('mismatch')
  } finally { await h.stop() }
})

it('rejects missing owners and cyclic ownership instead of guessing from directories', async () => {
  const h = await startRuntime()
  try {
    await expect(h.runtime.sessions.processOwner('missing')).rejects.toThrow('Unknown owner')
    h.ctx.sessionPersistence.list = vi.fn(async () => [
      { header: { id: 'a', parentSession: 'b' } }, { header: { id: 'b', parentSession: 'a' } },
    ] as never)
    await expect(h.runtime.sessions.processOwner('a')).rejects.toThrow('Cyclic')
  } finally { await h.stop() }
})

it('moves one tree and its processes without changing another main session or its children', async () => {
  const h = await startRuntime(undefined, directory => new WorkerPool({ stateDir: directory, runtimes: [] }))
  try {
    await h.runtime.workers!.records()
    const table = new WorkerTable(h.directory)
    h.ctx.sessionPersistence.list = vi.fn(async () => ['main-a', 'main-b', 'child-a', 'child-b'].map(id => ({
      header: { id, cwd: '/same', ...(id === 'child-b' ? { parentSession: 'main-b' } : {}) },
    })) as never)
    const entries = [{ id: 'project-a', sessionIds: ['main-a'] }, { id: 'project-b', sessionIds: ['main-b'] }, { id: 'moved', sessionIds: [] as string[] }]
    Object.assign(h.ctx.workspaceRegistry, { list: () => entries, get: (id: string) => entries.find(entry => entry.id === id) })
    const a = { ticket: 'dsh-a', runtime: 'dsh' as const, state: 'finished' as const, directory: '/same', ownerSessionId: 'main-a', sessionId: 'child-a' }
    const b = { ...a, ticket: 'claude-b', runtime: 'claude' as const, ownerSessionId: 'child-b', sessionId: undefined }
    await table.write(a); await table.write(b)
    await h.runtime.sessions.groupProcesses()
    await h.runtime.sessions.moveWorkspace('main-a', 'moved')
    expect(await table.read('dsh-a')).toMatchObject({ rootSessionId: 'main-a', workspaceId: 'moved' })
    expect(await table.read('claude-b')).toMatchObject({ rootSessionId: 'main-b', workspaceId: 'project-b' })
    expect(h.runtime.store.get(KV.sessions.parent('child-a'))).toBe('main-a')
    expect(h.runtime.store.get(KV.sessions.parent('child-b'))).toBe('main-b')
  } finally { await h.stop() }
})
