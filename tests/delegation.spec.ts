/** Completion must be backed by the current plan and real, correctly ordered worker records. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Delegation, type PlanInput } from '../src/app/delegation.ts'
import { KV } from '../src/kv.ts'
import type { WorkerRecord } from '../src/pool/table.ts'
import { scheduleRows } from '../src/app/views/schedule.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host, id: string, session: string, coordination: Delegation, records: WorkerRecord[]
const plan = (): PlanInput => ({ mode: 'direct', delegation_requested: false, required_reviews: ['codex'], reason: 'Single small edit; shared write kept serial.',
  review_requirements: 'The request requires a Codex module review.', steps: [
    { id: 'implement', title: 'Implementation', kind: 'work', runtime: 'self', depends_on: [], scope: '/project/src', evidence: 'Build passed.' },
    { id: 'audit', title: 'Codex review', kind: 'review', runtime: 'codex', depends_on: ['implement'], scope: '/project read-only' },
  ] })
const instant = (offset = 0) => new Date(Date.now() + offset).toISOString()
const worker = (overrides: Partial<WorkerRecord> = {}): WorkerRecord => ({ ticket: 'codex-a', runtime: 'codex',
  ownerSessionId: session, state: 'finished', exitCode: 0, directory: '/review', startedAt: instant(1000), endedAt: instant(2000), ...overrides })
const ticket = () => h.runtime.store.tickets.get(id)!
beforeEach(async () => {
  h = await startRuntime()
  const accepted = await h.acceptedTicket(feishu('1', 'Implement and ask Codex to review.'))
  id = accepted.ticket.id; session = accepted.sessionId; records = []
  coordination = new Delegation(h.runtime.store, async () => records)
})
afterEach(async () => { await h.stop() })

it('rejects a ready report without a plan atomically while still allowing progress and blockers', async () => {
  await expect(h.runTool(session, 'orchestrator_report', { state: 'ready', summary: 'Done' })).rejects.toThrow('orchestrator_plan')
  expect(ticket().ended).toBeUndefined()
  expect(ticket().assignments.at(-1)?.report).toBeUndefined()
  await h.runTool(session, 'orchestrator_report', { state: 'progress', summary: 'Investigating', next_step: 'Register split' })
  await h.runTool(session, 'orchestrator_report', { state: 'blocked', summary: 'Real missing prerequisite' })
  expect(ticket().assignments.at(-1)?.report?.state).toBe('blocked')
})

it('offers the plan tool only to the ticket executor and accepts a verified direct small task', async () => {
  expect(h.tools.get(h.runtime.masterId)?.has('orchestrator_plan')).toBe(false)
  const p = plan(); p.steps.pop(); p.required_reviews = []; p.review_requirements = 'Read-only survey; no module review requested.'
  await h.runTool(session, 'orchestrator_plan', { plan: p })
  await h.runTool(session, 'orchestrator_report', { state: 'ready', summary: 'Survey verified.' })
  expect(ticket().ended?.outcome).toBe('completed')
})

it('persists a split and history across coordinator reconstruction, without pretending it dispatched', async () => {
  await coordination.save(id, plan())
  const restored = new Delegation(h.runtime.store, async () => records)
  expect(await restored.view(ticket())).toMatchObject({ stale: false, revision: 1, steps: [
    { id: 'implement', state: 'finished' }, { id: 'audit', state: 'planned' },
  ] })
  expect(h.runtime.store.get(KV.delegation.history(id, 1))).toBeDefined()
  await expect(restored.assertReady(id)).rejects.toThrow('audit=planned')
})

it('preserves a plan through host recovery and status requests without repeating completed work', async () => {
  await coordination.save(id, plan())
  h.runtime.engine.assignmentInterrupted(id, ticket().assignments.at(-1)!.id)
  await h.runtime.idle()
  expect(ticket().assignments.length).toBeGreaterThan(1)
  expect(await coordination.view(ticket())).toMatchObject({ stale: false, steps: [{ state: 'finished' }, { state: 'planned' }] })
})

it('requires declared reviewers and actual external work for an explicit delegation instruction', async () => {
  const p = plan(); p.steps.pop()
  await expect(coordination.save(id, p)).rejects.toThrow('Required codex review')
  p.required_reviews = []; p.delegation_requested = true
  await expect(coordination.save(id, p)).rejects.toThrow('actual external work')
  p.mode = 'delegated'; p.steps.push({ id: 'inventory', title: 'Independent inventory', kind: 'work', runtime: 'dsh', depends_on: [], scope: 'Read-only project' })
  await coordination.save(id, p)
  await expect(coordination.assertReady(id)).rejects.toThrow('inventory=planned')
})

it('does not accept prose evidence in place of an unstarted external review', async () => {
  const p = plan(); p.steps[1]!.evidence = 'Looks good, reviewed.'
  await coordination.save(id, p)
  await expect(coordination.assertReady(id)).rejects.toThrow('audit=planned')
})

it.each(['queued', 'running', 'failed', 'stopped', 'timeout'] as const)('rejects a %s reviewer', async state => {
  const p = plan(); records.push(worker({ state })); p.steps[1]!.worker_ticket = 'codex-a'; p.steps[1]!.evidence = 'Collected.'
  await coordination.save(id, p)
  await expect(coordination.assertReady(id)).rejects.toThrow('Plan incomplete')
})

it('requires successful exit and disposition of findings, then accepts actual review evidence', async () => {
  const p = plan(); records.push(worker({ exitCode: 1 })); p.steps[1]!.worker_ticket = 'codex-a'
  await coordination.save(id, p)
  await expect(coordination.assertReady(id)).rejects.toThrow('audit=failed')
  records[0]!.exitCode = 0
  await expect(coordination.assertReady(id)).rejects.toThrow('review-pending')
  p.steps[1]!.evidence = 'Read actual findings: corrected two links and verified all references; no remaining findings.'
  await coordination.save(id, p)
  await expect(coordination.assertReady(id)).resolves.toEqual(expect.any(String))
})

it('does not count review notes written before the reviewer finished as reading its result', async () => {
  const p = plan(); records.push(worker({ state: 'running' })); p.steps[1]!.worker_ticket = 'codex-a'; p.steps[1]!.evidence = 'Premature claim.'
  await coordination.save(id, p)
  records[0]!.state = 'finished'
  await expect(coordination.assertReady(id)).rejects.toThrow('review-pending')
  p.steps[1]!.evidence = 'Actual final findings read; links checked.'
  await coordination.save(id, p)
  await expect(coordination.assertReady(id)).resolves.toEqual(expect.any(String))
})

it('refuses foreign or mismatched workers and duplicate use of one process', async () => {
  const p = plan(); p.steps[1]!.worker_ticket = 'codex-a'
  records.push(worker({ ownerSessionId: 'other' }))
  await expect(coordination.save(id, p)).rejects.toThrow('foreign')
  records[0] = worker({ runtime: 'claude' })
  await expect(coordination.save(id, p)).rejects.toThrow('wrong runtime')
  records[0] = worker(); p.steps.push({ ...p.steps[1]!, id: 'audit-again' })
  await expect(coordination.save(id, p)).rejects.toThrow('multiple plan steps')
})

it('rejects dependency cycles, nonexistent dependencies and nonindependent review', async () => {
  const p = plan(); p.steps[0]!.depends_on = ['audit']
  await expect(coordination.save(id, p)).rejects.toThrow('cycle')
  p.steps[0]!.depends_on = ['missing']
  await expect(coordination.save(id, p)).rejects.toThrow('Invalid dependency')
  p.steps[0]!.depends_on = []; p.steps[1]!.runtime = 'self'; p.required_reviews = []
  await expect(coordination.save(id, p)).rejects.toThrow('Independent review')
})

it('cannot silently remove a registered review, and preserves self completion time on unchanged saves', async () => {
  const first = await coordination.save(id, plan())
  const p = plan(); p.steps.pop(); p.required_reviews = []
  await expect(coordination.save(id, p)).rejects.toThrow('Keep registered review')
  const second = await coordination.save(id, plan())
  expect(second.steps[0]!.completedAt).toBe(first.steps[0]!.completedAt)
})

it('requires rerunning a reviewer that started before its implementation dependency finished', async () => {
  const p = plan(); records.push(worker({ startedAt: instant(-1000) })); p.steps[1]!.worker_ticket = 'codex-a'; p.steps[1]!.evidence = 'Read.'
  await coordination.save(id, p)
  await expect(coordination.assertReady(id)).rejects.toThrow(/predates|before dependency/)
})

it('invalidates a plan on a new human request and rejects reuse of an old worker result', async () => {
  const p = plan(); records.push(worker({ startedAt: instant(-1000), endedAt: instant(-500) })); p.steps[1]!.worker_ticket = 'codex-a'; p.steps[1]!.evidence = 'Read.'
  await coordination.save(id, p)
  h.runtime.store.tickets.save({ ...ticket(), inputs: [...ticket().inputs, { kind: 'text', id: 'new-work', text: 'Change scope', at: instant() }] })
  expect(await coordination.view(ticket())).toMatchObject({ stale: true })
  await expect(coordination.assertReady(id)).rejects.toThrow('latest human request')
  await coordination.save(id, p)
  await expect(coordination.assertReady(id)).rejects.toThrow('predates')
})

it('refuses completion with any owned process still running, even one absent from the plan', async () => {
  const p = plan(); p.steps.pop(); p.required_reviews = []
  await coordination.save(id, p); records.push(worker({ state: 'running' }))
  await expect(coordination.assertReady(id)).rejects.toThrow('still active')
})

it('checks the ordering of self integration after delegated production too', async () => {
  const p = plan(); p.steps.pop(); p.required_reviews = []; p.mode = 'delegated'
  p.steps[0]!.depends_on = ['inventory']
  p.steps.push({ id: 'inventory', title: 'Inventory', kind: 'work', runtime: 'dsh', depends_on: [], scope: 'read-only', worker_ticket: 'dsh-a' })
  records.push(worker({ ticket: 'dsh-a', runtime: 'dsh' }))
  await coordination.save(id, p)
  await expect(coordination.assertReady(id)).rejects.toThrow('before dependency inventory')
})

it('rejects a plan changed between asynchronous verification and the report transaction', async () => {
  const p = plan(); p.steps.pop(); p.required_reviews = []
  await h.runTool(session, 'orchestrator_plan', { plan: p })
  const check = h.runtime.delegation.assertReady.bind(h.runtime.delegation)
  vi.spyOn(h.runtime.delegation, 'assertReady').mockImplementationOnce(async ticketId => {
    const stamp = await check(ticketId)
    await h.runtime.delegation.save(ticketId, { ...p, reason: 'Changed split while ready was pending.' })
    return stamp
  })
  await expect(h.runTool(session, 'orchestrator_report', { state: 'ready', summary: 'done' })).rejects.toThrow('plan changed')
  expect(ticket().ended).toBeUndefined()
})

it('shows parent/child dependencies and planned review distinctly from a running process', async () => {
  const p = plan(), view = await coordination.save(id, p)
  let rows = scheduleRows([ticket()], [], Date.now(), [view]).rows
  expect(rows.find(row => row.id.endsWith(':audit'))).toMatchObject({ kind: 'plan', state: 'planned', taskKind: 'review',
    parentTicketId: id, dependsOn: ['implement'], canStop: false, isUnfinished: true })
  records.push(worker({ state: 'running' })); p.steps[1]!.worker_ticket = 'codex-a'
  const running = await coordination.save(id, p)
  rows = scheduleRows([ticket()], records, Date.now() + 3000, [running]).rows
  expect(rows.filter(row => row.title === 'Codex review')).toHaveLength(1)
  expect(rows.find(row => row.id === 'codex-a')).toMatchObject({ kind: 'worker', state: 'running', taskKind: 'review', parentTicketId: id })
})

it('passes saved plan metadata through the actual Runtime HTTP host adapter', async () => {
  await h.runTool(session, 'orchestrator_plan', { plan: plan() })
  const response = await h.api('GET', 'schedule')
  expect(response.status).toBe(200)
  expect(response.body.rows).toEqual(expect.arrayContaining([expect.objectContaining({
    kind: 'plan', title: 'Codex review', taskKind: 'review', parentTicketId: id,
    dependsOn: ['implement'], state: 'planned',
  })]))
})
