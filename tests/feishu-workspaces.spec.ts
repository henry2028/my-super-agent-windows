import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { feishuKind, inject } from '../src/sources/feishu.ts'
import { withFeishuWorkspaces, isWorkspaceCommand } from '../src/sources/feishu-workspaces.ts'
import { wordCount } from '../src/infra/text.ts'
import { KV } from '../src/kv.ts'
import type { OutboundMessage } from '../src/core/index.ts'

let h: Host, source: ReturnType<typeof withFeishuWorkspaces>, notify: ReturnType<typeof vi.fn<(message: OutboundMessage) => void>>
let entries: Map<string, { id: string; path: string; title: string; sessionIds: string[] }>
let group: ReturnType<typeof vi.fn>
beforeEach(async () => {
  h = await startRuntime()
  entries = new Map([
    ['default', { id: 'default', path: h.directory, title: 'Super-agent', sessionIds: [h.runtime.masterId] }],
    ['project', { id: 'project', path: join(h.directory, 'game project'), title: '游戏项目', sessionIds: [] }],
  ])
  mkdirSync(entries.get('project')!.path)
  group = vi.fn(async (id: string, session: string) => {
    if (!entries.has(id)) throw new Error('workspace missing')
    for (const workspace of entries.values()) workspace.sessionIds = workspace.sessionIds.filter(value => value !== session)
    entries.get(id)!.sessionIds.push(session)
  })
  Object.assign(h.ctx.workspaceRegistry, {
    list: () => [...entries.values()], get: (id: string) => entries.get(id), groupSession: group,
    create: async (path: string) => {
      const existing = [...entries.values()].find(item => item.path === path)
      if (existing) return existing
      const workspace = { id: `ws-${entries.size}`, path, title: '新增工作区', sessionIds: [] as string[] }
      entries.set(workspace.id, workspace); return workspace
    },
  })
  const original = h.runtime.context(feishuKind)
  notify = vi.fn<(message: OutboundMessage) => void>()
  original.notify = notify
  source = withFeishuWorkspaces(h.ctx, original)
})
afterEach(async () => { await h.stop() })
const text = () => notify.mock.calls.at(-1)![0].text as string

it.each(['/workspace', '/ws', '/workspaces', '/workspacelist', '/wsl', '/help', '/menu', '/m'])('handles %s before evaluation', async command => {
  const trigger = feishu('1', command)
  await source.receive(trigger)
  expect(notify).toHaveBeenCalledTimes(1)
  expect(h.runtime.store.triggers.get(trigger.id)).toBeUndefined()
  expect(h.candidates()).toEqual([])
  expect(wordCount(text())).toBeLessThanOrEqual(100)
})

it('pins numeric choices to the shown list and persists the choice across adapter recreation', async () => {
  await source.receive(feishu('1', '/ws'))
  entries = new Map([...entries].reverse())
  await source.receive(feishu('2', '/ws 2'))
  expect(text()).toContain('游戏项目')
  source = withFeishuWorkspaces(h.ctx, h.runtime.context(feishuKind))
  const request = feishu('3', '检查项目')
  await source.receive(request)
  expect(h.runtime.store.triggers.get(request.id)?.meta.workspaceId).toBe('project')
})

it('places a new worker in the selected workspace and preserves its execution cwd', async () => {
  await source.receive(feishu('1', '/ws'))
  await source.receive(feishu('2', '/workspace 2'))
  const request = feishu('3', '修复游戏问题')
  await source.receive(request)
  const one = await h.acceptedTicket(request)
  expect(group).toHaveBeenCalledWith('project', one.sessionId)
  expect(one.ticket.execution!.directory).toContain('work')
  expect(one.ticket.execution!.directory).not.toBe(entries.get('project')!.path)
})

it('moves the current worker without prompting it, and startup reconciliation retains placement', async () => {
  const one = await h.acceptedTicket(feishu('1', '修复游戏问题'))
  const before = h.deliveries.mock.calls.length
  await source.receive(feishu('2', '/ws'))
  await source.receive(feishu('3', '/ws 2'))
  expect(group).toHaveBeenCalledWith('project', one.sessionId)
  expect(h.runtime.store.get(KV.sessions.workspace(one.sessionId))).toBe('project')
  expect(h.deliveries.mock.calls.length).toBe(before)
  await h.runtime.sessions.ensure(one.sessionId, one.ticket.execution!.directory, one.ticket.title, 'worker')
  expect(group.mock.calls.at(-1)).toEqual(['project', one.sessionId])
})

it('accepts an existing absolute directory with spaces and can restore the default', async () => {
  await source.receive(feishu('1', `/ws "${entries.get('project')!.path}"`))
  expect(text()).toContain('游戏项目')
  await source.receive(feishu('2', '/ws --default'))
  expect(text()).toContain('Super-agent')
  expect(wordCount(text())).toBeLessThanOrEqual(100)
})

it('does not mix workspace choices between people or conversations', async () => {
  await source.receive(feishu('1', `/ws "${entries.get('project')!.path}"`))
  const other = feishu('2', '处理其他工作', { chat_id: 'oc_other', chat_type: 'p2p' })
  await source.receive(other)
  expect(h.runtime.store.triggers.get(other.id)?.meta.workspaceId).toBeUndefined()
})

it('rejects unlisted people and bots without exposing the workspace catalog', async () => {
  await source.receive(feishu('1', '/ws', { sender_id: 'ou_unknown' }))
  await source.receive(feishu('2', '/ws', { sender_type: 'bot' }))
  expect(notify).not.toHaveBeenCalled()
  expect(group).not.toHaveBeenCalled()
})

it('deduplicates command delivery and does not let stale commands roll back a newer choice', async () => {
  const command = feishu('3', `/ws "${entries.get('project')!.path}"`)
  await source.receive(command)
  await expect(source.receive(command)).resolves.toBe('duplicate')
  expect(notify).toHaveBeenCalledTimes(1)
  await source.receive(feishu('2', '/ws --default'))
  const request = feishu('4', '后续任务')
  await source.receive(request)
  expect(h.runtime.store.triggers.get(request.id)?.meta.workspaceId).toBe('project')
})

it('reports invalid and expired selections instead of routing them into work', async () => {
  for (const [id, command] of [['1', '/ws 999'], ['2', '/ws relative/path'], ['3', '/ws 0']]) {
    await source.receive(feishu(id!, command!))
    expect(text()).toContain('无效')
  }
  expect(h.candidates()).toEqual([])
})

it('blocks new intake with an actionable reply when the selected workspace was removed', async () => {
  await source.receive(feishu('1', `/ws "${entries.get('project')!.path}"`))
  entries.delete('project')
  const request = feishu('2', '新工单')
  await source.receive(request)
  expect(text()).toContain('已被移除')
  expect(h.runtime.store.triggers.get(request.id)).toBeUndefined()
})

it('recognizes mention-prefixed commands without treating ordinary prose as a command', () => {
  expect(inject).toContain('workspaceRegistry')
  expect(isWorkspaceCommand('@工单机器人 /ws 2')).toBe(true)
  expect(isWorkspaceCommand('请解释 /ws 的意思')).toBe(false)
})

it('requires an explicit reply to move one of several current work orders', async () => {
  const one = await h.acceptedTicket(feishu('1', '修复一'))
  const two = await h.acceptedTicket(feishu('2', '修复二'))
  group.mockClear()
  await source.receive(feishu('3', `/ws "${entries.get('project')!.path}"`))
  expect(group).toHaveBeenCalledExactlyOnceWith('project', h.runtime.masterId)
  await source.receive(feishu('4', `/ws "${entries.get('project')!.path}"`, { root_id: 'om_1', parent_id: 'om_1' }))
  expect(group).toHaveBeenCalledWith('project', one.sessionId)
  expect(group).not.toHaveBeenCalledWith('project', two.sessionId)
})

it('paginates long catalogs within the Feishu reply size budget', async () => {
  for (let n = 0; n < 30; n++) entries.set(`extra-${n}`, { id: `extra-${n}`, path: `/path/${n}`, title: '很长的工作区名字'.repeat(6), sessionIds: [] })
  await source.receive(feishu('1', '/ws'))
  expect(text()).toContain('1/')
  expect(wordCount(text())).toBeLessThanOrEqual(100)
  await source.receive(feishu('2', '/ws --page 2'))
  expect(text()).toContain('2/')
  expect(wordCount(text())).toBeLessThanOrEqual(100)
})

it('keeps an in-flight order in its intake-time workspace after later preference changes', async () => {
  await source.receive(feishu('1', `/ws "${entries.get('project')!.path}"`))
  const request = feishu('2', '排队中的任务')
  await source.receive(request)
  await source.receive(feishu('3', '/ws --default'))
  const one = await h.acceptedTicket(request)
  expect(group).toHaveBeenCalledWith('project', one.sessionId)
})
