import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ConnectionSchema, configuredRuntimes } from '../src/pool/connections.ts'
import { WorkerPool } from '../src/pool/pool.ts'

it('runs a configured worker with literal stdin, persists ancestry and keeps stderr out of the answer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'custom-worker-'))
  const config = ConnectionSchema.parse({ agents: { sample: { command: process.execPath, args: [
    '-e', "process.stderr.write('diagnostic');process.stdin.pipe(process.stdout)",
  ] } } })
  const pool = new WorkerPool({ stateDir: directory, runtimes: configuredRuntimes(config) })
  try {
    const prompt = '你好 & $(echo literal)\n第二行'
    const outcome = await pool.submit({ ticket: 'sample-123', directory, runtime: 'sample', prompt,
      ownerSessionId: 'ticket-worker', rootSessionId: 'main-a', parentTicketId: 'order-a', workspaceId: 'work-a' })
    expect(outcome).toMatchObject({ state: 'finished', artifacts: { summary: prompt } })
    expect((await pool.records())[0]).toMatchObject({ rootSessionId: 'main-a', parentTicketId: 'order-a', workspaceId: 'work-a' })
  } finally {
    await pool.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('reserves built-in names and requires absolute custom executables', () => {
  expect(ConnectionSchema.safeParse({ agents: { codex: { command: process.execPath } } }).success).toBe(false)
  expect(ConnectionSchema.safeParse({ agents: { sample: { command: 'agent' } } }).success).toBe(false)
})
