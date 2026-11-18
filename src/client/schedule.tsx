/** Live scheduling Gantt: independent ticket/worker capacity, timestamped phases and explicit cancellation. */
import { useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Button, Pill } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { ConfirmButton, Hint, LoadState, Section } from './widgets.tsx'

type Schedule = ApiResponse<'GET schedule'>
const PHASES = ['queued', 'starting', 'running', 'waiting'] as const
const stamp = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const duration = (ms: number) => `${Math.floor(ms / 60_000)}m ${Math.floor(ms % 60_000 / 1000)}s`

export function ScheduleChart({ data, onChanged }: { data: Schedule; onChanged: () => Promise<unknown> }) {
  const { t, call, navigate, openSession } = usePanel()
  const [hours, setHours] = useState(1)
  const [activeOnly, setActiveOnly] = useState(false)
  const [selected, setSelected] = useState<string>()
  const now = Date.parse(data.now), start = now - hours * 3_600_000
  const rows = data.rows.filter(row => (!activeOnly || row.canStop || row.isUnfinished) && row.segments.some(segment =>
    Date.parse(segment.from) <= now && Date.parse(segment.to ?? data.now) >= start))
  const current = rows.find(row => row.id === selected)
  const percent = (at: string) => Math.max(0, Math.min(100, (Date.parse(at) - start) / (now - start) * 100))
  const phase = (value: string) => t(`schedule.${value}` as Parameters<typeof t>[0])
  const load = (name: string, running: number, queued: number, max: number) => <span>
    <strong>{name}</strong> {running}/{max} · {t('queuedLabel')} {queued}
  </span>
  return <Section title={t('scheduleTitle')}>
    <div className="dt-row-meta dt-schedule-load">
      {load(t('scheduleTickets'), data.tickets.running, data.tickets.queued, data.tickets.maxWorkers)}
      {load(t('scheduleWorkers'), data.workers.running + data.workers.starting, data.workers.queued, data.workers.maxWorkers)}
    </div>
    <Hint>{t('scheduleLimits')}</Hint>
    <p className="dt-row-meta">{t('scheduleUnfinished', { count: data.rows.filter(row => row.kind === 'ticket' && row.canStop).length })}
      {' · '}{t('scheduleIdleCount', { count: data.rows.filter(row => row.kind === 'ticket' && row.state === 'idle').length })}</p>
    {data.paused && <p className="dt-banner">{t('schedulePaused')}</p>}
    <div className="dt-row-meta">
      {[1, 6, 24].map(value => <Pill key={value} active={hours === value} onClick={() => setHours(value)}>{value}h</Pill>)}
      <Pill active={activeOnly} onClick={() => setActiveOnly(!activeOnly)}>{t('scheduleActive')}</Pill>
      <Button size="sm" icon={undefined} onClick={() => { void onChanged() }}>{t('scheduleRefresh')}</Button>
    </div>
    <div className="dt-schedule-legend">{PHASES.map(value => <span key={value}><i data-phase={value} />{phase(value)}</span>)}</div>
    <div className="dt-schedule-scroll" role="region" aria-label={t('scheduleTitle')} tabIndex={0}>
      <div className="dt-schedule-grid">
        <div className="dt-schedule-label">{t('scheduleTask')}</div>
        <div className="dt-schedule-axis">{[0, 1, 2, 3, 4].map(tick => <span key={tick}
          style={{ left: `${tick * 25}%` }}>{stamp(start + tick * (now - start) / 4)}</span>)}</div>
        {rows.map(row => <div className="dt-schedule-row" data-child={!!row.parentTicketId} key={`${row.kind}:${row.id}`}>
          <button type="button" className="dt-schedule-label" aria-pressed={selected === row.id}
            onClick={() => setSelected(row.id)} title={row.title}>
            <span>{row.kind === 'ticket' ? t('scheduleTickets') : row.runtime} · {row.title}</span>
            {row.taskKind && <small>{t(row.taskKind === 'review' ? 'scheduleReview' : 'scheduleWork')}</small>}
            <small>{phase(row.state)}</small>
            {row.waitReason && <small>{t(`schedule.reason.${row.waitReason}`)}</small>}
            {row.lastActivityAt && <small>{t('scheduleLastActivity')} {stamp(Date.parse(row.lastActivityAt))}</small>}
          </button>
          <button type="button" className="dt-schedule-track" aria-label={`${row.title} · ${phase(row.state)}`}
            onClick={() => setSelected(row.id)}>
            {row.segments.map((segment, index) => {
              if (Date.parse(segment.to ?? data.now) < start || Date.parse(segment.from) > now) return null
              const left = percent(segment.from), right = percent(segment.to ?? data.now)
              return <span key={index} className="dt-schedule-bar" data-phase={segment.phase}
                style={{ left: `${left}%`, width: `${right - left}%` }}
                title={`${phase(segment.phase)} · ${new Date(segment.from).toLocaleString()} → ${segment.to
                  ? new Date(segment.to).toLocaleString() : t('scheduleNow')} · ${duration(Date.parse(segment.to ?? data.now) - Date.parse(segment.from))}`} />
            })}
          </button>
        </div>)}
      </div>
    </div>
    {!rows.length && <Hint>{t('scheduleEmpty')}</Hint>}
    {current && <div className="dt-form dt-block">
      <strong>{current.title}</strong>
      <Hint>{current.runtime} · {phase(current.state)} · {current.id}</Hint>
      <Hint>{t('scheduleRoot')} {current.rootSessionId ?? t('scheduleOwnershipUnknown')}</Hint>
      {current.workspaceId && <Hint>{t('scheduleWorkspace')} {current.workspaceId}</Hint>}
      {current.parentTicketId && <Hint>{t('scheduleParent')} {data.rows.find(row => row.id === current.parentTicketId)?.title ?? current.parentTicketId}</Hint>}
      {!!current.dependsOn?.length && <Hint>{t('scheduleDependencies')} {current.dependsOn.join(', ')}</Hint>}
      {current.waitReason && <Hint>{t(`schedule.reason.${current.waitReason}`)}</Hint>}
      {current.lastActivityAt && <Hint>{t('scheduleLastActivity')} {new Date(current.lastActivityAt).toLocaleString()}</Hint>}
      {current.summary && <pre style={{ whiteSpace: 'pre-wrap' }}>{current.summary}</pre>}
      {current.directory && <code className="dt-schedule-directory">{current.directory}</code>}
      {current.ownerSessionId && <Button size="sm" onClick={() => { void openSession(current.ownerSessionId!) }}>{t('scheduleOwner')}</Button>}
      {current.rootSessionId && current.rootSessionId !== current.ownerSessionId && <Button size="sm" onClick={() => { void openSession(current.rootSessionId!) }}>{t('scheduleOpenRoot')}</Button>}
      {current.sessionId && <Button size="sm" onClick={() => { void openSession(current.sessionId!) }}>{t('scheduleOpenWorker')}</Button>}
      <div className="dt-row-meta">
        {current.kind === 'ticket' && <Button size="sm" onClick={() => navigate({ page: 'execution', id: current.id })}>{t('details')}</Button>}
        {current.canStop && <ConfirmButton icon="stop" label={t('scheduleStop')} title={t('scheduleStop')}
          message={t('scheduleStopConfirm')} onConfirm={async () => {
            if (current.kind === 'worker') await call('POST workers/:id/stop', { id: current.id })
            else await call('POST tickets/:id/stop', { id: current.id })
            await onChanged()
          }} />}
      </div>
    </div>}
    <Hint>{t('schedulePrecision')}</Hint>
    {data.omitted > 0 && <Hint>{t('scheduleOmitted', { count: data.omitted })}</Hint>}
  </Section>
}

export function SchedulePanel() {
  const { call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET schedule'), [])
  return <><LoadState error={error} loading={!data} />{data && <ScheduleChart data={data} onChanged={reload} />}</>
}
