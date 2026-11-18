/** Durable task plans; process records, rather than an agent's assertion, prove delegated completion. */
import { z } from 'zod'
import { key, liveTicket, type Ticket } from '../core/index.ts'
import type { WorkerRecord } from '../pool/table.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'

const StepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,49}$/),
  title: z.string().trim().min(1).max(200),
  kind: z.enum(['work', 'review']),
  runtime: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  depends_on: z.array(z.string()).max(20).default([]),
  scope: z.string().trim().min(1).max(1000).describe('Allowed paths, read-only versus writable, and shared operations kept serial.'),
  worker_ticket: z.string().optional().describe('Real worker_start ticket owned by this ticket session; bind after starting it.'),
  evidence: z.string().trim().min(1).max(2000).optional().describe('For self work: completed checks. For review: findings read and how each actionable finding was resolved; process success alone is not approval.'),
}).strict()
export const PlanSchema = z.object({
  mode: z.enum(['direct', 'delegated']),
  delegation_requested: z.boolean().describe('True when an applicable human instruction explicitly asks for multiple workers or delegation.'),
  required_reviews: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)).max(8).describe('Reviewer runtimes required by the original human requests/instructions for this deliverable; empty only when none applies.'),
  reason: z.string().trim().min(1).max(1000).describe('Why this split is appropriate; direct is for a small task or a specific dependency, not merely because it shares a repository.'),
  review_requirements: z.string().trim().min(1).max(2000).describe('Extract applicable Codex/Claude review requirements from original requests and instructions. If none apply, explain why.'),
  steps: z.array(StepSchema).min(1).max(20),
}).strict()
export type PlanInput = z.infer<typeof PlanSchema>
export interface TaskPlan extends PlanInput {
  ticketId: string; epoch: string; revision: number; updatedAt: string
  steps: (PlanInput['steps'][number] & { completedAt?: string; reviewedWorker?: string })[]
}
export type PlannedTask = TaskPlan['steps'][number] & { state: string; worker?: WorkerRecord }
export interface PlanView extends Omit<TaskPlan, 'steps'> { stale: boolean; steps: PlannedTask[] }

function workInputs(ticket: Ticket) {
  const recovery = new Set(ticket.assignments.map(assignment => key('input', ticket.id, 'restart', assignment.id)))
  return ticket.inputs.filter(input => input.kind === 'text' ? !input.id.startsWith('status:') && !recovery.has(input.id)
    : input.kind === 'trigger' && input.human && !input.context)
}
/** Human work invalidates completion, but host recovery and status checks preserve finished work. */
export function planEpoch(ticket: Ticket): string {
  return key(ticket.id, ...workInputs(ticket).map(input => input.id))
}
const successful = (worker: WorkerRecord | undefined) => worker?.state === 'finished' && worker.exitCode === 0 && !!worker.endedAt
/** Stores a ticket's work plan and checks that the recorded workers satisfy it before completion. */
export class Delegation {
  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'atomic' | 'tickets'>,
    private readonly records: () => Promise<WorkerRecord[]>) {}

  async view(ticket: Ticket, records?: WorkerRecord[]): Promise<PlanView | undefined> {
    const plan = this.store.get(KV.delegation.plan(ticket.id))
    if (!plan) return undefined
    const owned = new Map((records ?? await this.records()).filter(row => row.ownerSessionId === `worker-${ticket.id}`).map(row => [row.ticket, row]))
    return { ...plan, stale: plan.epoch !== planEpoch(ticket), steps: plan.steps.map(step => {
      const worker = step.worker_ticket ? owned.get(step.worker_ticket) : undefined
      const state = step.runtime === 'self' ? step.completedAt ? 'finished' : 'planned'
        : worker ? successful(worker) ? step.kind === 'review' && (!step.evidence || step.reviewedWorker !== worker.ticket) ? 'review-pending' : 'finished'
          : worker.state === 'finished' ? 'failed' : worker.state : 'planned'
      return { ...step, state, ...(worker ? { worker } : {}) }
    }) }
  }

  async save(ticketId: string, input: PlanInput): Promise<PlanView> {
    const parsed = PlanSchema.parse(input), records = await this.records()
    const ticket = this.store.atomic(() => {
      const ticket = this.current(ticketId), epoch = planEpoch(ticket)
      const previous = this.store.get(KV.delegation.plan(ticketId)), same = previous?.epoch === epoch
      const ids = new Set(parsed.steps.map(step => step.id))
      if (ids.size !== parsed.steps.length) throw new Error('Plan step IDs must be unique')
      if (!parsed.steps.some(step => step.kind === 'work')) throw new Error('Plan needs a work step')
      if (parsed.mode === 'delegated' && !parsed.steps.some(step => step.runtime !== 'self')) throw new Error('Delegated plan needs an external step')
      if (parsed.delegation_requested && (parsed.mode !== 'delegated' || !parsed.steps.some(step => step.kind === 'work' && step.runtime !== 'self')))
        throw new Error('Explicit delegation request needs an actual external work step, not only a future promise or review')
      for (const runtime of parsed.required_reviews) if (!parsed.steps.some(step => step.kind === 'review' && step.runtime === runtime))
        throw new Error(`Required ${runtime} review needs a review step`)
      if (same && previous.required_reviews.some(runtime => !parsed.required_reviews.includes(runtime))) throw new Error('Keep registered review requirements until a new human scope change')
      if (same && previous.delegation_requested && !parsed.delegation_requested) throw new Error('Keep the explicit delegation requirement')
      const workers = new Set<string>()
      for (const step of parsed.steps) {
        if (step.kind === 'review' && step.runtime === 'self') throw new Error('Independent review must use an external worker')
        if (step.kind === 'review' && !step.depends_on.length) throw new Error('Review must depend on the work it reviews')
        if (step.runtime === 'self' && step.worker_ticket) throw new Error('Self work cannot bind a process')
        for (const dependency of step.depends_on) if (!ids.has(dependency) || dependency === step.id) throw new Error(`Invalid dependency of ${step.id}`)
        if (step.worker_ticket) {
          const worker = records.find(row => row.ticket === step.worker_ticket)
          if (!worker || worker.ownerSessionId !== `worker-${ticketId}` || worker.runtime !== step.runtime) throw new Error(`Worker of ${step.id} is missing, foreign, or uses the wrong runtime`)
          if (workers.has(step.worker_ticket)) throw new Error('One worker cannot prove multiple plan steps')
          workers.add(step.worker_ticket)
        }
      }
      const visiting = new Set<string>(), visited = new Set<string>()
      const visit = (id: string) => {
        if (visiting.has(id)) throw new Error('Plan dependencies contain a cycle')
        if (visited.has(id)) return
        visiting.add(id)
        for (const dependency of parsed.steps.find(step => step.id === id)!.depends_on) visit(dependency)
        visiting.delete(id); visited.add(id)
      }
      for (const id of ids) visit(id)
      // Do not let a reworded plan silently erase an outstanding review or a real dispatch.
      if (same) for (const old of previous.steps) {
        const step = parsed.steps.find(step => step.id === old.id)
        if ((old.kind === 'review' || old.worker_ticket) && (!step || step.runtime !== old.runtime || step.kind !== old.kind))
          throw new Error(`Keep registered review/dispatch ${old.id}; report a real blocker instead of dropping it`)
        if (old.kind === 'review' && step && old.depends_on.some(id => !step.depends_on.includes(id)))
          throw new Error(`Keep review dependencies of ${old.id}`)
        if (step && old.worker_ticket && step.worker_ticket !== old.worker_ticket && step.evidence && step.evidence === old.evidence)
          throw new Error(`Read the replacement worker result before recording evidence for ${old.id}`)
      }
      const now = new Date().toISOString()
      const plan: TaskPlan = { ...parsed, ticketId, epoch, revision: (previous?.revision ?? 0) + 1, updatedAt: now,
        steps: parsed.steps.map(step => {
          const old = same ? previous.steps.find(old => old.id === step.id) : undefined
          const unchanged = old && JSON.stringify({ ...old, completedAt: undefined }) === JSON.stringify(step)
          const worker = records.find(row => row.ticket === step.worker_ticket)
          return { ...step, ...(step.runtime === 'self' && step.evidence ? { completedAt: unchanged ? old.completedAt ?? now : now } : {}),
            ...(step.kind === 'review' && step.evidence && successful(worker) ? { reviewedWorker: worker!.ticket } : {}) }
        }) }
      this.store.set(KV.delegation.plan(ticketId), plan)
      this.store.set(KV.delegation.history(ticketId, plan.revision), plan)
      return ticket
    })
    return (await this.view(ticket, records))!
  }

  async assertReady(ticketId: string): Promise<string> {
    const records = await this.records(), ticket = this.current(ticketId), view = await this.view(ticket, records)
    if (!view || view.stale) throw new Error('Before ready, register/update orchestrator_plan for the latest human request, including dispatch and required reviews')
    const unfinished = view.steps.filter(step => step.state !== 'finished')
    if (unfinished.length) throw new Error(`Plan incomplete: ${unfinished.map(step => `${step.id}=${step.state}`).join(', ')}. Continue authorized work or report a concrete blocker`)
    if (records.some(row => row.ownerSessionId === `worker-${ticketId}` && ['queued', 'starting', 'running'].includes(row.state)))
      throw new Error('Owned workers still active; collect their results before ready')
    for (const step of view.steps) {
      const start = step.worker?.startedAt ?? step.completedAt
      const currentWorkAt = ticket.createdAt
      const inputAt = workInputs(ticket).map(input => input.at).sort().at(-1)
      if (!start || start < (inputAt && inputAt > currentWorkAt ? inputAt : currentWorkAt)) throw new Error(`Step ${step.id} predates the current request`)
      for (const dependency of step.depends_on) {
        const before = view.steps.find(item => item.id === dependency)!
        const completed = before.worker?.endedAt ?? before.completedAt
        if (!completed || completed > start) throw new Error(`${step.id} started before dependency ${dependency} finished; rerun the dependent step`)
      }
    }
    return key(view.epoch, String(view.revision))
  }
  stamp(ticketId: string): string { return key(planEpoch(this.current(ticketId)), String(this.store.get(KV.delegation.plan(ticketId))?.revision ?? 0)) }
  private current(id: string): Ticket {
    const ticket = this.store.tickets.get(id)
    if (!ticket || !liveTicket(ticket)) throw new Error('Ticket ended; a plan cannot authorize new work')
    return ticket
  }
}
