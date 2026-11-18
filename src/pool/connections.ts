import { execFile, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'
import { RUNTIME_NAME, type WorkerRuntime } from './types.ts'
import { findExecutable } from '../platform/index.ts'

const nativeCommand = z.string().min(1).refine(value => process.platform !== 'win32' || !/\.(cmd|bat|ps1)$/i.test(value),
  'Use a native .exe (or node.exe with an adapter script), not a shell shim')
const model = z.string().min(1).optional()
const builtIn = z.object({ command: nativeCommand.optional(), model }).strict()
const custom = z.object({ command: nativeCommand.refine(isAbsolute, 'Custom command must be absolute'), args: z.array(z.string()).max(64).default([]) }).strict()
export const ConnectionSchema = z.object({
  codex: builtIn.optional(),
  claude: builtIn.optional(),
  agents: z.record(z.string().regex(RUNTIME_NAME).refine(name => !['self', 'dsh', 'codex', 'claude'].includes(name)), custom).default({}),
}).strict()
export type Connections = z.infer<typeof ConnectionSchema>

export function readConnections(file?: string): Connections {
  if (!file) return { agents: {} }
  try { return ConnectionSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { agents: {} }
    throw new Error('Invalid worker connection file. Run the worker connection wizard or check its schema.')
  }
}

/** An operator-installed CLI receives only a literal prompt on stdin and the ticket directory as cwd. */
export function configuredRuntimes(connections: Connections): WorkerRuntime[] {
  return Object.entries(connections.agents).map(([name, config]) => {
    const command = () => findExecutable(config.command, '')
    return {
      name,
      async available() { return !!command() },
      async start(spec, io) {
        const binary = command()
        if (!binary) throw new Error(`Worker ${name} executable is missing`)
        const windows = process.platform === 'win32'
        const child = spawn(binary, config.args, { cwd: spec.directory, shell: false, windowsHide: true, detached: !windows,
          stdio: ['pipe', 'pipe', 'pipe'] })
        const decoder = new StringDecoder('utf8')
        let summary = '', diagnostic = '', closed = false, stopping = false
        let state: Awaited<ReturnType<import('./types.ts').WorkerHandle['status']>> = { state: 'starting' }
        const ended = new Promise<void>(resolve => {
          child.once('spawn', () => { state = { state: 'running', pid: child.pid } })
          child.once('error', error => { diagnostic = error.message })
          child.once('close', (code, signal) => {
            closed = true
            summary = (summary + decoder.end()).trim()
            const exitCode = code === 0 && !summary ? 1 : code
            if (code === 0 && !summary) diagnostic ||= 'Worker exited without returning an answer on stdout'
            state = { state: stopping ? 'stopped' : exitCode === 0 ? 'finished' : 'failed', exitCode, detail: diagnostic }
            if (diagnostic) io.output(diagnostic)
            io.exited(exitCode, signal)
            resolve()
          })
        })
        child.stdout.on('data', (chunk: Buffer) => {
          const text = decoder.write(chunk)
          summary = (summary + text).slice(-64_000)
          if (text) io.output(text)
        })
        child.stderr.setEncoding('utf8').on('data', (text: string) => { diagnostic = (diagnostic + text).slice(-2_000); io.output(text) })
        child.stdin.on('error', () => { /* child may exit before consuming stdin */ })
        child.stdin.end(spec.prompt, 'utf8')
        return {
          ticket: spec.ticket, runtime: name, get pid() { return child.pid ?? -1 },
          async post() { throw new Error('This worker handles one prompt per process') },
          async status() { return state },
          async stop() {
            stopping = true
            if (!closed && child.pid) {
              if (windows) await new Promise<void>((resolve, reject) => {
                execFile('taskkill.exe', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true },
                  error => error && !closed ? reject(error) : resolve())
              })
              else try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
              }
            }
            await ended
          },
          async artifacts() { return { summary: summary || diagnostic } },
        }
      },
    }
  })
}
