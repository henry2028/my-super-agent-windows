/** Reuse dsh-im's verified bot connection, exclusively, instead of competing WebSockets. */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { pause } from './poll.ts'
import { feishuTrigger } from './feishu-trigger.ts'
import type { SourceContext } from './host.ts'

export interface ImTextEvent {
  botId: string; fingerprint: string; messageId: string; actor: { kind: string; id: string }
  conversation: { kind: string; id: string }; mentions: { id: string; key?: string; name?: string }[]
  at: string; text: string; reply: { rootId?: string; parentId?: string; threadId?: string }
}
export function imTrigger(event: ImTextEvent, source: SourceContext) {
  const bot = source.deployment.feishu!
  return feishuTrigger({ message_id: event.messageId, chat_id: event.conversation.id,
    chat_type: event.conversation.kind === 'dm' ? 'p2p' : 'group', sender_id: event.actor.id,
    sender_type: event.actor.kind === 'user' ? 'user' : 'bot', content: event.text, create_time: event.at,
    mentions: event.mentions, root_id: event.reply.rootId, parent_id: event.reply.parentId, thread_id: event.reply.threadId }, bot.botId, bot.appId)
}
interface ImService {
  describeBot(id: string): Promise<{ connected: boolean; account: { fingerprint: string }; capabilities: string[] }>
  consumeInbound(id: string, options: { expectedFingerprint: string; signal: AbortSignal; onEvent(event: ImTextEvent, options: { signal: AbortSignal }): Promise<{ accepted: true }> }): Promise<() => void>
}
export async function consumeIm(ctx: Context, source: SourceContext, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const config = source.config<{ imBotId: string }>('feishu')
    const service = ctx.get('dshIm') as ImService | undefined
    if (!config || !service) { source.report('feishu', { state: 'paused', detail: 'Waiting for dsh-im bot service' }); await pause(5000, signal); continue }
    let release: (() => void) | undefined
    try {
      const account = await service.describeBot(config.imBotId)
      const bot = source.deployment.feishu
      if (!bot) throw new Error('Feishu CLI identity has not passed setup')
      const fingerprint = createHash('sha256').update(JSON.stringify({ provider: 'feishu', domain: bot.brand, appId: bot.appId, botOpenId: bot.botId })).digest('hex')
      if (account.account.fingerprint !== fingerprint) throw new Error('The selected DSH bot and Feishu CLI are different accounts')
      if (!account.connected) throw new Error('工单机器人尚未连接飞书')
      if (!account.capabilities.includes('exclusive-text-consumer')) throw new Error('dsh-im does not support exclusive intake')
      release = await service.consumeInbound(config.imBotId, { expectedFingerprint: account.account.fingerprint, signal,
        async onEvent(event, delivery) {
          delivery.signal.throwIfAborted()
          if (event.botId !== config.imBotId || event.fingerprint !== account.account.fingerprint) throw new Error('Feishu bot identity changed')
          if (!source.config('feishu')) return { accepted: true }
          const trigger = imTrigger(event, source)
          if (trigger) await source.receive(trigger)
          delivery.signal.throwIfAborted()
          return { accepted: true }
        } })
      source.report('feishu', { state: 'ready', detail: 'Listening through the verified dsh-im work-order bot; /workspace commands enabled', at: new Date().toISOString() })
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })
    } catch (error) { if (!signal.aborted) source.report('feishu', { state: 'error', detail: String(error) }) }
    finally { release?.() }
    if (!signal.aborted) await pause(5000, signal)
  }
}
