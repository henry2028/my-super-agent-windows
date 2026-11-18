/** The Gantt must reflect durable intervals and never claim unrecorded queue or execution times. */
import { expect, it } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { scheduleRows } from '../src/app/views/schedule.ts'

const now = Date.parse('2026-11-11T09:00:00.000Z')
const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
const ticket = (patch: Partial<Ticket> = {}): Ticket => ({ id: 'main', title: 'Main work', decisionId: 'd', channels: [],
  createdAt: at(10), updatedAt: at(1), assignments: [], inputs: [], undelivered: [],
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'local', id: 'me' }, scope: '' },
  origin: { triggerId: 'e', triggerIds: ['e'] }, ...patch })

it('shows queue, assignment, waiting and subsequent delivery as separate phases', () => {
  const { rows } = scheduleRows([ticket({ assignments: [{ id: 'a', state: 'running', createdAt: at(10), startedAt: at(8),
    report: { state: 'waiting', summary: 'needs input', at: at(5) }, deliveredAt: at(2) }] })], [], now)
  expect(rows[0]!.segments).toEqual([
    { phase: 'queued', from: at(10), to: at(8) }, { phase: 'running', from: at(8), to: at(5) },
    { phase: 'waiting', from: at(5), to: at(2) }, { phase: 'running', from: at(2) },
  ])
})
it('explains an unfinished idle turn and exposes its report and last recorded activity', () => {
  const { rows } = scheduleRows([ticket({ assignments: [{ id: 'a', state: 'running', createdAt: at(10),
    startedAt: at(8), idleAt: at(1), report: { state: 'waiting', summary: 'Ended after promising to continue', at: at(1) } }] })], [], now)
  expect(rows[0]).toMatchObject({ state: 'idle', waitReason: 'turn-ended', lastActivityAt: at(1), summary: 'Ended after promising to continue' })
})

it('shows worker startup and ownership without inventing legacy queue times or duplicating main processes', () => {
  const { rows } = scheduleRows([ticket()], [
    { ticket: 'main', runtime: 'dsh', state: 'running', directory: '/main', startedAt: at(8) },
    { ticket: 'claude-a', runtime: 'claude', state: 'running', directory: '/work', ownerSessionId: 'worker-main',
      queuedAt: at(8), startingAt: at(7), startedAt: at(6) },
    { ticket: 'codex-legacy', runtime: 'codex', state: 'finished', directory: '/legacy', startedAt: at(10), endedAt: at(1) },
  ], now)
  expect(rows.filter(row => row.id === 'main')).toHaveLength(1)
  expect(rows.find(row => row.id === 'claude-a')).toMatchObject({ ownerSessionId: 'worker-main', segments: [
    { phase: 'queued', from: at(8), to: at(7) }, { phase: 'starting', from: at(7), to: at(6) }, { phase: 'running', from: at(6) },
  ] })
  expect(rows.find(row => row.id === 'codex-legacy')!.segments).toEqual([{ phase: 'running', from: at(10), to: at(1) }])
})

it('keeps older live work while bounding finished history and ignores malformed timestamps', () => {
  const { rows, omitted } = scheduleRows([], [
    { ticket: 'live', runtime: 'claude', state: 'queued', directory: '/', queuedAt: at(4000) },
    { ticket: 'bad', runtime: 'dsh', state: 'failed', directory: '/', startedAt: 'invalid', endedAt: at(1) },
    ...Array.from({ length: 110 }, (_, index) => ({ ticket: `old-${index}`, runtime: 'codex' as const, state: 'finished' as const,
      directory: '/', startedAt: at(3), endedAt: at(1) })),
  ], now)
  expect(rows).toHaveLength(101)
  expect(rows[0]!.id).toBe('live')
  expect(omitted).toBe(10)
})
