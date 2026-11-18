/** Bounded follow-ups, not automatic retries of external actions. */
import type { Assignment, Ticket } from '../core/model.ts'

export function continuationDecision(ticket: Ticket, assignment: Assignment, toolSeq: number, now: number) {
  const prior = assignment.continuation, report = assignment.report
  const fresh = !!report && report.at >= (prior?.lastAt ?? assignment.deliveredAt ?? assignment.startedAt ?? assignment.createdAt)
  if (ticket.mandate.strength !== 'explicit' || ticket.attention || ticket.delivery || ticket.undelivered.length)
    return { run: false, reason: 'Waiting for input or delivery; no automatic continuation.' }
  if (fresh && report.state !== 'progress') return { run: false, reason: 'Worker handed off with a status report.' }
  const progress = prior && toolSeq > prior.toolSeq && fresh && report?.state === 'progress' && !!report.nextStep
  if (prior && !progress && prior.attempts >= 3)
    return { run: false, problem: true, reason: 'Worker stalled: three consecutive continuation checks without verified tool progress and a concrete next_step.' }
  return { run: true, progress: !!progress, reason: fresh && report.nextStep ? report.nextStep : 'Turn ended without a handoff; verify completion, blockers, and the next authorized step.' }
}
