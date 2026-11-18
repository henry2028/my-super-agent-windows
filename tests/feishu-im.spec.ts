/** Existing verified work-order bot intake preserves identity, threading and durable acknowledgement. */
import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { consumeIm, imTrigger } from '../src/sources/feishu-im.ts'
import { commandArgv } from '../src/platform/index.ts'
import { apply as applyGithub } from '../src/sources/github.ts'
const fingerprint = createHash('sha256').update(JSON.stringify({ provider: 'feishu', domain: 'feishu', appId: 'cli_work', botOpenId: 'ou_bot' })).digest('hex')
const event = { botId: 'bot_work', fingerprint, messageId: 'om_one', actor: { kind: 'user', id: 'ou_owner' },
  conversation: { kind: 'dm', id: 'oc_dm' }, mentions: [], at: '2026-11-09T00:00:00Z', text: 'fix a bug', reply: { rootId: 'om_root' } }
const source = () => ({ deployment: { feishu: { botId: 'ou_bot', appId: 'cli_work', brand: 'feishu' } }, config: () => ({ imBotId: 'bot_work' }), report: vi.fn(), receive: vi.fn(async () => ({})) })
it('preserves native message identity, sender and thread across redelivery', () => {
  const ctx = source()
  const trigger = imTrigger(event, ctx as never)!
  expect(trigger).toMatchObject({ source: 'feishu', addressed: 'direct', text: 'fix a bug', actor: { id: 'ou_owner' }, meta: { rootId: 'om_root' } })
  expect(imTrigger({ ...event }, ctx as never)?.id).toBe(trigger.id)
})
it('takes an exclusive lease for the selected bot and acknowledges only after intake commits', async () => {
  const ctx = source(), stop = new AbortController(), release = vi.fn()
  let accept: any
  const service = { describeBot: vi.fn(async () => ({ connected: true, account: { fingerprint: event.fingerprint }, capabilities: ['exclusive-text-consumer'] })),
    consumeInbound: vi.fn(async (_id, options) => { accept = options.onEvent; return release }) }
  const running = consumeIm({ get: () => service } as never, ctx as never, stop.signal)
  await expect.poll(() => accept).toBeTypeOf('function')
  expect(service.consumeInbound.mock.calls[0]?.[0]).toBe('bot_work')
  await expect(accept(event, { signal: stop.signal })).resolves.toEqual({ accepted: true })
  expect(ctx.receive).toHaveBeenCalledTimes(1)
  ctx.receive.mockRejectedValueOnce(new Error('commit failed'))
  await expect(accept(event, { signal: stop.signal })).rejects.toThrow('commit failed')
  await expect(accept({ ...event, botId: 'bot_personal' }, { signal: stop.signal })).rejects.toThrow('identity changed')
  stop.abort(); await running; expect(release).toHaveBeenCalledTimes(1)
})
it('passes literal arguments through a Node CLI wrapper without a command shell', () => {
  const args = ['a & b', '中文', '"quoted"', '%PATH%', 'line\nnext']
  expect(commandArgv('C:/bot.mjs', args)).toEqual([process.execPath, 'C:/bot.mjs', ...args])
})
it('keeps an unconfigured local deployment from launching empty GitHub polls', async () => {
  const report = vi.fn(), commands = { api: vi.fn() }, disposers: any[] = []
  const source = { ready: Promise.resolve(), configured: () => true, deployment: { repository: '', github: { cli: '' } }, report, commands }
  applyGithub({ orchestrator: { sources: { register: () => () => {} }, context: () => source }, effect: (setup: any) => { disposers.push(setup()) } } as never)
  await expect.poll(() => report.mock.calls.length).toBe(1)
  expect(report.mock.calls[0]?.[1]).toMatchObject({ state: 'paused', code: 'setupPending' })
  expect(commands.api).not.toHaveBeenCalled()
  for (const dispose of disposers) await dispose()
})
