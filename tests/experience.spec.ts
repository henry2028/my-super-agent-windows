/** Tests for the shared experience documents that worker processes of both runtimes read and write. */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { append, briefing, experienceRoot, indexFile, incomingFile, incomingRoot, merge, record, topics } from '../src/shared/experience.ts'

let stateDir: string
const read = (...parts: string[]): string => readFileSync(join(experienceRoot(stateDir), ...parts), 'utf8')

beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'experience-')) })
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

describe('shared experience', () => {
  it('writes a topic document with one heading and one section per entry', async () => {
    await append(stateDir, { topic: 'windows-shims', runtime: 'dsh', ticket: 't-1', title: 'PATHEXT 解析', body: 'gh 要解析成 gh.cmd。', tags: ['windows', 'path'] })
    await append(stateDir, { topic: 'windows-shims', runtime: 'dsh', ticket: 't-2', title: '标记行', body: '批处理注释也要能被识别。', tags: ['windows'] })
    const text = read('windows-shims.md')
    expect(text.match(/^# windows-shims$/gm)).toHaveLength(1)
    expect(text.match(/^## .*$/gm)).toHaveLength(2)
    expect(text).toContain('t-1')
    expect(text).toContain('tags: windows, path')
  })

  it('keeps every section when several writers append at once', async () => {
    // 两个进程同时写同一份文档：加锁之后一条都不能丢。
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      append(stateDir, { topic: 'concurrency', runtime: 'dsh', ticket: `t-${index}`, title: `第 ${index} 条`, body: 'body', tags: ['race'] })))
    const text = read('concurrency.md')
    expect(text.match(/^## .*$/gm)).toHaveLength(8)
    for (let index = 0; index < 8; index += 1) expect(text).toContain(`t-${index}`)
  })

  it('rebuilds the index with one line per topic', async () => {
    await append(stateDir, { topic: 'alpha', runtime: 'dsh', title: 'A', body: 'a' })
    await append(stateDir, { topic: 'beta', runtime: 'dsh', title: 'B', body: 'b' })
    const index = readFileSync(indexFile(stateDir), 'utf8')
    expect(index).toContain('[alpha](alpha.md) — 1 section')
    expect(index).toContain('[beta](beta.md) — 1 section')
    expect((await topics(stateDir)).map(item => item.topic)).toEqual(['alpha', 'beta'])
  })

  it('merges what a runtime without our lock recorded, into the topic it names', async () => {
    const file = await record(stateDir, 't-42', { topic: 'codex-notes', runtime: 'codex', title: '截图比对', body: '用 -i 传图。', tags: ['visual'] })
    expect(file).toBe(incomingFile(stateDir, 't-42'))
    expect(await merge(stateDir)).toEqual(['t-42'])
    expect(readdirSync(incomingRoot(stateDir))).toEqual([])
    const text = read('codex-notes.md')
    expect(text).toContain('codex')
    expect(text).toContain('截图比对')
    expect(text).toContain('用 -i 传图。')
    // 合并进来的段落同样出现在索引里。
    expect(readFileSync(indexFile(stateDir), 'utf8')).toContain('[codex-notes](codex-notes.md) — 1 section')
  })

  it('merges every incoming file, leaving the directory empty', async () => {
    await record(stateDir, 'a', { topic: 'one', runtime: 'codex', title: 'A', body: 'a' })
    await record(stateDir, 'b', { topic: 'two', runtime: 'codex', title: 'B', body: 'b' })
    expect((await merge(stateDir)).sort()).toEqual(['a', 'b'])
    expect(readdirSync(incomingRoot(stateDir))).toEqual([])
    expect((await topics(stateDir)).map(item => item.topic).sort()).toEqual(['one', 'two'])
  })

  it('briefs a Ticket from the tags it asked for and nothing else', async () => {
    await append(stateDir, { topic: 'shims', runtime: 'dsh', title: 'shell', body: 'sh 不存在。', tags: ['windows'] })
    await append(stateDir, { topic: 'visual', runtime: 'codex', title: '图片', body: '用 -i。', tags: ['visual'] })
    expect(await briefing(stateDir, ['windows'])).toHaveLength(1)
    expect((await briefing(stateDir, ['visual']))[0]).toContain('图片')
    expect(await briefing(stateDir, [])).toEqual([])
    expect(await briefing(stateDir, ['no-such-tag'])).toEqual([])
  })
})
