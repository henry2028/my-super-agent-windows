import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { claudeRuntime, codexRuntime, configuredRuntimes, ConnectionSchema, readConnections } from '../lib/pool.js'

const [profile = 'superagent-windows', action = 'configure', probeName] = process.argv.slice(2)
if (!/^[a-z][a-z0-9-]{0,31}$/.test(profile)) throw new Error('Invalid profile name.')
const dir = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', profile)
if (!existsSync(join(dir, 'superagent-windows-install.json'))) throw new Error('Deploy this profile with Deploy.ps1 first.')
const file = join(dir, 'workers.json')
const connections = readConnections(file)
const runtimes = () => [codexRuntime(connections.codex), claudeRuntime(connections.claude), ...configuredRuntimes(connections)]

function failureHint(text) {
  if (/\b401\b|\b403\b|not logged in|invalid api key|unauthorized/i.test(text)) return 'Check the CLI account or API credentials.'
  if (/\b429\b|quota|rate.limit/i.test(text)) return 'Check provider quota and rate limits.'
  if (/ECONNREFUSED|ENOTFOUND|unable to connect|connection refused|\b50[234]\b/i.test(text)) return 'Check the configured provider and any local relay or proxy.'
  return 'Run the CLI directly under this Windows account to check login, model and any local relay.'
}

if (action === 'list') {
  for (const runtime of runtimes()) console.log(`${runtime.name}: ${await runtime.available() ? 'executable found' : 'executable missing'}`)
} else if (action === 'probe') {
  const runtime = runtimes().find(item => item.name === probeName)
  if (!runtime || !await runtime.available()) throw new Error('Worker executable missing or worker name unknown.')
  const cwd = mkdtempSync(join(tmpdir(), 'superagent-worker-'))
  try {
    let exited
    const done = new Promise(resolve => { exited = resolve })
    const handle = await runtime.start({ ticket: 'operator-probe', directory: cwd, prompt: 'Reply with exactly WORKER_OK. Do not use tools or change any files.' },
      { output() {}, exited })
    const timer = setTimeout(() => { void handle.stop('connection probe timed out').catch(() => {}) }, 310_000)
    try {
      const code = await done
      const answer = (await handle.artifacts()).summary
      if (code !== 0 || answer.trim() !== 'WORKER_OK') {
        const detail = (await handle.status()).detail ?? ''
        throw new Error(`Worker probe failed (exit ${code ?? 'signal'}). ${failureHint(answer + '\n' + detail)}`)
      }
      console.log(`${runtime.name}: request completed`)
    } finally { clearTimeout(timer) }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
} else if (action === 'configure') {
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const kind = (await terminal.question('Worker [codex / claude / custom]: ')).trim()
    if (kind === 'codex' || kind === 'claude') {
      const command = (await terminal.question('Native executable path (empty = auto-detect): ')).trim().replace(/^"(.*)"$/, '$1')
      const model = (await terminal.question('Model (empty = CLI default): ')).trim()
      connections[kind] = { ...(command ? { command } : {}), ...(model ? { model } : {}) }
    } else if (kind === 'custom') {
      const id = (await terminal.question('Worker name (e.g. gemini): ')).trim()
      const command = (await terminal.question('Absolute native executable path: ')).trim().replace(/^"(.*)"$/, '$1')
      const raw = (await terminal.question('Fixed arguments as a JSON array (empty = []): ')).trim()
      // The operator chooses the adapter. Prompts will only be delivered on stdin.
      Object.defineProperty(connections.agents, id, { enumerable: true, configurable: true,
        value: { command, args: raw ? JSON.parse(raw) : [] } })
    } else throw new Error('Choose codex, claude or custom.')
    const validated = ConnectionSchema.parse(connections)
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(validated, null, 2) + '\n', { flag: 'wx' })
    try { renameSync(temp, file) } catch (error) { rmSync(temp, { force: true }); throw error }
    console.log('Saved. Restart the dedicated Super-agent profile to apply these connections.')
  } finally { terminal.close() }
} else throw new Error('Actions: configure, list, probe <worker>')
