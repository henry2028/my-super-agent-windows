/** 本地工单源与本地部署模式：不接 GitHub 也能接单。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { resolveDeployment } from '../src/deployment.ts'
import { fileTrigger, localKind, OPERATOR, scan } from '../src/sources/local.ts'

const temp = () => mkdtemp(join(tmpdir(), 'local-source-'))
const cleanup = (directory: string) => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })

it('turns a file into a direct request from the operator, and keeps the id stable per content', () => {
  const trigger = fileTrigger('fix-login.md', '登录页有个 typo', '2026-11-07T00:00:00.000Z', 'C:/tasks')
  expect(trigger).toMatchObject({
    source: 'local',
    addressed: 'direct',
    human: true,
    actor: { source: 'local', id: OPERATOR },
    // key() 会对字符串做摘要，所以只断言 Thread 的来源与稳定性。
    threads: [{ source: 'local' }],
    meta: { file: 'fix-login.md', directory: 'C:/tasks' },
  })
  // 同一内容重复扫描得到同一个 id（登记幂等），改内容才换 id（同一 Thread 上的跟进）。
  const again = fileTrigger('fix-login.md', '登录页有个 typo', '2026-11-07T00:01:00.000Z', 'C:/tasks')
  expect(again.id).toBe(trigger.id)
  const edited = fileTrigger('fix-login.md', '登录页有个 typo，另外按钮也歪了', '2026-11-07T00:02:00.000Z', 'C:/tasks')
  expect(edited.id).not.toBe(trigger.id)
  expect(edited.threads).toEqual(trigger.threads)
})

it('listens to every file and authorizes the operator by default', () => {
  expect(localKind.scope?.({ meta: {} }, { directory: '', pollSeconds: 10 })).toEqual({ listened: true, observed: false })
  // 默认策略里就要有 operator，否则闸门会把本地文件判成「未授权的人」。
  expect(localKind.policy?.schema.parse({})).toMatchObject({ allowed: [{ id: OPERATOR }] })
})

it('writes replies beside the ticket files', async () => {
  const directory = await temp()
  try {
    await localKind.channel!.send({ commands: {} as never }, {
      id: 'reply-1', channel: { source: 'local', thread: 'local:a.md', address: { file: 'a.md', directory } },
      text: '已经修好了', kind: 'reply',
    })
    await expect(readFile(join(directory, 'replies', 'reply-1.md'), 'utf8')).resolves.toBe('已经修好了')
  } finally { await cleanup(directory) }
})

it('ingests each file once and once more after an edit', async () => {
  const directory = await temp()
  const received: { id: string; text: string }[] = []
  const ctx = { receive: (trigger: { id: string; text: string }) => { received.push(trigger); return { triggerId: trigger.id, threads: [] } } } as never
  const seen = new Map<string, string>()
  try {
    await writeFile(join(directory, 'one.md'), '第一件事', 'utf8')
    await writeFile(join(directory, 'two.md'), '第二件事', 'utf8')
    await writeFile(join(directory, 'notes.txt'), '不是工单', 'utf8')
    expect(await scan(ctx, directory, seen)).toBe(2)
    expect(received.map(item => item.text).sort()).toEqual(['第一件事', '第二件事'].sort())
    // 再扫一遍：内容没变，不重复收单。
    expect(await scan(ctx, directory, seen)).toBe(2)
    expect(received).toHaveLength(2)
    // 改一个文件：只新的那条进队列。
    await writeFile(join(directory, 'one.md'), '第一件事，加一条', 'utf8')
    await scan(ctx, directory, seen)
    expect(received).toHaveLength(3)
    expect(received.at(-1)?.text).toBe('第一件事，加一条')
  } finally { await cleanup(directory) }
})

it('resolves a local deployment without a repository and without probing GitHub', async () => {
  const probe = vi.fn(async () => { throw new Error('probe must not run in local mode') })
  const machine = { stateDir: 'C:/state', promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }
  const deployment = await resolveDeployment(machine as never, { repository: '', cli: '' }, probe as never)
  expect(deployment).toMatchObject({ mode: 'local', repository: '', github: { login: '', cli: '' } })
  expect(probe).not.toHaveBeenCalled()
})
