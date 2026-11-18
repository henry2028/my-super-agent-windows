/** CLI protocol tests: literal stdin, UTF-8 event framing, final messages and failure propagation. */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: fake.spawn, execFile: fake.execFile }))
import { codexRuntime, codexEnvironment, installedCodex } from '../src/pool/codex.ts'

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })

function child() {
  return Object.assign(new EventEmitter(), { pid: 42, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() })
}
describe('Codex runtime', () => {
  it('passes a multiline prompt literally over stdin without a shell and collects split UTF-8 JSON', async () => {
    const proc = child(); fake.spawn.mockReturnValue(proc)
    const io = { output: vi.fn(), exited: vi.fn() }
    const prompt = 'Fix "x" & echo $(oops)\n中文'
    let input = ''; proc.stdin.on('data', chunk => { input += chunk.toString() })
    const handle = await codexRuntime({ command: process.execPath }).start({ ticket: 't', directory: process.cwd(), prompt }, io)
    expect(input).toBe(prompt)
    expect(fake.spawn.mock.calls.at(-1)?.[2]).toMatchObject({ shell: false, windowsHide: true })
    expect(fake.spawn.mock.calls.at(-1)?.[1]).toContain('workspace-write')
    proc.stdout.write('{"type":"error","message":"Reconnecting... 1/5"}\n')
    const event = Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '修复完成' } }) + '\n')
    for (let i = 0; i < event.length; i++) proc.stdout.write(event.subarray(i, i + 1))
    proc.stdout.write('{"type":"turn.completed"}\n')
    proc.emit('close', 0, null)
    expect(io.exited).toHaveBeenCalledWith(0, null)
    expect(await handle.artifacts()).toEqual({ summary: '修复完成' })
  })
  it('does not report success for an exit-zero launcher missing a terminal event', async () => {
    const proc = child(); fake.spawn.mockReturnValue(proc)
    const io = { output: vi.fn(), exited: vi.fn() }
    const handle = await codexRuntime({ command: process.execPath }).start({ ticket: 't', directory: process.cwd(), prompt: 'test' }, io)
    proc.stdout.write('{"type":"thread.started"}\n{"type":"turn.started"}\n')
    proc.emit('close', 0, null)
    expect(io.exited).toHaveBeenCalledWith(1, null)
    expect((await handle.artifacts()).summary).toContain('without turn.completed')
  })
  it('scopes proxy and HTTPS routing to the child without dropping auth or permission policy', async () => {
    vi.stubEnv('CODEX_WINDOWS_REGISTERED_CORE', 'stale-parent-core')
    vi.stubEnv('CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY', 'stale-parent-package')
    vi.stubEnv('CODEX_HOME', 'keep-auth-home')
    vi.stubEnv('CODEX_PERMISSION_PROFILE', 'keep-policy')
    vi.stubEnv('CODEX_SANDBOX_NETWORK_DISABLED', '1')
    const proc = child(); fake.spawn.mockReturnValue(proc)
    await codexRuntime({ command: process.execPath, proxyUrl: 'http://127.0.0.1:7890', https: true })
      .start({ ticket: 't', directory: process.cwd(), prompt: 'test' }, { output: vi.fn(), exited: vi.fn() })
    const [, args, opts] = fake.spawn.mock.calls.at(-1)!
    expect(args).toContain('model_provider="dsh_codex_https"')
    expect(opts.env).toMatchObject({ HTTP_PROXY: 'http://127.0.0.1:7890', HTTPS_PROXY: 'http://127.0.0.1:7890',
      CODEX_HOME: 'keep-auth-home', CODEX_PERMISSION_PROFILE: 'keep-policy', CODEX_SANDBOX_NETWORK_DISABLED: '1' })
    expect(opts.env.CODEX_WINDOWS_REGISTERED_CORE).toBeUndefined()
    expect(opts.env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY).toBeUndefined()
    expect(process.env.CODEX_WINDOWS_REGISTERED_CORE).toBe('stale-parent-core')
    expect(codexEnvironment({}, 'http://127.0.0.1:7890').NO_PROXY).toContain('127.0.0.1')
    proc.emit('close', 1, null)
  })
  it.skipIf(process.platform !== 'win32')('stops only its own process when startup events never reach a model response', async () => {
    vi.useFakeTimers()
    const proc = child(); fake.spawn.mockReturnValue(proc)
    fake.execFile.mockImplementation((_cmd: string, args: string[], _opts: any, done: any) => {
      expect(args).toEqual(['/PID', '42', '/T', '/F'])
      proc.emit('close', 1, null); done(null)
    })
    const io = { output: vi.fn(), exited: vi.fn() }
    const handle = await codexRuntime({ command: process.execPath, connectTimeoutMs: 1000 })
      .start({ ticket: 't', directory: process.cwd(), prompt: 'test' }, io)
    proc.stdout.write('{"type":"thread.started"}\n{"type":"turn.started"}\n')
    await vi.advanceTimersByTimeAsync(1001)
    expect((await handle.status()).state).toBe('failed')
    expect((await handle.artifacts()).summary).toContain('connection timeout')
    expect(io.exited).toHaveBeenCalledTimes(1)
  })
  it('loads the current model catalog and rejects a broken catalog before spawning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-catalog-'))
    try {
      const file = join(dir, 'models.json'); writeFileSync(file, '{"models":[{"slug":"current"}]}')
      const proc = child(); fake.spawn.mockReturnValue(proc)
      await codexRuntime({ command: process.execPath, modelCatalog: file }).start({ ticket: 't', directory: dir, prompt: 'test' }, { output: vi.fn(), exited: vi.fn() })
      expect(fake.spawn.mock.calls.at(-1)?.[1]).toContain(`model_catalog_json=${JSON.stringify(file)}`)
      proc.emit('close', 1, null)
      writeFileSync(file, '{"models":[]}'); const count = fake.spawn.mock.calls.length
      await expect(codexRuntime({ command: process.execPath, modelCatalog: file }).start({ ticket: 't', directory: dir, prompt: 'test' }, { output: vi.fn(), exited: vi.fn() })).rejects.toThrow('no models')
      expect(fake.spawn.mock.calls.length).toBe(count)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it.skipIf(process.platform !== 'win32')('allows minutes of reconnecting and times out only at the five-minute default', async () => {
    vi.useFakeTimers()
    const proc = child(); fake.spawn.mockReturnValue(proc); fake.execFile.mockClear()
    fake.execFile.mockImplementation((_cmd: string, _args: string[], _opts: any, done: any) => {
      proc.emit('close', 1, null); done(null)
    })
    const io = { output: vi.fn(), exited: vi.fn() }
    const handle = await codexRuntime({ command: process.execPath }).start({ ticket: 't', directory: process.cwd(), prompt: 'test' }, io)
    proc.stdout.write('{"type":"thread.started"}\n{"type":"turn.started"}\n')
    await vi.advanceTimersByTimeAsync(180000)
    proc.stdout.write('{"type":"error","message":"Reconnecting..."}\n')
    expect(io.exited).not.toHaveBeenCalled()
    expect(fake.execFile).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(119999)
    expect(io.exited).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(io.exited).toHaveBeenCalledTimes(1)
    expect((await handle.artifacts()).summary).toContain('300000ms')
  })
  it.skipIf(process.platform !== 'win32')('ignores POSIX/npm shims and discovers a changed app build without a fixed hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-discovery-'))
    try {
      const shim = join(dir, 'npm'), native = join(dir, 'native')
      mkdirSync(shim); mkdirSync(native); writeFileSync(join(shim, 'codex'), '#!/bin/sh'); writeFileSync(join(shim, 'codex.cmd'), '@echo off')
      writeFileSync(join(native, 'codex.exe'), '')
      vi.stubEnv('PATH', [shim, native].join(delimiter))
      expect(installedCodex()).toBe(join(native, 'codex.exe'))
      vi.stubEnv('PATH', shim); vi.stubEnv('LOCALAPPDATA', dir); vi.stubEnv('USERPROFILE', dir); vi.stubEnv('ProgramFiles', dir)
      const root = join(dir, 'OpenAI', 'Codex', 'bin')
      for (const [build, time] of [['old-hash', 1000], ['new-hash', 2000]] as const) {
        mkdirSync(join(root, build), { recursive: true }); const file = join(root, build, 'codex.exe')
        writeFileSync(file, ''); utimesSync(file, time, time)
      }
      expect(installedCodex()).toBe(join(root, 'new-hash', 'codex.exe'))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('treats turn.failed as a failure even when the launcher exits zero', async () => {
    const proc = child(); fake.spawn.mockReturnValue(proc)
    const io = { output: vi.fn(), exited: vi.fn() }
    const handle = await codexRuntime({ command: process.execPath }).start({ ticket: 't', directory: process.cwd(), prompt: 'test' }, io)
    proc.stdout.write('{"type":"turn.failed","error":{"message":"quota"}}')
    proc.emit('close', 0, null)
    expect(io.exited).toHaveBeenCalledWith(1, null)
    expect((await handle.artifacts()).summary).toContain('quota')
  })
  it('reports launch failures rather than waiting for a successful spawn', async () => {
    const proc = child(); fake.spawn.mockReturnValue(proc)
    const io = { output: vi.fn(), exited: vi.fn() }
    const handle = await codexRuntime({ command: process.execPath }).start({ ticket: 't', directory: process.cwd(), prompt: 'test' }, io)
    proc.emit('error', new Error('ENOENT')); proc.emit('close', -1, null)
    expect((await handle.artifacts()).summary).toContain('ENOENT')
    expect((await handle.status()).state).toBe('failed')
  })
})
