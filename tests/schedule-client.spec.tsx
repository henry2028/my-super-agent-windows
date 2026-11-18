// @vitest-environment jsdom
/** Operator workflow: inspect worker phases and owner, change the time window and cancel a queued worker. */
import { expect, it } from 'vitest'
import { all, at, click, mount, text, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
it('shows unstarted child review and dependencies without offering a process stop button', async () => {
  const now = new Date().toISOString()
  server.schedule = { rows: [
    { id: 'parent', kind: 'ticket', title: 'Parent ticket', runtime: 'dsh', state: 'working', canStop: true,
      segments: [{ phase: 'running', from: now }] },
    { id: 'plan:parent:audit', kind: 'plan', title: 'Module audit', runtime: 'codex', state: 'planned', canStop: false,
      parentTicketId: 'parent', taskKind: 'review', dependsOn: ['implementation'], isUnfinished: true,
      segments: [{ phase: 'waiting', from: now }] },
  ], now, since: now, omitted: 0, paused: false, mode: 'session', tickets: { running: 1, queued: 0, maxWorkers: 3 },
    workers: { running: 0, starting: 0, queued: 0, maxWorkers: 3 } }
  at({ page: 'execution' }); await mount()
  await click('仅未结束')
  expect(text()).toContain('计划中，尚未派工')
  expect(all('.dt-schedule-row[data-child="true"]')).toHaveLength(1)
  await click(all('.dt-schedule-track')[1]!)
  expect(text()).toContain('所属工单： Parent ticket')
  expect(text()).toContain('前置步骤： implementation')
  expect(text()).toContain('独立审核')
  expect(text()).not.toContain('取消／停止任务')
})
it('shows both limits, recorded phases and worker controls on the execution page', async () => {
  const now = Date.now(), ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
  server.schedule = { rows: [
    { id: 'claude-a', kind: 'worker', title: 'claude-a', runtime: 'claude', state: 'queued', directory: '/work/claude',
      ownerSessionId: 'requester', segments: [{ phase: 'queued', from: ago(10) }], canStop: true,
      lastActivityAt: ago(1), summary: 'Waiting for an available slot.' },
    { id: 'codex-b', kind: 'worker', title: 'codex-b', runtime: 'codex', state: 'finished', directory: '/work/codex',
      segments: [{ phase: 'running', from: ago(30), to: ago(20) }], canStop: false },
  ], now: ago(0), since: ago(1440), omitted: 0, paused: true, mode: 'session',
    tickets: { running: 1, queued: 2, maxWorkers: 3 }, workers: { running: 0, starting: 0, queued: 1, maxWorkers: 3 } }
  at({ page: 'execution' })
  await mount()
  expect(text()).toContain('调度甘特图')
  expect(text()).toContain('两层独立限流')
  expect(text()).toContain('1/3')
  expect(all('.dt-schedule-bar')).toHaveLength(2)
  await click('仅未结束')
  expect(all('.dt-schedule-bar')).toHaveLength(1)
  await click('6h')
  await click(all('.dt-schedule-track')[0]!)
  expect(text()).toContain('/work/claude')
  expect(text()).toContain('最近记录')
  expect(text()).toContain('Waiting for an available slot.')
  await click('打开发起会话')
  expect(server.opened).toEqual(['requester'])
  await click('取消／停止任务')
  await click('确定')
  expect(server.schedule.rows[0]!.state).toBe('stopped')
  expect(all('.dt-schedule-bar')).toHaveLength(0)
})
