/** Claude Code worker: native CLI, literal UTF-8 stdin and terminal result events. */
import { spawn, execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { findExecutable } from '../platform/index.ts'
import type { WorkerHandle, WorkerRuntime, WorkerState } from './types.ts'

export interface ClaudeRuntimeOptions { command?: string; model?: string }

/** Resolve native Claude Code, including the npm shim's adjacent executable on Windows. */
function installedClaude(): string | undefined {
  const path = process.env.PATH ?? ''
  const native = findExecutable('claude.exe', path)
  if (native) return native
  const shim = findExecutable('claude', path)
  // npm also installs an extensionless POSIX shim on Windows; it is not a native executable.
  if (shim && process.platform !== 'win32' && !/\.(?:cmd|bat|ps1)$/i.test(shim)) return shim
  const roots = [shim ? dirname(shim) : undefined, process.env.APPDATA ? join(process.env.APPDATA, 'npm') : undefined]
  for (const root of roots) {
    if (!root) continue
    const candidate = findExecutable(join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), path)
    if (candidate) return candidate
  }
  const home = process.env.USERPROFILE ?? process.env.HOME
  return home ? findExecutable(join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'), path) : undefined
}

export function claudeRuntime(options: ClaudeRuntimeOptions = {}): WorkerRuntime {
  const command = () => options.command !== undefined
    ? findExecutable(options.command, process.env.PATH ?? '')
    : installedClaude()
  return {
    name: 'claude',
    async available() { return command() !== undefined },
    async start(spec, io): Promise<WorkerHandle> {
      const binary = command()
      if (!binary) throw new Error('Native Claude Code CLI not found; install it or add its npm/native directory to PATH')
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--tools', 'Read,Write,Edit,Glob,Grep,Bash', '--allowedTools', 'Read,Write,Edit,Glob,Grep,Bash']
      if (options.model) args.push('--model', options.model)
      const env = { ...process.env, ...spec.env }
      // Local forwarding endpoints (for example CC Switch) must remain local.
      env.NO_PROXY = [env.NO_PROXY ?? env.no_proxy ?? '', 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',')
      env.no_proxy = env.NO_PROXY
      const child = spawn(binary, args, { cwd: spec.directory, env,
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
      let state: WorkerState = 'starting'
      let summary = '', detail = '', pending = '', failed = false, completed = false
      let exitCode: number | null = null
      let lastActivity = new Date().toISOString()
      const decoder = new StringDecoder('utf8')
      const line = (text: string) => {
        try {
          const event = JSON.parse(text)
          if (event.type === 'result') {
            completed = true
            failed = event.is_error !== false || event.subtype !== 'success'
            summary = typeof event.result === 'string' ? event.result : (event.errors ?? []).join('\n')
            if (failed) detail = summary || `Claude Code result: ${event.subtype}`
          }
        } catch { /* stdout can also contain CLI diagnostics */ }
      }
      child.stdout.on('data', (chunk: Buffer) => {
        lastActivity = new Date().toISOString()
        const text = decoder.write(chunk)
        io.output(text)
        pending += text
        const lines = pending.split('\n'); pending = lines.pop()!
        for (const text of lines) line(text)
      })
      child.stderr.on('data', (chunk: Buffer) => { detail = (detail + chunk.toString('utf8')).slice(-8000); lastActivity = new Date().toISOString() })
      child.stdin.on('error', () => { /* early CLI exit; close reports the failure */ })
      const ended = new Promise<void>(resolve => {
        child.once('error', error => { failed = true; detail = error.message })
        // close, rather than exit, ensures the final JSON event has drained.
        child.once('close', (code, signal) => {
          pending += decoder.end(); if (pending.trim()) line(pending)
          if (!completed) { failed = true; detail ||= 'Claude Code ended without a terminal result event' }
          exitCode = failed && code === 0 ? 1 : code
          if (state !== 'stopped') state = exitCode === 0 ? 'finished' : 'failed'
          io.exited(exitCode, signal); resolve()
        })
      })
      child.once('spawn', () => { state = 'running' })
      child.stdin.end(spec.prompt, 'utf8')
      return {
        ticket: spec.ticket, runtime: 'claude', get pid() { return child.pid ?? -1 },
        async post() { throw new Error('One Claude Code print invocation is one turn; submit a follow-up after it finishes.') },
        async status() { return { state, pid: child.pid, lastActivity, exitCode, detail } },
        async stop() {
          if (state === 'finished' || state === 'failed' || state === 'stopped') return
          state = 'stopped'
          if (child.pid) {
            if (process.platform === 'win32') await new Promise<void>((resolve, reject) => {
              execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => {
                let alive = false
                try { process.kill(child.pid!, 0); alive = true } catch { /* already exited */ }
                if (error && alive) reject(error); else resolve()
              })
            })
            else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
          }
          // A cancelled worker no longer produces useful output. Close inherited pipes as well,
          // since an already-closed parent's tool helper can otherwise hold them open.
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
          await ended
        },
        async artifacts() { return { summary: summary || detail || 'Claude Code returned no final message.' } },
      }
    },
  }
}
