import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { dshRuntime } from '../src/pool/dsh.ts'

it('reads the actual session identity across split JSON frames and returns only the final answer', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
  const spawn = vi.fn(() => child)
  const session = vi.fn(), exited = vi.fn()
  const handle = await dshRuntime({ profile: 'headless', spawn: spawn as never }).start(
    { ticket: 'dsh-a', directory: '/work', prompt: 'check' }, { output: vi.fn(), exited, session })
  expect((spawn.mock.calls as unknown[][])[0]!.slice(0, 2)).toEqual(['dsh', ['--profile', 'headless', 'headless', '--json', '-']])
  expect(child.stdin.read().toString()).toBe('check')
  child.stdout.write('diagnostic\n{"type":"sess')
  child.stdout.write('ion","sessionId":"exact-id"}\n{"type":"final","sessionId":"exact-id","text":"review passed"}\n')
  child.stderr.write('a diagnostic only')
  child.emit('close', 0, null)
  await Promise.resolve()
  expect(session).toHaveBeenCalledExactlyOnceWith('exact-id')
  expect(await handle.artifacts()).toEqual({ summary: 'review passed' })
  expect(exited).toHaveBeenCalledWith(0, null)
})
