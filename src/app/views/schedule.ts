/** Scheduling timeline built from durable timestamps, without inventing old queue times or future estimates. */
import { latestAssignment, ticketStage, type Ticket } from '../../core/index.ts'
import type { WorkerRecord } from '../../pool/table.ts'
import type { PlanView } from '../delegation.ts'

export type SchedulePhase = 'queued' | 'starting' | 'running' | 'waiting'
export interface ScheduleSegment { phase: SchedulePhase; from: string; to?: string }
export interface ScheduleRow {
  id: string
  kind: 'ticket' | 'worker' | 'plan'
  title: string
  runtime: string
  state: string
  directory?: string
  ownerSessionId?: string
  rootSessionId?: string
  workspaceId?: string
  sessionId?: string
  parentTicketId?: string
  taskKind?: 'work' | 'review'
  dependsOn?: string[]
  isUnfinished?: boolean
  segments: ScheduleSegment[]
  canStop: boolean
  lastActivityAt?: string
  summary?: string
  waitReason?: 'input' | 'review' | 'blocked' | 'failed' | 'turn-ended' | 'continuation' | 'delegates'
}
const valid = (at: string | undefined): at is string => !!at && Number.isFinite(Date.parse(at))

/** Keep every live row and at most 100 recent finished rows. Ticket bars are assignment spans, not CPU utilization. */
export function scheduleRows(tickets: Ticket[], records: WorkerRecord[], now = Date.now(), plans: PlanView[] = []) {
  const since = new Date(now - 24 * 60 * 60_000).toISOString()
  const rows: ScheduleRow[] = tickets.map(ticket => {
    const assignment = latestAssignment(ticket), stage = ticketStage(ticket), continuation = assignment?.continuation
    const scheduled = !ticket.ended && continuation?.state === 'scheduled'
    const lastActivityAt = [assignment?.startedAt, assignment?.deliveredAt, assignment?.idleAt, assignment?.report?.at, continuation?.lastAt]
      .filter((at): at is string => valid(at)).sort().at(-1)
    const segments: ScheduleSegment[] = []
    const add = (phase: SchedulePhase, from?: string, to?: string) => {
      if (valid(from) && (!to || valid(to) && to >= from)) segments.push({ phase, from, ...(to ? { to } : {}) })
    }
    for (const [index, assignment] of ticket.assignments.entries()) {
      const end = assignment.endedAt ?? ticket.ended?.at ?? ticket.assignments[index + 1]?.createdAt
      add('queued', assignment.createdAt, assignment.startedAt ?? end)
      if (!assignment.startedAt) continue
      const report = assignment.report
      if (report && report.state !== 'progress' && report.at >= assignment.startedAt && (!end || report.at <= end)) {
        add('running', assignment.startedAt, report.at)
        const resumed = assignment.deliveredAt && assignment.deliveredAt > report.at ? assignment.deliveredAt : undefined
        add('waiting', report.at, resumed ?? end)
        if (resumed) add('running', resumed, end)
      } else add('running', assignment.startedAt, end)
    }
    const waitReason = scheduled ? 'continuation' : stage.stage === 'person' ?
      (stage.action === 'answer' || stage.action === 'delivery' ? 'input' : stage.action) : stage.stage === 'idle' ? 'turn-ended' : undefined
    if (scheduled) {
      const last = segments.at(-1)
      if (last && !last.to) last.to = continuation.lastAt
      segments.push({ phase: 'queued', from: continuation.lastAt })
    }
    return { id: ticket.id, kind: 'ticket', title: ticket.title, runtime: 'dsh', state: scheduled ? 'queued' : stage.stage,
      directory: ticket.execution?.directory, segments, canStop: !ticket.ended, lastActivityAt, waitReason,
      summary: [ticket.attention ? `待答问题：${ticket.attention.question}` : '',
        continuation?.state === 'stopped' ? continuation.reason : '', assignment?.report?.summary ?? ''].filter(Boolean).join('\n\n') }
  })
  const ticketIds = new Set(tickets.map(ticket => ticket.id))
  for (const record of records) {
    // ProcessExecutor records the main ticket too; one ticket must not appear twice.
    if (ticketIds.has(record.ticket)) continue
    const segments: ScheduleSegment[] = []
    const add = (phase: SchedulePhase, from?: string, to?: string) => {
      if (valid(from) && (!to || valid(to) && to >= from)) segments.push({ phase, from, ...(to ? { to } : {}) })
    }
    add('queued', record.queuedAt, record.startingAt ?? record.startedAt ?? record.endedAt)
    add('starting', record.startingAt, record.startedAt ?? record.endedAt)
    add('running', record.startedAt, record.endedAt)
    rows.push({ id: record.ticket, kind: 'worker', title: record.ticket, runtime: record.runtime, state: record.state,
      directory: record.directory, ownerSessionId: record.ownerSessionId, segments,
      rootSessionId: record.rootSessionId, workspaceId: record.workspaceId, sessionId: record.sessionId,
      parentTicketId: record.parentTicketId && ticketIds.has(record.parentTicketId) ? record.parentTicketId : undefined,
      lastActivityAt: record.lastActivity ?? record.endedAt ?? record.startedAt ?? record.queuedAt, summary: record.detail,
      canStop: ['queued', 'starting', 'running'].includes(record.state) })
  }
  for (const plan of plans) {
    const parent = rows.find(row => row.kind === 'ticket' && row.id === plan.ticketId)
    if (!parent) continue
    parent.summary = [parent.summary, `分工：${plan.mode} · ${plan.reason}`, `审核要求：${plan.review_requirements}`,
      plan.stale ? '分工计划需按最新人工输入更新' : ''].filter(Boolean).join('\n\n')
    for (const step of plan.steps) {
      const row = rows.find(row => row.kind === 'worker' && row.id === step.worker_ticket)
      const metadata = { parentTicketId: plan.ticketId, taskKind: step.kind, dependsOn: step.depends_on,
        isUnfinished: parent.canStop && (plan.stale || step.state !== 'finished'),
        summary: [step.scope, step.evidence, step.worker?.detail].filter(Boolean).join('\n\n') }
      const title = step.round ? `v${step.round} · ${step.title}` : step.title
      if (row) Object.assign(row, metadata, { title, state: step.state })
      else rows.push({ ...metadata, id: `plan:${plan.ticketId}:${step.id}`, kind: 'plan', title,
        runtime: step.runtime, state: plan.stale ? 'stale' : step.state, ownerSessionId: `worker-${plan.ticketId}`,
        canStop: false, lastActivityAt: step.completedAt ?? plan.updatedAt,
        segments: [{ phase: 'waiting', from: plan.updatedAt, ...(step.completedAt ? { from: step.completedAt, to: step.completedAt } :
          !parent.canStop ? { to: tickets.find(ticket => ticket.id === plan.ticketId)?.ended?.at ?? plan.updatedAt } : {}) }] })
    }
  }
  for (const row of rows) if (row.kind === 'worker' && row.ownerSessionId?.startsWith('worker-')) {
    const id = row.ownerSessionId.slice(7)
    if (ticketIds.has(id)) row.parentTicketId = id
  }
  for (const row of rows) if (row.kind === 'ticket' && row.state === 'idle' && records.some(record =>
    record.ownerSessionId === `worker-${row.id}` && ['queued', 'starting', 'running'].includes(record.state))) row.waitReason = 'delegates'
  const live = (row: ScheduleRow) => row.canStop || row.isUnfinished
  const recent = rows.filter(row => live(row) || row.segments.some(segment => !segment.to || segment.to >= since))
  const finished = recent.filter(row => !live(row)).sort((a, b) =>
    (b.segments.at(-1)?.to ?? '').localeCompare(a.segments.at(-1)?.to ?? ''))
  const shown = [...recent.filter(live), ...finished.slice(0, 100)]
  const grouped: ScheduleRow[] = [], seen = new Set<string>()
  const append = (row: ScheduleRow) => { if (!seen.has(row.id)) { seen.add(row.id); grouped.push(row) } }
  for (const row of shown) {
    if (row.parentTicketId) {
      const parent = shown.find(item => item.id === row.parentTicketId)
      if (parent) append(parent)
    }
    append(row)
    if (row.kind === 'ticket') for (const child of shown.filter(item => item.parentTicketId === row.id)) append(child)
  }
  return { rows: grouped, omitted: Math.max(0, finished.length - 100), since }
}
