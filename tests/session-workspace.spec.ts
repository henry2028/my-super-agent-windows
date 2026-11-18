import { describe, expect, it, vi } from 'vitest'
import { SessionWorkspace, legacyProcessSession } from '../src/app/session-workspace.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

describe('Super-agent workspace', () => {
  it('only migrates a uniquely attributable old process session, refusing shared-cwd ambiguity', () => {
    const record = { ticket: 'dsh-old', runtime: 'dsh' as const, state: 'finished' as const, directory: '/same',
      ownerSessionId: 'owner', startedAt: new Date(1000).toISOString(), endedAt: new Date(2000).toISOString() }
    const headers = [{ id: 'session-exact', cwd: '/same', createdAt: 1500 }, { id: 'session-old', cwd: '/same', createdAt: 500 }]
    expect(legacyProcessSession(record, headers, new Set())).toBe('session-exact')
    expect(legacyProcessSession(record, [...headers, { id: 'session-other', cwd: '/same', createdAt: 1600 }], new Set())).toBeUndefined()
    expect(legacyProcessSession(record, headers, new Set(['session-exact']))).toBeUndefined()
    expect(legacyProcessSession({ ...record, endedAt: undefined }, headers, new Set())).toBeUndefined()
    expect(legacyProcessSession({ ...record, runtime: 'codex' }, headers, new Set())).toBeUndefined()
  })
  it('uses one display workspace for main and workers without passing execution directories', async () => {
    const registry = { create: vi.fn(async () => ({ id: 'common' })), groupSession: vi.fn(async (_workspace: string, _session: string) => {}) }
    const groups = new SessionWorkspace(registry, '/state/superagent')
    await Promise.all(['main', 'worker-a', 'worker-b'].map(id => groups.attach(id)))
    expect(registry.create).toHaveBeenCalledExactlyOnceWith('/state/superagent', 'Super-agent')
    expect(registry.groupSession.mock.calls).toEqual([['common', 'main'], ['common', 'worker-a'], ['common', 'worker-b']])
  })

  it('includes cold historical workers and nested descendants, excluding unrelated sessions', async () => {
    const registry = { create: vi.fn(async () => ({ id: 'common' })), groupSession: vi.fn(async (_workspace: string, _session: string) => {}) }
    const groups = new SessionWorkspace(registry, '/state')
    await groups.reconcile(['main', 'worker-a'], [
      { id: 'grandchild', parentSession: 'child' }, { id: 'main' }, { id: 'unrelated' },
      { id: 'worker-a' }, { id: 'child', parentSession: 'worker-a' }, { id: 'other-child', parentSession: 'unrelated' },
    ])
    expect(registry.groupSession.mock.calls.map(call => call[1])).toEqual(['grandchild', 'main', 'worker-a', 'child'])
  })

  it('retries workspace creation after a storage failure', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue({ id: 'common' })
    const groups = new SessionWorkspace({ create, groupSession: vi.fn(async (_workspace: string, _session: string) => {}) }, '/state')
    await expect(groups.attach('main')).rejects.toThrow('storage unavailable')
    await expect(groups.attach('main')).resolves.toBeUndefined()
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('preserves a chosen workspace through historical reconciliation and nested children', async () => {
    const registry = { create: vi.fn(async () => ({ id: 'common' })), groupSession: vi.fn(async (_workspace: string, _session: string) => {}) }
    const groups = new SessionWorkspace(registry, '/state')
    await groups.reconcile(['main', 'worker-a'], [
      { id: 'child', parentSession: 'worker-a' }, { id: 'worker-a' }, { id: 'main' },
    ], id => id === 'worker-a' ? 'project' : undefined)
    expect(registry.groupSession.mock.calls).toEqual([['project', 'child'], ['project', 'worker-a'], ['common', 'main']])
  })

  it('fails clearly when the required grouping extension is absent', async () => {
    const groups = new SessionWorkspace({ create: vi.fn() }, '/state')
    await expect(groups.attach('main')).rejects.toThrow('grouping extension')
  })

  it('creates ticket sessions with their own cwd and attaches them beside the main session', async () => {
    const h = await startRuntime()
    try {
      const one = await h.acceptedTicket(feishu('1', '@bot 修复测试'))
      const create = h.controller.create.mock.calls.map(([request]) => request as unknown as Record<string, unknown>)
      expect(create.find(request => request.sessionId === one.sessionId)).toMatchObject({ cwd: one.ticket.execution!.directory })
      expect(create.find(request => request.sessionId === one.sessionId)).not.toHaveProperty('workspaceId')
      const group = (h.ctx.workspaceRegistry as unknown as { groupSession: ReturnType<typeof vi.fn> }).groupSession
      expect(group).toHaveBeenCalledWith(h.directory, h.runtime.masterId)
      expect(group).toHaveBeenCalledWith(h.directory, one.sessionId)
    } finally { await h.stop() }
  })
})
