/**
 * Experience a deployment's workers share across processes and runtimes.
 *
 * Workers run in separate processes and separate directories, so they cannot share memory. They share files:
 * one Markdown document per topic under `<stateDir>/shared/experience`, plus an `INDEX.md` the Router reads
 * before dispatching, and appends a section after a Ticket ends.
 *
 * Two runtimes write here and they serialize differently, so the write paths are split:
 * - `append()` takes an OS-level lock (proper-lockfile), which only in-process callers such as the DSH worker use;
 * - `incoming` files are written by a runtime that knows nothing of our lock — Codex — one file per Ticket, so
 *   there is nothing to contend for. `merge()` folds them in under the same lock the DSH path takes.
 *
 * Sections are append-only and carry their originating Ticket, runtime, and tags. That is what makes a merge
 * safe and what lets the Router pick the sections a Ticket needs instead of pasting the whole set.
 */
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'

/** Whether an entry came from a DSH worker or a Codex worker; recorded so a reader can weigh it. */
export type Runtime = 'dsh' | 'codex'

export interface ExperienceEntry {
  /** Markdown document the entry belongs to, without the extension: `windows-shims`. */
  topic: string
  /** Ticket that produced the entry, so a reader can find the work behind it. */
  ticket?: string
  runtime: Runtime
  /** One line naming what was learned, used in INDEX.md and in a Ticket's briefing. */
  title: string
  /** The Markdown body; no heading, the writer of the section adds it. */
  body: string
  tags?: readonly string[]
}

export const sharedRoot = (stateDir: string): string => join(stateDir, 'shared')
export const experienceRoot = (stateDir: string): string => join(sharedRoot(stateDir), 'experience')
export const incomingRoot = (stateDir: string): string => join(experienceRoot(stateDir), 'incoming')
export const indexFile = (stateDir: string): string => join(experienceRoot(stateDir), 'INDEX.md')
/** Where a runtime without our lock writes: one file per Ticket, never shared, never appended twice. */
export const incomingFile = (stateDir: string, ticket: string): string => join(incomingRoot(stateDir), `${ticket.replaceAll(/[^A-Za-z0-9_.-]/g, '_')}.md`)

const topicFile = (stateDir: string, topic: string): string => join(experienceRoot(stateDir), `${topic.replaceAll(/[^A-Za-z0-9_.-]/g, '_')}.md`)
const sectionTitle = (entry: ExperienceEntry): string => `## ${new Date().toISOString()} · ${entry.ticket ?? 'no ticket'} · ${entry.runtime} · ${entry.title}`
const sectionText = (entry: ExperienceEntry): string => [sectionTitle(entry), entry.tags?.length ? `tags: ${entry.tags.join(', ')}` : undefined, '', entry.body.trim(), ''].filter(line => line !== undefined).join('\n') + '\n'

/** Runs `write` under one lock, creating the file first because a lock needs a file to guard. */
async function locked<T>(file: string, write: () => Promise<T>): Promise<T> {
  await writeFile(file, '', { flag: 'a' })
  const release = await lockfile.lock(file, { retries: { retries: 10, factor: 1.5, minTimeout: 25, maxTimeout: 400 }, stale: 15_000 })
  try { return await write() } finally { await release() }
}

/**
 * Appends one entry to its topic and refreshes the index, under a lock that spans both:
 * a reader that sees an index entry can therefore find the section it names.
 */
export async function append(stateDir: string, entry: ExperienceEntry): Promise<void> {
  await mkdir(experienceRoot(stateDir), { recursive: true })
  const file = topicFile(stateDir, entry.topic)
  await locked(file, async () => {
    // A file created by the line above is empty until this write; only an empty file gets the heading.
    const existing = await readFile(file, 'utf8')
    await appendFile(file, (existing.trim() ? '' : `# ${entry.topic}\n\n`) + sectionText(entry), 'utf8')
    await rebuildIndex(stateDir)
  })
}

/**
 * Records what a runtime that cannot take our lock (Codex) learned. It writes its own file and nothing else,
 * so the write is a single exclusive create-or-replace and needs no lock.
 */
export async function record(stateDir: string, ticket: string, entry: Omit<ExperienceEntry, 'ticket'>): Promise<string> {
  await mkdir(incomingRoot(stateDir), { recursive: true })
  const file = incomingFile(stateDir, ticket)
  // Metadata is one block and the body follows a blank line, so merge() can rebuild a section without
  // nesting a second heading inside it. A runtime that writes this shape by hand still merges.
  await writeFile(file, [`# incoming: ${ticket}`, `topic: ${entry.topic}`, `title: ${entry.title}`, `tags: ${(entry.tags ?? []).join(', ')}`, '', entry.body.trim(), ''].join('\n'), 'utf8')
  return file
}

/** Folds every `incoming` file into its topic and removes what it moved. Returns the Tickets merged. */
export async function merge(stateDir: string): Promise<string[]> {
  const directory = incomingRoot(stateDir)
  const names = await readdir(directory).catch(() => [] as string[])
  const merged: string[] = []
  for (const name of names.filter(name => name.endsWith('.md'))) {
    const file = join(directory, name)
    const text = await readFile(file, 'utf8')
    const ticket = name.slice(0, -3)
    const topic = /^topic: (.+)$/m.exec(text)?.[1]?.trim() ?? 'incoming'
    const title = /^title: (.+)$/m.exec(text)?.[1]?.trim() ?? `notes from ${ticket}`
    const tags = /^tags: (.*)$/m.exec(text)?.[1]?.split(',').map(tag => tag.trim()).filter(Boolean) ?? []
    // The body is everything after the metadata block's blank line; the heading is rebuilt by append().
    const body = text.split(/\n[ \t]*\n(?=[^\n])/).slice(1).join('\n\n').trim()
    await append(stateDir, { topic, ticket, runtime: 'codex', title, body, tags })
    await rm(file, { force: true })
    merged.push(ticket)
  }
  return merged
}

/** The topics a Ticket's briefing can draw on: each document's title, section count, and last section. */
export async function topics(stateDir: string): Promise<{ topic: string; sections: number; latest: string }[]> {
  const names = await readdir(experienceRoot(stateDir)).catch(() => [] as string[])
  const found: { topic: string; sections: number; latest: string }[] = []
  for (const name of names.filter(name => name.endsWith('.md') && name !== 'INDEX.md')) {
    const text = await readFile(join(experienceRoot(stateDir), name), 'utf8')
    const sections = [...text.matchAll(/^## .*$/gm)].map(match => match[0])
    found.push({ topic: name.slice(0, -3), sections: sections.length, latest: sections.at(-1) ?? '' })
  }
  return found.sort((a, b) => a.topic.localeCompare(b.topic))
}

/**
 * The sections whose tags or topic a Ticket asked for, newest last, bounded so a briefing stays small.
 * A Ticket with no matching topic gets nothing rather than the whole corpus: silence is cheaper than noise.
 */
export async function briefing(stateDir: string, tags: readonly string[], limit = 12): Promise<string[]> {
  const wanted = new Set(tags.map(tag => tag.toLowerCase()))
  if (!wanted.size) return []
  const names = await readdir(experienceRoot(stateDir)).catch(() => [] as string[])
  const picked: string[] = []
  for (const name of names.filter(name => name.endsWith('.md') && name !== 'INDEX.md')) {
    const text = await readFile(join(experienceRoot(stateDir), name), 'utf8')
    for (const block of text.split(/^## /m).slice(1)) {
      const tagged = /^tags: (.+)$/m.exec(block)?.[1]?.split(',').map(tag => tag.trim().toLowerCase()) ?? []
      if (tagged.some(tag => wanted.has(tag)) || wanted.has(name.slice(0, -3).toLowerCase())) picked.push(`## ${block.trim()}`)
    }
  }
  return picked.slice(-limit)
}

async function rebuildIndex(stateDir: string): Promise<void> {
  // Every append takes its topic's lock and then this one, always in that order, so the order cannot deadlock.
  await locked(indexFile(stateDir), async () => {
    const found = await topics(stateDir)
    const lines = ['# Experience index', '', 'Workers append sections; the Router reads this before dispatch.', '']
    for (const { topic, sections, latest } of found) lines.push(`- [${topic}](${topic}.md) — ${sections} section${sections === 1 ? '' : 's'}, latest: ${latest.replace(/^## /, '')}`)
    await writeFile(indexFile(stateDir), lines.join('\n') + '\n', 'utf8')
  })
}
