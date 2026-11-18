/** CLI protocol tests: literal stdin, UTF-8 event framing, final messages and failure propagation. */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: fake.spawn, execFile: vi.fn() }))
import { claudeRuntime } from '../src/pool/claude.ts'

function child() {
  return Object.assign(new EventEmitter(), { pid: 42, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() })
}
describe('Claude Code runtime', () => {
  it.skipIf(process.platform !== 'win32')('resolves the native executable beside an npm extensionless shim', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-path-'))
    const native = join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    try {
      mkdirSync(join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin'), { recursive: true })
      writeFileSync(native, 'fixture'); writeFileSync(join(root, 'claude'), '#!/bin/sh')
      vi.stubEnv('PATH', root)
      const proc = child(); fake.spawn.mockReturnValue(proc)
      await claudeRuntime().start({ ticket: 't', directory: root, prompt: 'x' }, { output() {}, exited() {} })
      expect(fake.spawn.mock.calls.at(-1)?.[0]).toBe(native)
      proc.emit('close', 1, null)
    } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) }
  }, 30_000) // Windows file I/O for the .exe fixture can exceed 5s on a loaded host.
  it('passes a multiline prompt literally over stdin without a shell and collects split UTF-8 JSON', async () => {
    const proc = child(); fake.spawn.mockReturnValue(proc)
    const io = { output: vi.fn(), exited: vi.fn() }
    const prompt = 'Fix "x" & echo $(oops)\n中文'
    let input = ''; proc.stdin.on('data', chunk => { input += chunk.toString() })
    const handle = await claudeRuntime({ command: process.execPath }).start({ ticket: 't', directory: process.cwd(), prompt }, io)
    expect(input).toBe(prompt)
    expect(fake.spawn.mock.calls.at(-1)?.[2]).toMatchObject({ shell: false, windowsHide: true })
    expect(fake.spawn.mock.calls.at(-1)?.[1]).toContain('dontAsk')
    expect(fake.spawn.mock.calls.at(-1)?.[1]).toContain('--strict-mcp-config')
    expect(fake.spawn.mock.calls.at(-1)?.[1]).not.toContain('bypassPermissions')
    const event = Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '修复完成' }) + '\n')
    for (let i = 0; i < event.length; i++) proc.stdout.write(event.subarray(i, i + 1))
    proc.emit('close', 0, null)
    expect(io.exited).toHaveBeenCalledWith(0, null)
    expect(await handle.artifacts()).toEqual({ summary: '修复完成' })
  })
  it('treats a failed result as a failure even when the launcher exits zero', async () => {
    const proc = child(); fake.spawn.mockReturnValue(proc)
    const io = { output: vi.fn(), exited: vi.fn() }
    const handle = await claudeRuntime({ command: process.execPath }).start({ ticket: 't', directory: process.cwd(), prompt: 'test' }, io)
    proc.stdout.write('{"type":"result","subtype":"error_max_turns","is_error":true,"errors":["quota"]}')
    proc.emit('close', 0, null)
    expect(io.exited).toHaveBeenCalledWith(1, null)
    expect((await handle.artifacts()).summary).toContain('quota')
  })
  it('reports launch failures rather than waiting for a successful spawn', async () => {
    const proc = child(); fake.spawn.mockReturnValue(proc)
    const io = { output: vi.fn(), exited: vi.fn() }
    const handle = await claudeRuntime({ command: process.execPath }).start({ ticket: 't', directory: process.cwd(), prompt: 'test' }, io)
    proc.emit('error', new Error('ENOENT')); proc.emit('close', -1, null)
    expect((await handle.artifacts()).summary).toContain('ENOENT')
    expect((await handle.status()).state).toBe('failed')
  })
})

it('rejects exit zero without the terminal Claude result', async () => {
  const proc = child(); fake.spawn.mockReturnValue(proc)
  const io = { output: vi.fn(), exited: vi.fn() }
  const handle = await claudeRuntime({ command: process.execPath }).start({ ticket: 't', directory: process.cwd(), prompt: 'test' }, io)
  proc.emit('close', 0, null)
  expect(io.exited).toHaveBeenCalledWith(1, null)
  expect((await handle.artifacts()).summary).toContain('without a terminal')
})
