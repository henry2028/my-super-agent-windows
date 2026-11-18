/** Codex CLI worker: stdin prompts avoid Windows shell interpolation and command length limits. */
import { spawn, execFile } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { findExecutable } from '../platform/index.ts'
import type { WorkerHandle, WorkerRuntime, WorkerState } from './types.ts'

export interface CodexRuntimeOptions {
  command?: string
  sandbox?: 'read-only' | 'workspace-write'
  model?: string
  proxyUrl?: string
  /** A first-party HTTPS provider, scoped to this invocation, reusing saved ChatGPT auth. */
  https?: boolean
  modelCatalog?: string
  /** Time until the first model item, not merely thread.started/turn.started. */
  connectTimeoutMs?: number
}

/**
 * The Codex app installs itself under `%LOCALAPPDATA%\\OpenAI\\Codex\\bin\\<build hash>\\codex.exe` and does not
 * put that directory on PATH, so a plain PATH lookup answers "not installed" on a machine that has it.
 * PATH stays first (a user's own install or a shim wins); the app's own directory is the fallback.
 */
export function installedCodex(): string | undefined {
  // Never spawn npm's extensionless POSIX shim or a .cmd file with shell:false on Windows.
  const onPath = findExecutable(process.platform === 'win32' ? 'codex.exe' : 'codex', process.env.PATH ?? '')
  if (onPath || process.platform !== 'win32') return onPath
  const home = process.env.USERPROFILE ?? process.env.HOME
  // A parent desktop sandbox can virtualize LOCALAPPDATA; also inspect the real user install.
  const locals = [...new Set([process.env.LOCALAPPDATA, home ? join(home, 'AppData', 'Local') : undefined])].filter((p): p is string => !!p)
  const roots = locals.flatMap(local => [join(local, 'OpenAI', 'Codex', 'bin'), join(local, 'Programs', 'codex')])
  const found: { file: string; at: number }[] = []
  for (const root of roots) {
    let entries: string[]
    try { entries = readdirSync(root) } catch { continue }
    for (const entry of entries) {
      const file = join(root, entry, 'codex.exe')
      try { if (statSync(file).isFile()) found.push({ file, at: statSync(file).mtimeMs }) } catch { /* not this build */ }
    }
  }
  // npm's Windows package keeps the native binary beside its shell shim.
  const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  const npmRoots = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const root of npmRoots) {
    const base = join(root, 'node_modules', '@openai', 'codex')
    const file = findExecutable(join(base, 'vendor', target, 'codex', 'codex.exe'), '')
    if (file) return file
  }
  // Store installations change their versioned directory on upgrade too.
  const store = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'WindowsApps')
  try {
    for (const entry of readdirSync(store).filter(name => /^OpenAI\.Codex_/.test(name))) {
      const file = join(store, entry, 'app', 'resources', 'codex.exe')
      try { if (statSync(file).isFile()) found.push({ file, at: statSync(file).mtimeMs }) } catch { /* inaccessible package */ }
    }
  } catch { /* Store packages may not be readable by this account */ }
  // Build directories are content-addressed; the newest one is the build the app last installed.
  return found.sort((a, b) => b.at - a.at)[0]?.file
}

/** Keep auth/home and permission policy; drop only another process's desktop runtime identity. */
export function codexEnvironment(additions: Record<string, string> = {}, proxyUrl?: string): NodeJS.ProcessEnv {
  const env = { ...process.env, ...additions }
  for (const key of ['CODEX_WINDOWS_REGISTERED_CORE', 'CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY',
    'CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_TOOL_CALL_ID',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_SHELL']) delete env[key]
  if (proxyUrl) {
    const url = new URL(proxyUrl)
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)) throw new Error('Unsupported Codex proxy protocol')
    for (const key of Object.keys(env)) if (/^(?:http|https|all)_proxy$/i.test(key)) delete env[key]
    Object.assign(env, { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl })
  }
  const noProxy = [env.NO_PROXY ?? env.no_proxy ?? '', 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',')
  for (const key of Object.keys(env)) if (/^no_proxy$/i.test(key)) delete env[key]
  env.NO_PROXY = noProxy
  return env
}

export function codexRuntime(options: CodexRuntimeOptions = {}): WorkerRuntime {
  const command = () => options.command !== undefined
    ? findExecutable(options.command, process.env.PATH ?? '')
    : installedCodex()
  return {
    name: 'codex',
    async available() { return command() !== undefined },
    async start(spec, io): Promise<WorkerHandle> {
      const binary = command()
      if (!binary) throw new Error('Codex CLI not found on PATH')
      const args = ['exec', '--json', '--color', 'never', '--sandbox', options.sandbox ?? 'workspace-write',
        '-c', 'approval_policy="never"', '--skip-git-repo-check', '-C', spec.directory]
      if (options.model) args.push('--model', options.model)
      if (options.https) args.push('-c', 'model_provider="dsh_codex_https"', '-c',
        'model_providers.dsh_codex_https={name="OpenAI",base_url="https://chatgpt.com/backend-api/codex",requires_openai_auth=true,supports_websockets=false,stream_idle_timeout_ms=300000,stream_max_retries=2}')
      if (options.modelCatalog) {
        // The desktop app maintains this catalog; do not copy credentials or pin model names.
        const catalog = JSON.parse(readFileSync(options.modelCatalog, 'utf8'))
        if (!Array.isArray(catalog.models) || !catalog.models.length) throw new Error('Codex model catalog has no models; refresh it in Codex before retrying')
        args.push('-c', `model_catalog_json=${JSON.stringify(options.modelCatalog)}`)
      }
      args.push('-')
      const child = spawn(binary, args, { cwd: spec.directory, env: codexEnvironment(spec.env, options.proxyUrl),
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
      let state: WorkerState = 'starting'
      let summary = '', detail = '', pending = '', failed = false, completed = false, closed = false
      let exitCode: number | null = null
      let lastActivity = new Date().toISOString()
      const decoder = new StringDecoder('utf8')
      const terminate = async () => {
        if (closed) return
        if (child.pid) {
          if (process.platform === 'win32') await new Promise<void>((resolve, reject) => {
            execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => {
              let alive = false
              try { process.kill(child.pid!, 0); alive = true } catch { /* already gone */ }
              if (error && alive) reject(error); else resolve()
            })
          })
          else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
        }
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
      }
      const connectTimeout = setTimeout(() => {
        failed = true
        detail = `Codex connection timeout: no model response within ${options.connectTimeoutMs ?? 300_000}ms; check the worker proxy and CLI runtime. Task was not retried.`
        void terminate().catch(error => { detail += `; stop failed: ${String(error)}` })
      }, options.connectTimeoutMs ?? 300_000)
      connectTimeout.unref()
      const line = (text: string) => {
        try {
          const event = JSON.parse(text)
          if (/^item\.(?:started|updated|completed)$/.test(event.type) || event.type === 'turn.failed' || event.type === 'turn.completed') clearTimeout(connectTimeout)
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') summary = event.item.text
          if (event.type === 'turn.completed') completed = true
          if (event.type === 'turn.failed') { failed = true; detail = JSON.stringify(event.error ?? event) }
          // Reconnect notices also use type=error; a recovered turn can still succeed.
          if (event.type === 'error') detail = JSON.stringify(event.message ?? event)
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
          closed = true; clearTimeout(connectTimeout)
          pending += decoder.end(); if (pending.trim()) line(pending)
          if (!completed || !summary.trim()) { failed = true; detail ||= 'Codex ended without turn.completed and a final agent message' }
          exitCode = failed && code === 0 ? 1 : code
          if (state !== 'stopped') state = exitCode === 0 ? 'finished' : 'failed'
          io.exited(exitCode, signal); resolve()
        })
      })
      child.once('spawn', () => { state = 'running' })
      child.stdin.end(spec.prompt, 'utf8')
      return {
        ticket: spec.ticket, runtime: 'codex', get pid() { return child.pid ?? -1 },
        async post() { throw new Error('One Codex exec is one turn; submit a follow-up after it finishes.') },
        async status() { return { state, pid: child.pid, lastActivity, exitCode, detail } },
        async stop() {
          if (state === 'finished' || state === 'failed' || state === 'stopped') return
          state = 'stopped'
          clearTimeout(connectTimeout)
          await terminate()
          await ended
        },
        async artifacts() { return { summary: failed ? detail || summary : summary || detail || 'Codex returned no final message.' } },
      }
    },
  }
}
