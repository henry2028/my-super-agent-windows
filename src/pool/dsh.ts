/**
 * The DSH runtime: one `dsh headless` process per Ticket.
 *
 * Headless answers one task, prints the result, and exits, which is exactly one worker turn. It has no channel back
 * into the process, so `post` refuses rather than pretending: a follow-up starts a new process in the same
 * directory, which is the Ticket's continuity, not the process's.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { WorkerArtifacts, WorkerHandle, WorkerIo, WorkerRuntime, WorkerSpec, WorkerState, WorkerStatus } from './types.ts'

export interface DshRuntimeOptions {
  /** DSH profile that composes this deployment's worker preset. */
  profile: string
  /** The launcher; `dsh` on PATH unless a deployment pins an absolute path. */
  command?: string
  /** 前缀参数：用 `node <bin.js>` 启动时放 bin.js 的绝对路径，此时不再经 shell。 */
  baseArgs?: string[]
  /** Injected in tests to avoid starting real processes. */
  spawn?: typeof nodeSpawn
  platform?: NodeJS.Platform
  /** How long a stopped worker gets before it is killed outright. */
  graceMs?: number
}

const tail = (text: string, lines = 20): string => text.split('\n').filter(Boolean).slice(-lines).join('\n')

/**
 * 去掉 headless 进程打到 stdout 的启动日志（形如 `[llm-deepseek-api-key] ...`），正文原样保留。
 *
 * 只匹配「整行以 [小写标识] 开头」这种模型，避免误删正文里的 `| [x] |` 表格单元格。
 * reasoning 段（`dsh: reasoning:` 之后）目前没有稳定分隔符，暂不切分，保留是为了不丢内容。
 */
const stripLogLines = (text: string): string =>
  text.split('\n').filter(line => !/^\s*\[[a-z0-9._-]+\]/i.test(line)).join('\n').trim()

export function dshRuntime(options: DshRuntimeOptions): WorkerRuntime {
  const platform = options.platform ?? process.platform
  const invoke = options.spawn ?? nodeSpawn
  const command = options.command ?? 'dsh'
  const graceMs = options.graceMs ?? 5_000

  return {
    name: 'dsh',
    async available(): Promise<boolean> {
      // A launcher that cannot be found fails at start; the pool then reports the reason instead of hanging.
      return true
    },
    async start(spec: WorkerSpec, io: WorkerIo): Promise<WorkerHandle> {
      const argv = [...(options.baseArgs ?? []), '--profile', options.profile, 'headless', '--json', '-']
      const child: ChildProcess = invoke(command, argv, {
        cwd: spec.directory,
        env: { ...process.env, ...spec.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        // 走 `node <bin.js>` 时子进程就是 node 本身，不需要 shell；
        // 只有裸 `dsh`（PATH 上的 .cmd）才必须经 shell 解析。
        shell: platform === 'win32' && !options.baseArgs?.length,
        windowsHide: true,
      })
      let state: WorkerState = 'starting'
      let output = ''
      let pending = ''
      const decoder = new StringDecoder('utf8')
      let sessionId: string | undefined
      let finalText: string | undefined
      let lastActivity = new Date().toISOString()
      const ended = new Promise<{ code: number | null; signal: string | null }>(resolve => {
        child.once('close', (code, signal) => resolve({ code, signal }))
        child.once('error', error => { output += `\n${error.message}`; resolve({ code: null, signal: null }) })
      })
      const collect = (chunk: Buffer): void => {
        output = (output + chunk.toString('utf8')).slice(-64_000)
        lastActivity = new Date().toISOString()
        io.output(chunk.toString('utf8'))
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        collect(chunk)
        pending += decoder.write(chunk)
        let end: number
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1)
          let event: any
          try { event = JSON.parse(line) } catch { continue }
          if (!sessionId && event.type === 'session' && typeof event.sessionId === 'string') {
            const announced: string = event.sessionId
            sessionId = announced
            io.session?.(announced)
          }
          if (sessionId && event.type === 'final' && event.sessionId === sessionId && typeof event.text === 'string') finalText = event.text
        }
        // A malformed diagnostic must not grow an unbounded line buffer.
        if (pending.length > 1_000_000) pending = ''
      })
      child.stderr?.on('data', collect)
      child.stdin?.on('error', () => { /* startup failed before stdin was consumed */ })
      child.stdin?.end(spec.prompt, 'utf8')
      child.once('spawn', () => { state = 'running' })
      void ended.then(({ code, signal }) => { state = 'finished'; io.exited(code, signal) })

      /** Ends the whole tree: on Windows a shell-wrapped launcher leaves children behind a plain kill. */
      const kill = (): void => {
        if (child.pid === undefined) return
        if (platform === 'win32') { invoke('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); return }
        child.kill('SIGTERM')
        setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, graceMs).unref()
      }

      return {
        ticket: spec.ticket,
        runtime: 'dsh',
        get pid() { return child.pid ?? -1 },
        async post(): Promise<void> {
          throw new Error('headless 模式下无法向运行中的 worker 投递消息；跟进请在同一个目录再起一轮。')
        },
        async status(): Promise<WorkerStatus> {
          return { state, pid: child.pid, lastActivity, detail: tail(output, 1) || undefined }
        },
        async stop(): Promise<void> {
          if (state === 'finished') return
          state = 'stopped'
          kill()
          await Promise.race([ended, new Promise(resolve => setTimeout(resolve, graceMs + 2_000))])
        },
        async artifacts(): Promise<WorkerArtifacts> {
          // 交付完整输出，不再只留最后 20 行——那会把长报告的开头（结论段）整段丢掉，
          // 只剩一张没有前提的表格。output 在 collect() 里已按 64K 字符封顶，不会无限膨胀。
          return { summary: finalText ?? stripLogLines(output) }
        },
      }
    },
  }
}
