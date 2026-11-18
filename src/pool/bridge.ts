/**
 * 委派工具：把一段自包含的活交给一个独立 worker 进程，立刻返回工单号，结果稍后回灌到发起会话。
 *
 * 委派池与主工单执行器分别限流：一票一进程、槽位固定、记录落在 `<stateDir>/pool`。
 * Codex 与 DSH 在这里是对等的两种 runtime——调用方点名要哪个，不点名就选本机第一个能起来的。
 */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { modelKeyEnv } from './credentials.ts'
import { isAbsolute, join } from 'node:path'
import { claudeRuntime } from './claude.ts'
import { codexRuntime } from './codex.ts'
import { dshRuntime } from './dsh.ts'
import { WorkerPool } from './pool.ts'
import type { RuntimeName, WorkerOutcome, WorkerRuntime, WorkerSpec, WorkerOwnership } from './types.ts'
import type { Runtime } from '../app/runtime.ts'
import { configuredRuntimes, readConnections } from './connections.ts'

/** 桥的配置：并发上限、dsh 用哪个 profile、是否启用 Codex、单票墙钟上限。 */
export interface WorkerBridgeOptions {
  /** 同时运行的 worker 进程上限；其余按提交顺序排队。 */
  maxWorkers?: number
  /** dsh runtime 启动 worker 用的 profile；profile 决定它有哪些工具与权限。 */
  dshProfile?: string
  /** 是否把 Codex 作为可选 runtime；本机没装 Codex 时它自己会报不可用。 */
  codex?: boolean
  codexProxyUrl?: string
  codexHttps?: boolean
  codexModelCatalog?: string
  codexConnectTimeoutMs?: number
  /** Enable Claude Code as an explicitly selectable worker. */
  claude?: boolean
  connectionsFile?: string
  /** 单个 worker 的墙钟上限，超时由进程池杀掉并记为 timeout。 */
  timeoutMs?: number
  /** 凭据文件位置；默认 `$DSH_HOME/.credentials.yaml`。测试可指向临时文件。 */
  credentialsFile?: string
}

/** 工单号形如 `codex-<uuid>` / `dsh-<uuid>`；状态与停止只接受这个形状，防止路径注入。 */
const TICKET_ID = /^[a-z][a-z0-9-]{0,31}-[a-f0-9-]+$/

/**
 * 找到 dsh 的 bin.js，改用当前 node 直接启动它。
 *
 * 本机没有把 `dsh` 装进 PATH，裸命令在 Windows 上会立刻失败（「'dsh' 不是内部或外部命令」）。
 * 用 `node <bin.js>` 既绕开 PATH，也绕开 shell 对带空格路径的解析。
 * 探测不到时返回空对象，回落到历史上裸 `dsh` 的行为。
 */
function dshLauncher(): { command?: string; baseArgs?: string[] } {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
  // 宿主自己就是 node + bin.js 时，那个 bin.js 最可信。
  const hosted = process.argv[1]
  const candidates = [
    hosted && /[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/i.test(hosted) ? hosted : undefined,
    join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return { command: process.execPath, baseArgs: [candidate] }
  }
  return {}
}

/**
 * 装上 worker 进程池与四个工具：`worker_start` / `worker_status` / `worker_stop` 以及 `codex_worker_*` 别名。
 *
 * 进程池在插件装配时就建好，池内并发由 `maxWorkers` 固定；一个目录同一时刻只允许一个 worker，
 * 因为两个进程写同一份工作副本是这类系统最常见的事故。
 */
export function installWorkers(ctx: Context, stateDir: string, options: WorkerBridgeOptions = {}): WorkerPool {
  const runtimes: WorkerRuntime[] = []
  const connections = readConnections(options.connectionsFile)
  if (options.codex !== false) runtimes.push(codexRuntime({ proxyUrl: options.codexProxyUrl,
    https: options.codexHttps, modelCatalog: options.codexModelCatalog, connectTimeoutMs: options.codexConnectTimeoutMs, ...connections.codex }))
  // dsh runtime 每个工单起一个 `dsh --profile <p> headless <任务书>` 进程：一轮一个任务，结束即退出。
  // 本机 PATH 上没有 `dsh`，所以用当前 node 直接跑 bin.js（见 dshLauncher）。
  runtimes.push(dshRuntime({ profile: options.dshProfile ?? 'headless', ...dshLauncher() }))
  if (options.claude !== false) runtimes.push(claudeRuntime(connections.claude))
  runtimes.push(...configuredRuntimes(connections))
  /** 同一目录同时只允许一个 worker 进程。 */
  const directories = new Set<string>()
  // dsh worker 是独立进程，拿不到宿主的凭据服务，模型 key 只能走环境变量。
  const dshEnv = modelKeyEnv(options.credentialsFile ?? `${process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? process.env.HOME ?? '.'}\\.dsh`}\\.credentials.yaml`)
  const pool = new WorkerPool({
    stateDir,
    maxWorkers: options.maxWorkers ?? 2,
    defaultTimeoutMs: options.timeoutMs ?? 30 * 60_000,
    runtimes,
    log: line => ctx.logger.warn('worker-pool: %s', line),
  })
  ctx.effect(() => () => pool.close('plugin disposed'))

  const register = (name: string, description: string, parameters: Record<string, unknown>,
    execute: (args: any, execution: any) => Promise<unknown>) => {
    ctx.tools.register({ name, description, parameters: { type: 'object', properties: parameters, additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] }, execute })
  }

  /** 没点名 runtime 时选本机第一个能起来的；都起不来就明确报错，而不是悄悄换一个。 */
  const resolveRuntime = async (asked?: RuntimeName): Promise<RuntimeName> => {
    if (asked) return asked
    for (const runtime of runtimes) if (await runtime.available()) return runtime.name
    throw new Error('没有可用的 worker runtime：Codex 未安装，dsh 也起不来。')
  }
  const ownerOf = async (sessionId: string): Promise<WorkerOwnership> => {
    const sessions = (ctx as Context & { orchestrator?: Runtime }).orchestrator?.sessions
    return sessions ? sessions.processOwner(sessionId) : { ownerSessionId: sessionId, rootSessionId: sessionId }
  }
  const visible = async (record: import('./table.ts').WorkerRecord, execution: any) => {
    const id = execution?.agent?.id
    if (!id) return true // Host/operator calls have no agent scope.
    const owner = await ownerOf(String(id))
    if (record.ownerSessionId === id) return true
    if (!record.rootSessionId || record.rootSessionId !== owner.rootSessionId) return false
    return owner.rootSessionId === id || !!owner.parentTicketId && owner.parentTicketId === record.parentTicketId
  }

  /** 校验目录与独占，入池排队；进程结束后把结果写盘并回灌给发起它的会话。 */
  const start = async (args: { directory?: unknown; prompt?: unknown; runtime?: unknown }, execution: any) => {
    if (typeof args.directory !== 'string' || !isAbsolute(args.directory) || typeof args.prompt !== 'string' || !args.prompt.trim())
      throw new Error('directory and prompt are required; directory must be absolute')
    const asked = args.runtime === undefined ? undefined : runtimes.find(runtime => runtime.name === args.runtime)?.name
    if (args.runtime !== undefined && asked === undefined) throw new Error('Unknown or disabled worker runtime')
    const directory = await realpath(args.directory)
    const directoryKey = process.platform === 'win32' ? directory.toLowerCase() : directory
    if (directories.has(directoryKey)) throw new Error('A worker already owns this directory')
    const runtime = await resolveRuntime(asked)
    const ownerSessionId = execution?.agent?.id && String(execution.agent.id)
    if (!ownerSessionId) throw new Error('worker_start requires a requesting Session')
    const ownership = await ownerOf(ownerSessionId)
    // Runtime detection awaits; another simultaneous call may have reserved this directory meanwhile.
    if (directories.has(directoryKey)) throw new Error('A worker already owns this directory')
    const ticket = `${runtime}-${randomUUID()}`
    directories.add(directoryKey)
    const resultFile = join(stateDir, 'pool', 'results', `${ticket}.json`)
    const spec: WorkerSpec = { ticket, directory, prompt: args.prompt, runtime,
      ...ownership,
      ...(runtime === 'dsh' && Object.keys(dshEnv).length ? { env: dshEnv } : {}) }
    void pool.submit(spec).then(async (outcome: WorkerOutcome) => {
      await mkdir(join(stateDir, 'pool', 'results'), { recursive: true })
      await writeFile(resultFile, JSON.stringify(outcome), 'utf8')
      const agent = execution?.agent
      // 结果回灌：worker 结束时发起会话通常已经空闲，这条 followup 会把它叫醒。
      if (agent && ctx.agents.get(agent.id) === agent) agent.followup({ id: randomUUID(), role: 'user',
        content: [{ type: 'text', text: `${runtime} worker ${ticket} ${outcome.state}:\n${outcome.artifacts.summary}` }],
        source: { kind: 'dsh-superagent', form: 'notice', summary: `${runtime} worker completed` } })
    }).catch(error => ctx.logger.error('worker %s: %s', ticket, String(error)))
      .finally(() => { directories.delete(directoryKey) })
    return { ticket, runtime, state: 'queued', directory, resultFile, ...ownership }
  }

  /** 列出全部工单记录，或读一张工单的状态与最终结果。 */
  const status = async (args: { ticket?: unknown }, execution?: any) => {
    if (args.ticket !== undefined && (typeof args.ticket !== 'string' || !TICKET_ID.test(args.ticket))) throw new Error('Invalid ticket')
    const records = await pool.records()
    const allowed = (await Promise.all(records.map(async record => await visible(record, execution) ? record : undefined)))
      .filter(record => record !== undefined)
    if (!args.ticket) return { workers: allowed, queued: pool.waiting.filter(id => allowed.some(record => record.ticket === id)) }
    const record = allowed.find(row => row.ticket === args.ticket)
    if (!record) throw new Error('Unknown worker or worker belongs to another Session')
    const result = await readFile(join(stateDir, 'pool', 'results', `${args.ticket}.json`), 'utf8').catch(() => undefined)
    return result ? { ...JSON.parse(result), record } : { record, queued: pool.waiting.includes(args.ticket as string) }
  }

  /** 取消排队或启动中的任务，或停止运行中的整棵进程树。 */
  const stop = async (args: { ticket?: unknown }, execution?: any) => {
    if (typeof args.ticket !== 'string' || !TICKET_ID.test(args.ticket)) throw new Error('Invalid ticket')
    const record = (await pool.records()).find(row => row.ticket === args.ticket)
    if (!record || !await visible(record, execution)) throw new Error('Unknown worker or worker belongs to another Session')
    if (!await pool.stop(args.ticket)) throw new Error('No queued or running worker with that ticket')
    return { stopped: true, ticket: args.ticket }
  }

  const DIRECTORY = { type: 'string', description: 'Absolute existing ticket/worktree directory.' }
  const PROMPT = { type: 'string', description: 'Self-contained handoff: original goal, allowed read-only/writable paths, dependencies, expected result and acceptance checks. For troubleshooting include real errors and attempted approaches; for review include actual changes/evidence and request actionable findings.' }
  const RUNTIME = { type: 'string', enum: runtimes.map(runtime => runtime.name),
    description: "Who runs it: 'codex' for hard or visual work, 'dsh' for project-convention work, 'claude' for Claude Code. Omit for the first runtime this machine can start." }

  register('worker_start', 'Start one worker process (a real OS process, not a Session) on a directory and return a ticket at once. One worker per directory; collect the result with worker_status.', {
    directory: DIRECTORY, prompt: PROMPT, runtime: RUNTIME,
  }, start)
  register('worker_status', 'Read a worker state, ancestry and final answer. Omit ticket to list workers belonging to this Session or its work order. Main Sessions see their own tree. Results survive DSH restarts.', {
    ticket: { type: 'string' },
  }, status)
  register('worker_stop', 'Cancel a queued or starting worker, or stop a running worker and every process it started.', { ticket: { type: 'string' } }, stop)

  // 旧名字保留：既有会话与提示词里写的是 codex_worker_*，行为不变，只是固定走 Codex。
  register('codex_worker_start', 'Start a Codex process for technical consultation, required independent module review, or a difficult task. Requested consultation/review does not require prior failures. Returns immediately; bind the ticket to orchestrator_plan. Give the working directory, allowed paths, source context and acceptance checks. Do not edit that directory concurrently; collect the result with codex_worker_status.', {
    directory: DIRECTORY, prompt: PROMPT,
  }, (args: any, execution: any) => start({ ...args, runtime: 'codex' }, execution))
  register('codex_worker_status', 'Read Codex worker state and final answer. Omit ticket to list recorded workers. Completed results survive DSH restarts.', {
    ticket: { type: 'string' },
  }, status)
  register('codex_worker_stop', 'Stop a running Codex worker and its child processes.', { ticket: { type: 'string' } }, stop)
  return pool
}

/** 通用别名；新代码用这个名字表达「这里不只有 Codex」。 */
export const installCodexWorkers = installWorkers
