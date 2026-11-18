import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { key } from '../src/core/ids.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

it('delivers the stored question even when the orchestrator never calls reply, and deduplicates a later reply', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot fix it'))
  const lark = vi.mocked(Commands.prototype.lark)
  lark.mockClear()
  const question = 'Continue the repair, or accept the current result?'
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Needs a decision.', human_action: question })
  await h.runtime.idle()
  const attention = h.runtime.store.tickets.get(ticket.id)!.attention!
  const id = key('attention-reply', attention.id)
  expect(h.runtime.store.replyStatus(id)).toBe('sent')
  const sends = () => lark.mock.calls.filter(([args]) => args.includes('+messages-reply'))
  expect(sends()).toHaveLength(1)
  expect(sends()[0]![0]).toEqual(expect.arrayContaining(['--markdown', question, '--reply-in-thread', '--idempotency-key', id]))
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'attention', human_action: question, text: 'Rewritten progress summary.' })
  await h.runtime.idle()
  expect(sends()).toHaveLength(1)
})

it('keeps ordinary progress internal', async () => {
  const { sessionId } = await h.acceptedTicket(feishu('1', '@bot fix it'))
  const lark = vi.mocked(Commands.prototype.lark)
  lark.mockClear()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Working.', next_step: 'Continue.' })
  await h.runtime.idle()
  expect(lark.mock.calls.filter(([args]) => args.includes('+messages-reply'))).toHaveLength(0)
})
