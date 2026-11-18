/** Sidebar ownership is independent of a worker's immutable cwd and shell directory. */
import { normalize } from 'node:path'
import type { WorkerRecord } from '../pool/table.ts'

/** Conservative one-time migration: only a single unclaimed creation in a completed process's exact lifespan. */
export function legacyProcessSession(record: WorkerRecord,
  headers: readonly { id: string; cwd?: string; createdAt: number; parentSession?: string }[], reserved: ReadonlySet<string>): string | undefined {
  if (record.runtime !== 'dsh' || !record.ownerSessionId || record.sessionId || !record.startedAt || !record.endedAt) return
  const from = Date.parse(record.startingAt ?? record.startedAt), to = Date.parse(record.endedAt)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return
  const pathKey = (path: string) => process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path)
  const matches = headers.filter(header => header.id.startsWith('session-') && !header.parentSession && !reserved.has(header.id) &&
    header.createdAt >= from && header.createdAt <= to && header.cwd && pathKey(header.cwd) === pathKey(record.directory))
  return matches.length === 1 ? matches[0]!.id : undefined
}

export interface GroupRegistry {
  create(path: string, title?: string): Promise<{ id: string; title?: string; setTitle?(title: string): Promise<void> }>
  groupSession?(workspaceId: string, sessionId: string): Promise<void>
}

/** Places sessions in the sidebar while preserving their working directory and history. */
export class SessionWorkspace {
  private workspace?: Promise<{ id: string }>
  constructor(private readonly registry: GroupRegistry, private readonly directory: string) {}

  async attach(sessionId: string, workspaceId?: string): Promise<void> {
    if (!this.registry.groupSession) throw new Error('Super-agent requires the local dsh-workspace grouping extension')
    if (workspaceId) { await this.registry.groupSession(workspaceId, sessionId); return }
    const workspace = await (this.workspace ??= this.registry.create(this.directory, 'Super-agent').then(async workspace => {
      if (workspace.title === 'superagent') await workspace.setTitle?.('Super-agent')
      return workspace
    })
      .catch(error => { this.workspace = undefined; throw error }))
    await this.registry.groupSession(workspace.id, sessionId)
  }

  /** Include persisted descendants without resolving agents, replaying logs, or waking work. */
  async reconcile(roots: Iterable<string>, headers: readonly { id: string; parentSession?: string }[],
    selection: (id: string) => string | undefined = () => undefined): Promise<void> {
    const owned = new Set(roots)
    const selections = new Map([...owned].map(id => [id, selection(id)]))
    let changed = true
    while (changed) {
      changed = false
      for (const header of headers) {
        if (!owned.has(header.id) && header.parentSession && owned.has(header.parentSession)) {
          owned.add(header.id); selections.set(header.id, selection(header.id) ?? selections.get(header.parentSession)); changed = true
        }
      }
    }
    for (const header of headers) if (owned.has(header.id)) await this.attach(header.id, selections.get(header.id))
  }
}
