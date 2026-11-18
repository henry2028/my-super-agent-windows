/**
 * 进程执行器：每张票一个 `dsh --profile <p> headless <任务书>` 进程。
 *
 * 与 Session 执行器的区别只有两点：worker 死在独立进程里（崩了、被杀都不连坐），
 * 以及进程不能在回合中途插话——人补的话留到下一轮，用同一个目录再起一个进程接着做。
 * 状态仍走原来的 Engine 回调，所以面板、Ticket 生命周期与 Session 模式完全一致。
 */
import { mkdir, readFile, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AssessmentOutcome, Assignment, Executor, ReportState, Ticket, TicketInput } from '../core/index.ts'
import { liveTicket, runningAssignment } from '../core/index.ts'
import { runAsWorker, verifyDirectory } from '../infra/environment.ts'
import { shellArgv } from '../platform/index.ts'
import { WorkerPool } from '../pool/pool.ts'
import { dshRuntime } from '../pool/dsh.ts'
import { modelKeyEnv } from '../pool/credentials.ts'
import type { WorkerRuntime } from '../pool/types.ts'
import { ticketExecution, type ExecutorHost } from './dsh.ts'

/** 工单目录准备命令的最长运行时间。 */
const PREPARE_TIMEOUT_MS = 10 * 60_000
/** worker 结束时读的回执文件；它决定这一轮是 waiting 还是 failed。 */
const REPORT_FILE = '.superagent/report.md'
const STATES: readonly ReportState[] = ['waiting', 'ready', 'failed', 'blocked', 'dropped']

/**
 * 每票一个进程的执行器。
 *
 * 它只做三件事：把 Engine 的 start/deliver/stop 换成进程池动作、把进程结束翻译成一次 report、
 * 在进程之间用同一目录接住人补的话。Ticket 生命周期、面板与策略都仍由 Engine 决定。
 */
export class ProcessExecutor implements Executor {
  private readonly pool: WorkerPool
  /** 正在跑的进程，按票记；值里攒的是进程结束后要接着吃的用户输入。 */
  private readonly active = new Map<string, { followups: TicketInput[] }>()

  constructor(private readonly host: ExecutorHost, deps: { runtimes?: WorkerRuntime[] } = {}) {
    const settings = host.store.settings().executor
    this.pool = new WorkerPool({
      stateDir: host.machine.stateDir,
      maxWorkers: host.machine.maxWorkers,
      defaultTimeoutMs: settings.workerTimeoutMinutes * 60_000,
      runtimes: deps.runtimes ?? [dshRuntime({ profile: settings.workerProfile })],
      log: line => host.context.logger.info('[process-executor] %s', line),
    })
    // 上次宿主退出时留下的 running 记录，进程多半已经不在了：启动时先纠正。
    void this.pool.reconcile().catch(() => { /* 记录写不进去不影响接单 */ })
  }

  /** 与 Session 执行器同一套工单目录与作业书。 */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return { ...ticket, execution: ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir) }
  }

  /** 进程模式没有需要订阅的宿主事件。 */
  install(): void { /* 不订阅 agent/* 事件 */ }

  /** 启动时纠正僵死记录；有待办的需求会由 Engine 在新输入时重新调 start。 */
  resume(): void { void this.pool.reconcile().catch(() => { /* 同上 */ }) }

  /** 面板上的「正在执行」。 */
  activeCount(): number { return this.active.size }

  /** 停掉所有 worker 进程并等它们真的结束。 */
  async shutdown(): Promise<void> {
    await this.pool.close('dsh-superagent is stopping')
    this.active.clear()
  }

  /** 进程池在 shutdown 里关掉，这里没有额外订阅要释放。 */
  dispose(): void { /* 无订阅 */ }

  /** 取一个进程槽并起 worker；立刻返回，结果通过 Engine 回调上报。 */
  start(ticket: Ticket, assignment: Assignment): void {
    void this.launch(ticket, assignment).catch(error => {
      this.report(ticket.id, { state: 'failed', summary: String(error) })
    })
  }

  /**
   * 进程不能在回合中插话：把待投递的输入记账为已投递、已读，记在这一票的下一轮里。
   * 如果当前没有进程在跑，就按启动处理。
   */
  deliver(ticket: Ticket, assignment: Assignment): void {
    const pending = ticket.undelivered.map(id => ticket.inputs.find(item => item.id === id)).filter((item): item is TicketInput => !!item)
    if (!pending.length) return
    const entry = this.active.get(ticket.id)
    if (!entry) { this.start(ticket, assignment); return }
    entry.followups.push(...pending)
    this.host.engine.inputsDelivered(ticket.id, assignment.id, pending.map(item => item.id))
    this.host.engine.inputsRead(ticket.id, pending.map(item => item.id))
  }

  /** 杀掉整棵进程树；Engine 已经先把票标成结束，这里只负责收尸。 */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    void this.pool.stop(ticket.id, reason).catch(error => this.host.context.logger.warn('stop %s: %s', ticket.id, String(error)))
  }

  /** 运行一轮：准备目录 → 起进程 → 等结束 → 读回执 → 上报；结束后处理攒下的跟话。 */
  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    const directory = ticket.execution?.directory ?? ''
    try {
      await this.prepareDirectory(ticket, directory)
    } catch (error) {
      this.report(ticket.id, { state: 'failed', summary: `准备工单目录失败：${String(error)}` })
      return
    }
    if (this.host.closing()) return
    const entry = { followups: [] as TicketInput[] }
    this.active.set(ticket.id, entry)
    this.host.engine.assignmentStarted(ticket.id, assignment.id)
    try {
      // worker 进程拿不到宿主的凭据服务，模型 key 只能靠环境变量带过去。
      const env = modelKeyEnv()
      const outcome = await this.pool.submit({ ticket: ticket.id, directory, prompt: this.brief(ticket, directory), runtime: 'dsh',
        ...(Object.keys(env).length ? { env } : {}) })
      this.report(ticket.id, await this.result(directory, outcome.state === 'finished', outcome.artifacts.summary))
    } catch (error) {
      this.report(ticket.id, { state: 'failed', summary: String(error) })
    } finally {
      this.active.delete(ticket.id)
      const current = this.host.store.tickets.get(ticket.id)
      const running = current && liveTicket(current) ? runningAssignment(current) : undefined
      // 这一轮里人补的话，用同一个目录再起一个进程接着做。
      if (running && entry.followups.length && !this.host.closing()) void this.launch(current!, running)
    }
  }

  /** 上报一次，票已经结束或状态不允许时只记日志。 */
  private report(ticketId: string, report: { state: ReportState; summary: string }): void {
    try {
      this.host.store.atomic(() => this.host.engine.report(ticketId, report))
    } catch (error) {
      this.host.context.logger.warn('report %s: %s', ticketId, String(error))
    }
  }

  /** 首次启动时按 prepare 命令建目录；目录已存在就当作已准备好。 */
  private async prepareDirectory(ticket: Ticket, directory: string): Promise<void> {
    const exists = await stat(directory).then(info => info.isDirectory(), () => false)
    if (exists) return
    await mkdir(dirname(directory), { recursive: true })
    const command = this.host.store.settings().executor.prepare.trim()
    const env = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
    if (command) await runAsWorker(this.host.context.subprocess, shellArgv(command, process.env.PATH ?? ''), dirname(directory), signal, env)
      .catch(async (error: unknown) => { await rmdir(directory).catch(() => { /* 目录里有命令写的东西，就留着 */ }); throw error })
    await mkdir(directory, { recursive: true })
    await verifyDirectory(directory, this.host.context.subprocess, this.host.lifetime)
  }

  /** 一轮的任务书：它是自包含的，进程没有上下文可以回看。 */
  private brief(ticket: Ticket, directory: string): string {
    return [
      `You are the executor of ticket ${ticket.id}: ${ticket.title}`,
      `Work only inside ${directory}. Read what you need, change what the request needs, and run the checks it implies.`,
      ticket.execution?.assignment ?? '',
      `End the turn by writing ${REPORT_FILE}: the first line is one of waiting, ready or failed, and the rest is a short summary a person can act on.`,
      'A person\'s follow-up arrives as a new turn in a new process; do not wait for one.',
    ].filter(Boolean).join('\n\n')
  }

  /** 进程退出码 + 回执文件决定这一轮的上报状态。 */
  private async result(directory: string, ok: boolean, summary: string): Promise<{ state: ReportState; summary: string }> {
    const text = await readFile(join(directory, REPORT_FILE), 'utf8').catch(() => '')
    const [head = '', ...rest] = text.trim().split(/\r?\n/)
    const declared = STATES.find(state => head.trim().toLowerCase() === state)
    const body = rest.join('\n').trim()
    return { state: ok ? declared ?? 'waiting' : 'failed', summary: body || summary.slice(-2000) || (ok ? '进程结束，没有留下回执' : '进程失败') }
  }
}
