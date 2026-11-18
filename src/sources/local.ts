/**
 * 本地工单源：把一个目录里的 Markdown 文件当需求，一个文件一票；回复写回同目录的 replies/。
 *
 * 它让整台机器不需要 GitHub 也能接单：目录归操作者所有，文件即直接请求，
 * 因此这里固定用 `operator` 这一个身份授权——没有第二个人能往这个目录里说话。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { AllowedSchema } from '../policy.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { pause } from './poll.ts'

export const SOURCE = 'local'
/** 目录里的一切都由本机操作者写下，所以全部请求都归到这一个身份上。 */
export const OPERATOR = 'operator'

const LocalConfigSchema = z.object({
  /** 工单目录的绝对路径；留空用 `<stateDir>/tasks`。 */
  directory: z.string().trim().default(''),
  pollSeconds: z.number().int().min(5).max(3600).default(10),
}).strict()
export type LocalConfig = z.infer<typeof LocalConfigSchema>

const directoryOf = (config: Pick<LocalConfig, 'directory'>, stateDir: string): string => config.directory || join(stateDir, 'tasks')
/** 文件内容摘要：同一文件同一内容只产生一个 Trigger，幂等靠它。 */
const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** 一个文件 → 一个 Trigger；改内容算同一 Thread 上的新消息（跟进），改名算新工单。 */
export function fileTrigger(name: string, text: string, at: string, directory: string): Trigger {
  const thread = key(`local:${name}`)
  return {
    id: key(`local:${name}:${digest(text)}`),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: OPERATOR },
    human: true,
    // 文件是写给 agent 的，不是被别人顺带看到的，所以算直接请求。
    addressed: 'direct',
    at,
    text,
    channel: { source: SOURCE, thread, address: { file: name, directory } },
    meta: { file: name, directory },
  }
}

/** 回帖写成 `replies/<消息 id>.md`，与工单文件放在一起，人不必开面板也能看到结果。 */
async function send(_host: unknown, message: { id: string; channel: ChannelRef; text: string }): Promise<'sent' | 'gone'> {
  const directory = message.channel.address.directory
  if (!directory) return 'gone'
  const folder = join(directory, 'replies')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, `${message.id}.md`), message.text, 'utf8')
  return 'sent'
}

/** Thread 上下文：整个文件就是那条消息，没有更早的历史可读。 */
async function read(trigger: Trigger): Promise<{ messages: { id: string; from: string; at: string; text: string; path?: string }[]; body: Record<string, unknown> }> {
  const directory = typeof trigger.meta.directory === 'string' ? trigger.meta.directory : ''
  const file = typeof trigger.meta.file === 'string' ? trigger.meta.file : ''
  const text = directory && file ? await readFile(join(directory, file), 'utf8').catch(() => trigger.text) : trigger.text
  return { messages: [{ id: trigger.id, from: OPERATOR, at: trigger.at, text, ...file ? { path: join(directory, file) } : {} }], body: {} }
}

export const localKind: SourceKind<LocalConfig> = {
  kind: SOURCE,
  title: { zh: '本地工单目录', en: 'Local ticket directory' },
  description: {
    zh: '监听一个目录：每个 .md 文件是一条需求，改内容算同一工单的跟进；回复写到同目录的 replies/。',
    en: 'Watch a directory: one .md file per request, an edit is a follow-up on the same ticket, and replies land in replies/ beside it.',
  },
  facts: deployment => ({ directory: { zh: directoryOf({ directory: '' }, deployment?.stateDir ?? '.')
    , en: directoryOf({ directory: '' }, deployment?.stateDir ?? '.') } }),
  schema: LocalConfigSchema,
  fields: [
    { key: 'directory', label: { zh: '工单目录', en: 'Ticket directory' },
      hint: { zh: '绝对路径；留空用 <stateDir>/tasks。', en: 'Absolute path; empty means <stateDir>/tasks.' }, type: 'text' },
    { key: 'pollSeconds', label: { zh: '轮询间隔（秒）', en: 'Poll interval (s)' }, type: 'number', min: 5, max: 3600, advanced: true },
  ],
  health: ['local'],
  // 目录里的一切都要收；没有「顺带看到」的部分，因为每条都算直接请求。
  scope: () => ({ listened: true, observed: false }),
  policy: {
    schema: z.object({ allowed: z.array(AllowedSchema).default([{ id: OPERATOR, name: '本机操作者' }]) }).strict(),
    fields: [{ key: 'allowed', label: { zh: '可提需求的操作者', en: 'Operators who may ask' }, type: 'rows',
      columns: [{ key: 'id', label: { zh: '标识', en: 'ID' }, type: 'text' },
        { key: 'name', label: { zh: '名称', en: 'Name' }, type: 'text', optional: true }] }],
    explicit: { zh: '目录里的文件即直接请求', en: 'A file in the directory is a direct request' },
  },
  channel: {
    send: (host, message) => send(host, message),
    link: address => ({ url: '', label: { zh: `本地文件 ${address.file ?? ''}`, en: `Local file ${address.file ?? ''}` } }),
  },
  threadContext: {
    messageId: trigger => trigger.id,
    read: (_commands, trigger) => read(trigger),
  },
}

/** 扫一遍目录，收下新增或改过内容的文件。 */
export async function scan(ctx: SourceContext, directory: string, seen: Map<string, string>): Promise<number> {
  await mkdir(directory, { recursive: true })
  const names = (await readdir(directory)).filter(name => name.toLowerCase().endsWith('.md') && !name.startsWith('.'))
  for (const name of names) {
    const text = await readFile(join(directory, name), 'utf8').catch(() => undefined)
    if (text === undefined) continue
    const trigger = fileTrigger(name, text, new Date().toISOString(), directory)
    if (seen.get(name) === trigger.id) continue
    seen.set(name, trigger.id)
    await ctx.receive(trigger)
  }
  return names.length
}

/** 轮询循环：目录读不到就报错，读到就报 ready；停服时随 signal 退出。 */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  const seen = new Map<string, string>()
  let failures = 0
  await ctx.ready
  while (!signal.aborted) {
    const config = ctx.config<LocalConfig>(SOURCE)
    if (!config) {
      ctx.report('local', health('paused', 'sourceOff'))
      await pause(10_000, signal)
      continue
    }
    const directory = directoryOf(config, ctx.deployment.stateDir)
    try {
      const count = await scan(ctx, directory, seen)
      ctx.report('local', { state: 'ready', detail: `${count} 个工单文件` } satisfies Health)
      failures = 0
    } catch (error) {
      failures += 1
      if (failures >= 3) ctx.report('local', { state: 'error', detail: String(error) } satisfies Health)
    }
    await pause(config.pollSeconds * 1_000, signal)
  }
}

export const name = 'dsh-superagent-local'
export const inject = ['orchestrator']
/** 注册本地来源并起轮询；两个 effect 在插件卸载时一起收掉。 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(localKind), 'local: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, localKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('local', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
