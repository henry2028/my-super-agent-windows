import { expect, it } from 'vitest'
import type { Assignment, Ticket } from '../src/core/model.ts'
import { continuationDecision } from '../src/executor/continuation.ts'
const now = Date.parse('2026-11-12T03:00:00Z'), at = (ms: number) => new Date(now + ms).toISOString()
const ticket = { mandate: { strength: 'explicit' }, undelivered: [] } as unknown as Ticket
const assignment = (patch: Partial<Assignment> = {}): Assignment => ({ id: 'a', state: 'running', createdAt: at(-60000), ...patch })
const prior = { attempts: 1, firstAt: at(-60000), lastAt: at(-30000), toolSeq: 10, state: 'checking' as const, reason: 'check' }
it('counts missing-handoff checks but renews the guard only with next step and tool progress', () => {
  expect(continuationDecision(ticket, assignment(), 0, now).run).toBe(true)
  expect(continuationDecision(ticket, assignment({ continuation: prior }), 11, now).run).toBe(true)
  const a = assignment({ continuation: prior, report: { state: 'progress', summary: 'read code', nextStep: 'run verification', at: at(-1000) } })
  expect(continuationDecision(ticket, a, 10, now).progress).toBe(false)
  expect(continuationDecision(ticket, a, 11, now)).toEqual({ run: true, progress: true, reason: 'run verification' })
})
it('never wakes human handoffs, delivery, inferred mandates, or terminal reports', () => {
  for (const patch of [{ attention: { question: 'choose' } }, { delivery: {} }, { undelivered: ['input'] }, { mandate: { strength: 'inferred' } }])
    expect(continuationDecision({ ...ticket, ...patch } as Ticket, assignment(), 20, now).run).toBe(false)
  for (const state of ['ready', 'blocked', 'failed', 'waiting', 'dropped'] as const)
    expect(continuationDecision(ticket, assignment({ report: { state, summary: 'handoff', at: at(0) } }), 20, now).run).toBe(false)
})
it('stops three stagnant checks, but does not stop long tasks making concrete progress', () => {
  const report = { state: 'progress' as const, summary: 'step', nextStep: 'next', at: at(0) }
  expect(continuationDecision(ticket, assignment({ report, continuation: { ...prior, attempts: 3 } }), 10, now).problem).toBe(true)
  expect(continuationDecision(ticket, assignment({ report, continuation: { ...prior, attempts: 100, firstAt: at(-9000000) } }), 20, now).run).toBe(true)
})
