import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { latestAssignment } from '../src/core/index.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { vi.useRealTimers(); await h.stop() })
it('waits for owned process delegates without spending stagnant checks, then resumes normal continuation when none run', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const agent = h.agents.get(one.sessionId)!
  ;(agent as any).session.snapshotEvents = () => [{ type: 'assistant/message', seq: 10,
    data: { message: { content: [{ type: 'text', text: 'Waiting for the delegated review.' }] } } }]
  const records = vi.fn(async () => [{ ownerSessionId: one.sessionId, state: 'running' }])
  Object.defineProperty(h.runtime, 'workers', { value: { records }, configurable: true })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  agent.status = 'idle'; h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await vi.advanceTimersByTimeAsync(60000)
  expect(records).toHaveBeenCalled()
  expect(agent.status).toBe('idle')
  expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.continuation).toBeUndefined()
  expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.report).toBeUndefined()
  records.mockResolvedValue([])
  h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await vi.advanceTimersByTimeAsync(5001)
  expect(agent.status).toBe('running')
  expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.continuation?.attempts).toBe(1)
})
it('deduplicates idle and reports a stall after three checks without progress', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const agent = h.agents.get(one.sessionId)!
  ;(agent as any).session.snapshotEvents = () => [{ type: 'assistant/message', seq: 10,
    data: { message: { content: [{ type: 'text', text: 'I will continue now.' }] } } }]
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  agent.status = 'idle'; h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await vi.advanceTimersByTimeAsync(1)
  const current = () => latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)!
  expect(current().continuation?.state).toBe('scheduled')
  // Repeated idle notifications cannot consume more continuation budget.
  h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await vi.advanceTimersByTimeAsync(5000)
  expect(agent.status).toBe('running')
  expect(current().continuation?.attempts).toBe(1)
  for (let i = 0; i < 3; i++) {
    agent.status = 'idle'; h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
    await vi.advanceTimersByTimeAsync(5001)
  }
  expect(current().report?.state).toBe('failed')
  expect(current().continuation?.reason).toContain('three consecutive')
})
it('does not schedule a check after a concrete human question', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  h.runtime.engine.report(one.ticket.id, { state: 'progress', summary: 'Need a decision', question: 'Which reference?' })
  const agent = h.agents.get(one.sessionId)!
  ;(agent as any).session.snapshotEvents = () => [{ type: 'assistant/message', seq: 10,
    data: { message: { content: [{ type: 'text', text: 'Please choose.' }] } } }]
  agent.status = 'idle'; h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await h.runtime.idle()
  expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.continuation).toBeUndefined()
})
it('keeps progressing tasks running beyond three wakes', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const agent = h.agents.get(one.sessionId)!
  let seq = 10
  ;(agent as any).session.snapshotEvents = () => [
    { type: 'tool/call', seq: seq - 1, data: { callId: `c${seq}`, name: 'pwsh' } },
    { type: 'tool/result', seq, data: { message: { toolCallId: `c${seq}` } } },
    { type: 'assistant/message', seq: seq + 1, data: { message: { content: [{ type: 'text', text: 'Verified a step.' }] } } },
  ]
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  for (let round = 1; round <= 4; round++) {
    h.runtime.engine.report(one.ticket.id, { state: 'progress', summary: `Verified ${round}`, nextStep: 'Run the next authorized check' })
    seq += 10
    agent.status = 'idle'; h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
    await vi.advanceTimersByTimeAsync(5001)
    expect(agent.status).toBe('running')
  }
  const a = latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)!
  expect(a.continuation).toMatchObject({ attempts: 0, wakes: 4, state: 'checking' })
  expect(a.report?.state).toBe('progress')
})
it('does not wake during pause or discard work after fifteen minutes waiting for a slot', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const agent = h.agents.get(one.sessionId)!
  ;(agent as any).session.snapshotEvents = () => [{ type: 'assistant/message', seq: 10,
    data: { message: { content: [{ type: 'text', text: 'Continue.' }] } } }]
  await h.runtime.settings.pause(true, 'panel')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  agent.status = 'idle'; h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await vi.advanceTimersByTimeAsync(905000)
  expect(agent.status).toBe('idle')
  expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.continuation?.state).toBe('scheduled')
  await h.runtime.settings.pause(false, 'panel')
  await vi.advanceTimersByTimeAsync(5001)
  expect(agent.status).toBe('running')
})
it('reassesses an old question on a new human instruction, retaining it for audit', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  h.runtime.engine.report(one.ticket.id, { state: 'progress', summary: 'Choose a route', question: 'Accept approximation?' })
  h.runtime.receive(feishu('2', '先咨询 Codex，不要替我选择方案', { mentions: [], root_id: 'om_1' }))
  await h.runtime.idle()
  const ticket = h.runtime.store.tickets.get(one.ticket.id)!
  expect(ticket.attention).toBeUndefined()
  expect(latestAssignment(ticket)?.previousQuestion?.question).toBe('Accept approximation?')
  h.runtime.engine.report(one.ticket.id, { state: 'progress', summary: 'Consulted; decision still necessary', question: 'Which route now?' })
  expect(h.runtime.store.tickets.get(one.ticket.id)?.attention?.question).toBe('Which route now?')
})
it('does not release a human decision for context-only or bot messages', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  h.runtime.engine.report(one.ticket.id, { state: 'progress', summary: 'Choose a route', question: 'Choose?' })
  const stored = h.runtime.store.tickets.get(one.ticket.id)!
  const input = { id: 'bot-input', kind: 'trigger' as const, triggerId: 'bot-trigger', at: new Date().toISOString() }
  stored.inputs.push(input); stored.undelivered.push(input.id); h.runtime.store.tickets.save(stored)
  h.runtime.engine.inputsDelivered(one.ticket.id, latestAssignment(stored)!.id, [input.id])
  expect(h.runtime.store.tickets.get(one.ticket.id)?.attention?.question).toBe('Choose?')
})
