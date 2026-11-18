/** Deterministic workspace commands for the bot's exclusive Super-agent intake. */
import type { Context } from '@deepseek-ai/cordis'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { key, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { allowedSender } from '../policy.ts'
import { wordCount } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { Runtime } from '../app/runtime.ts'

const COMMAND = /^\/(workspace|ws|workspacelist|workspaces|wsl|help|menu|m)(?:\s+([\s\S]*))?$/i
const clean = (text: string) => text.trim().replace(/^@[^\r\n]+\s+(?=\/)/u, '')
export const isWorkspaceCommand = (text: string): boolean => COMMAND.test(clean(text))
const label = (text: string) => text.replace(/[\r\n]/g, ' ').slice(0, 24)
const pathLabel = (path: string) => {
  let text = path
  while (wordCount(text) > 25) text = text.slice(0, -8)
  return text === path ? text : `${text}…`
}
const HELP = '/ws 查看工作区；/ws 序号 或 /ws 绝对路径 切换；/ws --default 返回 Super-agent。\n选择按当前聊天和用户保存，移动主调度及当前工单，用于后续新工单；子 worker 随工单归组。执行目录仍按工单确定。'

/** Wrap all live intake paths; command messages never enter evaluation or become work orders. */
export function withFeishuWorkspaces(ctx: Context, source: SourceContext): SourceContext {
  const runtime = ctx.orchestrator as Runtime, registry = ctx.workspaceRegistry, store = runtime.store
  let chain = Promise.resolve<ReceiveResult>('stored')
  const wrapped = Object.create(source) as SourceContext
  wrapped.receive = trigger => {
    const next = chain.then(() => receive(trigger))
    chain = next.catch(() => 'stored')
    return next
  }
  const scopeOf = (trigger: Trigger) => key(source.deployment.feishu!.appId, String(trigger.meta.chatId), trigger.actor.id)
  const reply = (trigger: Trigger, text: string) => {
    if (!trigger.channel) return
    source.notify({ id: key('feishu-workspace-command', trigger.id), channel: trigger.channel, kind: 'reply', text })
  }
  const currentTicket = (trigger: Trigger): Ticket | undefined => {
    const candidates = store.tickets.list().filter(ticket => {
      const origin = store.triggers.get(ticket.origin.triggerId)
      return origin?.source === 'feishu' && origin.actor.id === trigger.actor.id && origin.meta.chatId === trigger.meta.chatId
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const root = trigger.meta.rootId ?? trigger.meta.parentId
    if (root) return candidates.find(ticket => {
      const origin = store.triggers.get(ticket.origin.triggerId)!
      return root === origin.meta.messageId || root === origin.meta.rootId
    })
    const open = candidates.filter(ticket => !ticket.ended)
    return open.length === 1 ? open[0] : open.length ? undefined : candidates[0]
  }
  async function receive(trigger: Trigger): Promise<ReceiveResult> {
    const match = COMMAND.exec(clean(trigger.text))
    const permitted = trigger.human && !!trigger.addressed && !!allowedSender(store.settings(), trigger.actor) && runtime.sources.scope(trigger).listened
    if (!permitted) return match ? 'filtered' : source.receive(trigger)
    const scope = scopeOf(trigger), selected = store.get(KV.feishu.workspace(scope))
    if (!match) {
      if (!selected) return source.receive(trigger)
      const workspace = registry.get(selected.id as never)
      if (!workspace) { reply(trigger, '之前选择的工作区已被移除。请发送 /ws 重新选择后再派工单。'); return 'filtered' }
      return source.receive({ ...trigger, meta: { ...trigger.meta, workspaceId: workspace.id, workspacePath: workspace.path } })
    }
    if (store.get(KV.feishu.command(trigger.id))) return 'duplicate'
    const command = match[1]!.toLowerCase(), argument = (match[2] ?? '').trim()
    let text: string
    if (['help', 'menu', 'm'].includes(command)) text = HELP
    else if (!argument || ['workspacelist', 'workspaces', 'wsl'].includes(command) || /^--page\s+\d+$/.test(argument)) {
      const entries = registry.list()
      const pages: string[][] = [[]]
      const footer = '\n/ws 序号切换；/ws --page 页码翻页；/ws --default 返回默认。'
      for (const [index, workspace] of entries.entries()) {
        const row = `${index + 1}. ${label(workspace.title)}${workspace.id === selected?.id ? '（当前）' : ''}`
        let page = pages.at(-1)!
        if (page.length && (page.length >= 5 || wordCount(`工作区\n${[...page, row].join('\n')}${footer}`) > 90)) {
          page = []; pages.push(page)
        }
        page.push(row)
      }
      const page = argument.startsWith('--page') ? Number(argument.split(/\s+/)[1]) : 1
      text = page < 1 || page > pages.length ? `只有 ${pages.length} 页工作区，发送 /ws 重新查看。`
        : `工作区 ${page}/${pages.length}\n${pages[page - 1]!.join('\n') || '暂无工作区'}${footer}`
      store.set(KV.feishu.workspaceMenu(scope), { ids: entries.map(workspace => workspace.id), at: new Date().toISOString() })
    } else {
      const now = new Date().toISOString()
      if (selected && trigger.at < selected.at) text = '这条切换指令早于当前工作区设置，已忽略。'
      else {
        let workspace
        if (argument === '--default') workspace = await registry.create(runtime.machine.stateDir, 'Super-agent')
        else if (/^[1-9]\d*$/.test(argument)) {
          const menu = store.get(KV.feishu.workspaceMenu(scope))
          const id = menu && Date.parse(now) - Date.parse(menu.at) <= 15 * 60_000 ? menu.ids[Number(argument) - 1] : undefined
          workspace = id && registry.get(id as never)
        } else {
          const path = argument.replace(/^(["'])(.*)\1$/s, '$2')
          if (isAbsolute(path)) {
            const info = await stat(path).catch(() => undefined)
            if (info?.isDirectory()) workspace = await registry.create(path)
          }
        }
        if (!workspace) text = '工作区无效或列表已过期。请先发送 /ws，再用 /ws 序号选择；也可提供已存在目录的绝对路径。'
        else {
          const ticket = currentTicket(trigger)
          if (ticket) await runtime.sessions.moveWorkspace(`worker-${ticket.id}`, workspace.id)
          await runtime.sessions.moveMainWorkspace(workspace.id)
          store.set(KV.feishu.workspace(scope), { id: workspace.id, at: trigger.at })
          text = `已选择：${label(workspace.title)}\n${pathLabel(workspace.path)}\n主调度会话已移入。${ticket ? '当前工单及子 worker 已归组，新工单也将归入此处。' : '后续新工单将归入此处；引用具体工单原消息执行可移动该会话。'}\n执行目录仍按工单确定。`
        }
      }
    }
    source.atomic(() => {
      reply(trigger, text)
      store.set(KV.feishu.command(trigger.id), true)
    })
    return 'stored'
  }
  return wrapped
}
