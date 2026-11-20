/** Durable task plans; process records, rather than an agent's assertion, prove delegated completion. */
import { z } from 'zod'
import { key, liveTicket, type Ticket } from '../core/index.ts'
import type { WorkerRecord } from '../pool/table.ts'
import type { RuntimeName } from '../pool/types.ts'
import { RUNTIME_NAME } from '../pool/types.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'

const StepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,49}$/),
  title: z.string().trim().min(1).max(200),
  kind: z.enum(['work', 'review']),
  runtime: z.string().regex(RUNTIME_NAME),
  depends_on: z.array(z.string()).max(20).default([]),
  scope: z.string().trim().min(1).max(1000).describe('Allowed paths, read-only versus writable, and shared operations kept serial.'),
  round: z.number().int().min(1).max(32).optional().describe('Version number for an iterative plan. One production step followed by that version’s reviews.'),
  review_outcome: z.enum(['accepted', 'changes-requested']).optional().describe('Disposition of an iterative review. A last round requesting changes cannot be reported ready.'),
  worker_ticket: z.string().optional().describe('Real worker_start ticket owned by this ticket session; bind after starting it.'),
  evidence: z.string().trim().min(1).max(2000).optional().describe('For self work: completed checks. For review: findings read and how each actionable finding was resolved; process success alone is not approval.'),
}).strict()
export const PlanSchema = z.object({
  mode: z.enum(['direct', 'delegated', 'iterative']),
  delegation_requested: z.boolean().describe('True when an applicable human instruction explicitly asks for multiple workers or delegation.'),
  required_reviews: z.array(z.enum(['codex', 'claude'])).max(2).describe('Reviewer runtimes required by the original human requests/instructions for this deliverable; empty only when none applies.'),
  reason: z.string().trim().min(1).max(1000).describe('Why this split is appropriate; direct is for a small task or a specific dependency, not merely because it shares a repository.'),
  review_requirements: z.string().trim().min(1).max(2000).describe('Extract applicable Codex/Claude review requirements from original requests and instructions. If none apply, explain why.'),
  steps: z.array(StepSchema).min(1).max(96),
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
const active = (worker: WorkerRecord) => ['queued', 'starting', 'running'].includes(worker.state)
const iterativeRequest = /(?:协作模式\s*[:：]\s*逐版|逐版(?:外派|派工|交接|协作|审核)|(?:每一?版|每个版本|v\d+\s*[-–—到至]\s*v\d+).{0,48}(?:子进程|外派|派给|审核后再|审完再)|iterative[ -](?:delegation|handoff)|each (?:version|round).{0,60}(?:delegate|child worker|review before))/is
type CoordinationStore = Pick<Store, 'get' | 'set' | 'atomic' | 'tickets' | 'triggers'>

export function requiresIterative(store: Pick<CoordinationStore, 'get' | 'triggers'>, ticket: Ticket): boolean {
  if (store.get(KV.delegation.plan(ticket.id))?.mode === 'iterative') return true
  const ids = new Set(ticket.origin.triggerIds)
  ids.add(ticket.origin.triggerId)
  for (const input of workInputs(ticket)) {
    if (input.kind === 'text' && iterativeRequest.test(input.text)) return true
    if (input.kind === 'trigger') ids.add(input.triggerId)
  }
  return [...ids].some(id => {
    const trigger = store.triggers.get(id)
    return !!trigger?.human && iterativeRequest.test(trigger.text)
  })
}

function validateRounds(plan: PlanInput): void {
  if (!plan.delegation_requested || !plan.required_reviews.includes('codex'))
    throw new Error('Iterative work requires delegated production and a Codex review in every round')
  let round = 0, works = 0, reviews = new Set<string>(), previous: string | undefined
  const complete = () => works === 1 && plan.required_reviews.every(runtime => reviews.has(runtime))
  for (const step of plan.steps) {
    if (step.round === round + 1) {
      if (round && !complete()) throw new Error(`Round ${round} needs one production worker and all required reviews`)
      round++; works = 0; reviews = new Set()
    }
    if (!round || step.round !== round || step.runtime === 'self' || (step.kind === 'review' && works !== 1))
      throw new Error('List consecutive rounds, each starting with one external production step followed by external reviews')
    if (previous && !step.depends_on.includes(previous)) throw new Error(`Step ${step.id} must depend on ${previous}`)
    if (step.kind === 'work') works++
    else reviews.add(step.runtime)
    previous = step.id
  }
  if (!complete()) throw new Error(`Round ${round} needs one production worker and all required reviews`)
}

export class Delegation {
  constructor(private readonly store: CoordinationStore,
    private readonly records: () => Promise<WorkerRecord[]>) {}

  async view(ticket: Ticket, records?: WorkerRecord[]): Promise<PlanView | undefined> {
    const plan = this.store.get(KV.delegation.plan(ticket.id))
    if (!plan) return undefined
    const owned = new Map((records ?? await this.records()).filter(row => row.ownerSessionId === `worker-${ticket.id}`).map(row => [row.ticket, row]))
    return { ...plan, stale: plan.epoch !== planEpoch(ticket), steps: plan.steps.map(step => {
      const worker = step.worker_ticket ? owned.get(step.worker_ticket) : undefined
      const missing = plan.mode === 'iterative' && step.worker_ticket && this.store.get(KV.delegation.readResult(ticket.id, step.worker_ticket)) === 'missing'
      const state = missing ? 'failed' : step.runtime === 'self' ? step.completedAt ? 'finished' : 'planned'
        : worker ? successful(worker) ? (plan.mode === 'iterative' || step.kind === 'review') && (!step.evidence || step.reviewedWorker !== worker.ticket)
          ? step.kind === 'review' ? 'review-pending' : 'result-pending' : 'finished'
          : worker.state === 'finished' ? 'failed' : worker.state : 'planned'
      return { ...step, state, ...(worker ? { worker } : {}) }
    }) }
  }

  async save(ticketId: string, input: PlanInput): Promise<PlanView> {
    const parsed = PlanSchema.parse(input), records = await this.records()
    const ticket = this.store.atomic(() => {
      const ticket = this.current(ticketId), epoch = planEpoch(ticket)
      const iterative = parsed.mode === 'iterative'
      const previous = this.store.get(KV.delegation.plan(ticketId))
      const same = previous?.epoch === epoch && (!iterative || previous.mode === 'iterative')
      if (!iterative && requiresIterative(this.store, ticket)) throw new Error('This ticket requires mode=iterative; register delegated production and review rounds')
      if (iterative) validateRounds(parsed)
      const ids = new Set(parsed.steps.map(step => step.id))
      if (ids.size !== parsed.steps.length) throw new Error('Plan step IDs must be unique')
      if (!parsed.steps.some(step => step.kind === 'work')) throw new Error('Plan needs a work step')
      if (parsed.mode === 'delegated' && !parsed.steps.some(step => step.runtime !== 'self')) throw new Error('Delegated plan needs an external step')
      if (parsed.delegation_requested && (parsed.mode === 'direct' || !parsed.steps.some(step => step.kind === 'work' && step.runtime !== 'self')))
        throw new Error('Explicit delegation request needs an actual external work step, not only a future promise or review')
      for (const runtime of parsed.required_reviews) if (!parsed.steps.some(step => step.kind === 'review' && step.runtime === runtime))
        throw new Error(`Required ${runtime} review needs a review step`)
      if (previous && (previous.epoch === epoch || previous.mode === 'iterative')
        && previous.required_reviews.some(runtime => !parsed.required_reviews.includes(runtime))) throw new Error('Keep registered review requirements')
      if (same && previous.delegation_requested && !parsed.delegation_requested) throw new Error('Keep the explicit delegation requirement')
      const workers = new Set<string>()
      for (const step of parsed.steps) {
        if (iterative) {
          const old = previous?.mode === 'iterative' ? previous.steps.find(item => item.id === step.id) : undefined
          if (step.worker_ticket !== old?.worker_ticket) throw new Error('Iterative workers are bound by worker_start with plan_step; keep its saved ticket')
          if (step.evidence && (!step.worker_ticket || this.store.get(KV.delegation.readResult(ticketId, step.worker_ticket)) !== true))
            throw new Error(`Read the result of ${step.id} using worker_status before recording disposition`)
          if (step.kind === 'review' && !!step.evidence !== !!step.review_outcome)
            throw new Error(`Record both evidence and review_outcome for ${step.id}`)
          if (step.kind === 'work' && step.review_outcome) throw new Error('Only a review may have review_outcome')
        }
        if (step.kind === 'review' && !['codex', 'claude'].includes(step.runtime)) throw new Error('Independent review must use codex or claude')
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
      if (previous?.mode === 'iterative' && previous.steps.some((step, index) => parsed.steps[index]?.id !== step.id))
        throw new Error('Keep the order of existing iterative steps; append new rounds at the end')
      if (same || previous?.mode === 'iterative') for (const old of previous!.steps) {
        const step = parsed.steps.find(step => step.id === old.id)
        if (previous!.mode === 'iterative' && (!step || step.round !== old.round || step.runtime !== old.runtime || step.kind !== old.kind))
          throw new Error(`Keep the registered round and role of ${old.id}`)
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
          const old = same || iterative && previous?.mode === 'iterative' ? previous?.steps.find(old => old.id === step.id) : undefined
          const unchanged = old && JSON.stringify({ ...old, completedAt: undefined }) === JSON.stringify(step)
          const worker = records.find(row => row.ticket === step.worker_ticket)
          return { ...step, ...(step.runtime === 'self' && step.evidence ? { completedAt: unchanged ? old.completedAt ?? now : now } : {}),
            ...((iterative || step.kind === 'review') && step.evidence && successful(worker) ? { reviewedWorker: worker!.ticket } : {}) }
        }) }
      this.store.set(KV.delegation.plan(ticketId), plan)
      this.store.set(KV.delegation.history(ticketId, plan.revision), plan)
      return ticket
    })
    return (await this.view(ticket, records))!
  }

  required(ticket: Ticket): boolean { return requiresIterative(this.store, ticket) }

  /** Reserve a step before the process enters the queue. The plan stamp also rejects concurrent dispatches. */
  async dispatch(ticketId: string, stepId: string | undefined, runtime: RuntimeName, workerId: string): Promise<{ handoff: string } | undefined> {
    const ticket = this.current(ticketId)
    if (!this.required(ticket)) {
      if (stepId) throw new Error('plan_step requires an iterative plan')
      return undefined
    }
    const stamp = this.stamp(ticketId)
    const records = await this.records(), view = await this.view(ticket, records)
    return this.store.atomic(() => {
      const current = this.current(ticketId), plan = this.store.get(KV.delegation.plan(ticketId))
      if (!view || view.stale || plan?.mode !== 'iterative' || this.stamp(ticketId) !== stamp)
        throw new Error('Register or update the iterative plan for the latest user input before dispatch')
      if (workInputs(current).some(input => current.undelivered.includes(input.id) || input.kind === 'trigger' && input.readAt === null))
        throw new Error('Read the pending human input before dispatch')
      if (records.some(row => row.ownerSessionId === `worker-${ticketId}` && active(row)))
        throw new Error('An owned worker is still active; end the turn and wait for its result')
      const next = view.steps.find(step => step.state !== 'finished')
      if (!next || !stepId || next.id !== stepId || next.runtime !== runtime)
        throw new Error(`Only the next unfinished step may start: ${next ? `${next.id} (${next.runtime})` : 'none'}`)
      if (next.state === 'review-pending' || next.state === 'result-pending')
        throw new Error(`Read and record the disposition of ${stepId} before dispatching another step`)
      const updated = { ...plan, revision: plan.revision + 1, updatedAt: new Date().toISOString(), steps: plan.steps.map(step =>
        step.id === stepId ? { ...step, worker_ticket: workerId, evidence: undefined, review_outcome: undefined, reviewedWorker: undefined } : step) }
      this.store.set(KV.delegation.plan(ticketId), updated)
      this.store.set(KV.delegation.history(ticketId, updated.revision), updated)
      const handoff = view.steps.filter(step => step.evidence && (step.round === next.round
        || next.kind === 'work' && step.round === next.round! - 1))
        .map(step => `${step.title}: ${step.evidence}`).join('\n')
      return { handoff }
    })
  }

  readResult(ticketId: string, workerId: string): void {
    if (this.store.get(KV.delegation.plan(ticketId))?.mode === 'iterative')
      this.store.set(KV.delegation.readResult(ticketId, workerId), true)
  }

  missingResult(ticketId: string, workerId: string): void {
    const key = KV.delegation.readResult(ticketId, workerId)
    if (this.store.get(key) === undefined) this.store.set(key, 'missing')
  }

  async assertReady(ticketId: string): Promise<string> {
    const records = await this.records(), ticket = this.current(ticketId), view = await this.view(ticket, records)
    if (!view || view.stale) throw new Error('Before ready, register/update orchestrator_plan for the latest human request, including dispatch and required reviews')
    if (this.required(ticket) && view.mode !== 'iterative') throw new Error('This ticket requires an iterative plan')
    if (view.mode === 'iterative' && workInputs(ticket).some(input => ticket.undelivered.includes(input.id) || input.kind === 'trigger' && input.readAt === null))
      throw new Error('Read the pending human input before reporting ready')
    const unfinished = view.steps.filter(step => step.state !== 'finished')
    if (unfinished.length) throw new Error(`Plan incomplete: ${unfinished.map(step => `${step.id}=${step.state}`).join(', ')}. Continue authorized work or report a concrete blocker`)
    if (view.mode === 'iterative' && view.steps.some(step => step.round === view.steps.at(-1)?.round && step.review_outcome === 'changes-requested'))
      throw new Error('The final round still requests changes; add a new round or report the concrete blocker')
    if (records.some(row => row.ownerSessionId === `worker-${ticketId}` && ['queued', 'starting', 'running'].includes(row.state)))
      throw new Error('Owned workers still active; collect their results before ready')
    for (const step of view.steps) {
      const start = step.worker?.startedAt ?? step.completedAt
      const currentWorkAt = ticket.createdAt
      const inputAt = workInputs(ticket).map(input => input.at).sort().at(-1)
      if (!start || (view.mode !== 'iterative' && start < (inputAt && inputAt > currentWorkAt ? inputAt : currentWorkAt))) throw new Error(`Step ${step.id} predates the current request`)
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
