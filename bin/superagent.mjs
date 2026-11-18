#!/usr/bin/env node
/**
 * dsh-superagent 服务管理器的跨平台实现。
 *
 * 与 scripts/dsh-superagent（Python，仅 POSIX）行为对齐：start / stop / restart / status，
 * 每 profile 一把操作锁、一份 PID、一份手动停止标记、一批日志。
 *
 * 平台差异只体现在两处，其余逻辑共用：
 *   - 启动：POSIX 用 tmux 会话；Windows 没有 tmux，用 detached 子进程 + 日志重定向。
 *   - 停止：POSIX 发 SIGINT 让 DSH 自己收尾；Windows 没有可用的进程间 SIGINT，
 *     用 taskkill /T 请求结束，超时即报错退出——不悄悄强杀，语义与 POSIX 版一致。
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import lockfile from 'proper-lockfile'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ARTIFACTS = join(ROOT, '.artifacts')
const CONTROL = join(ARTIFACTS, 'control')
const KEEP_LOGS = 20
const isWindows = process.platform === 'win32'

const control = profile => {
  const directory = join(CONTROL, 'profiles', profile)
  mkdirSync(directory, { recursive: true })
  return directory
}
const manuallyStopped = profile => existsSync(join(control(profile), 'manually-stopped'))
const readPid = profile => {
  try { const value = Number(readFileSync(join(control(profile), 'service.pid'), 'utf8').trim()); return Number.isInteger(value) && value > 0 ? value : undefined }
  catch { return undefined }
}
const writePid = (profile, pid) => writeFileSync(join(control(profile), 'service.pid'), `${pid}\n`)
const clearPid = profile => { try { unlinkSync(join(control(profile), 'service.pid')) } catch { /* 本来就没有 */ } }

/** 进程是否还活着；EPERM 表示进程存在但属于别的账户。 */
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }

/** 服务的健康与配置状态；拿不到就是不可达。 */
async function state(url) {
  try {
    const response = await fetch(url.replace(/\/$/, '') + '/orchestrator/api/state', { headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.timeout(2000) })
    const value = await response.json()
    const health = Object.fromEntries(Object.entries(value.health ?? {}).map(([name, entry]) => [name, entry?.state]))
    const errors = Object.fromEntries(Object.entries(value.health ?? {}).filter(([, entry]) => entry?.state === 'error').map(([name, entry]) => [name, String(entry?.detail ?? '')]))
    return { health, errors, setup: value.setup?.problem, feishu: value.setup?.feishuProblem }
  } catch { return undefined }
}

const runtimeUp = current => current !== undefined && ['ready', 'paused'].includes(current.health.runtime)
const partErrors = current => Object.fromEntries(Object.entries(current.errors).filter(([name]) => name !== 'runtime'))

/** 计算退出码：0 正常，1 停止/不可达，2 有组件报错，3 等人工配置。 */
function outcome(pids, current) {
  if (pids.length !== 1 || !runtimeUp(current)) return 1
  if (current.setup) return 3
  return Object.keys(partErrors(current)).length ? 2 : 0
}

function status(profile, url) {
  const pids = processes(profile)
  return state(url).then(current => {
    console.log(JSON.stringify({ pids, cwd: ROOT, url, manually_stopped: manuallyStopped(profile),
      health: current?.health, errors: current?.errors, setup: current?.setup, feishu: current?.feishu }, null, 2))
    return outcome(pids, current)
  })
}

/** 只在记录过 PID 且该进程仍活着时返回它；不靠遍历全表猜进程。 */
function processes(profile) {
  const pid = readPid(profile)
  return pid !== undefined && alive(pid) ? [pid] : []
}

/** 停掉服务：先写手动停止标记，再请求退出，超时即报错（不强杀）。 */
async function stop(profile, url, stopTimeout, intentional = true) {
  const pids = processes(profile)
  if (pids.length > 1) throw new Error('发现多个 dsh-superagent 进程，拒绝替你挑一个。')
  if (intentional) writeFileSync(join(control(profile), 'manually-stopped'), new Date().toISOString() + '\n')
  for (const pid of pids) process.kill(pid, isWindows ? 'SIGTERM' : 'SIGINT')
  // Windows 的 SIGTERM 不保证送达控制台进程，补一次按进程树的结束请求；两者都不强杀。
  if (isWindows) for (const pid of pids) spawn('taskkill', ['/PID', String(pid), '/T'], { stdio: 'ignore', windowsHide: true })
  const deadline = Date.now() + stopTimeout * 1000
  while (pids.some(alive)) {
    if (Date.now() >= deadline) throw new Error(`优雅停止在 ${stopTimeout}s 内没有完成；没有发出强杀。请检查 status。`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  clearPid(profile)
  console.log(intentional ? 'dsh-superagent 已停止；自动恢复暂停，直到 start / restart。' : 'dsh-superagent 已停止。')
}

function pruneLogs(profile) {
  const keep = new RegExp(`dsh-superagent-${profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}-\\d{6}-\\d+\\.log`)
  const logs = readdirSync(ARTIFACTS).filter(name => keep.test(name)).map(name => ({ name, at: statSync(join(ARTIFACTS, name)).mtimeMs })).sort((a, b) => a.at - b.at)
  for (const { name } of logs.slice(0, Math.max(0, logs.length - KEEP_LOGS))) { try { unlinkSync(join(ARTIFACTS, name)) } catch { /* 并发删除 */ } }
}

async function start(profile, url, timeout) {
  const pids = processes(profile)
  if (pids.length > 1) throw new Error('发现多个 dsh-superagent 进程，拒绝再起一个。')
  if (!pids.length) {
    if (await state(url) !== undefined) throw new Error('这个地址上已有 orchestrator 在应答，拒绝重复启动。')
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
    const log = join(ARTIFACTS, `dsh-superagent-${profile}-${stamp}-${process.pid}.log`)
    pruneLogs(profile)
    const fd = openSync(log, 'a')
    const child = spawn('dsh', ['--profile', profile, '--no-open'], { detached: true, stdio: ['ignore', fd, fd], shell: isWindows, windowsHide: true, cwd: ROOT })
    closeSync(fd)
    child.unref()
    if (child.pid !== undefined) writePid(profile, child.pid)
    console.log('日志：' + log)
  } else {
    writePid(profile, pids[0])
    console.log(`dsh-superagent 已在运行（PID ${pids[0]}），没有重复启动。`)
  }
  try { unlinkSync(join(control(profile), 'manually-stopped')) } catch { /* 本来就没有 */ }
  const deadline = Date.now() + timeout * 1000
  while (Date.now() < deadline) {
    const current = await state(url)
    if (processes(profile).length && runtimeUp(current)) {
      const code = await status(profile, url)
      if (current.setup) console.log('dsh-superagent 在等配置：' + String(current.setup?.detail ?? '') + '\n打开日志里 DSH 打印的地址，再进 dsh-superagent 页面。')
      if (current.feishu) console.log('dsh-superagent 将在没有飞书的情况下运行：' + String(current.feishu?.detail ?? ''))
      for (const [name, detail] of Object.entries(partErrors(current))) console.log(`${name} 报错，重启修不了：${detail}`)
      return code
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  await status(profile, url)
  throw new Error('启动健康检查超时；请看日志。已启动的进程保持原样。')
}

function parse(argv) {
  const args = { action: argv[0], profile: process.env.DSH_SUPERAGENT_PROFILE || 'superagent',
    url: process.env.DSH_SUPERAGENT_URL || 'http://127.0.0.1:3082', timeout: 60, stopTimeout: 300, respectStop: false }
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = () => { const next = argv[index + 1]; if (next === undefined) throw new Error(`${flag} 缺少值`); index += 1; return next }
    if (flag === '--profile') args.profile = value()
    else if (flag === '--url') args.url = value()
    else if (flag === '--timeout') args.timeout = Number(value())
    else if (flag === '--stop-timeout') args.stopTimeout = Number(value())
    else if (flag === '--respect-stop') args.respectStop = true
    else throw new Error(`未知参数：${flag}`)
  }
  if (!['start', 'stop', 'restart', 'status'].includes(args.action)) throw new Error('用法：superagent <start|stop|restart|status> [--profile name] [--url url]')
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(args.profile)) throw new Error('--profile 必须是合法的 DSH profile 名')
  if (!(args.timeout > 0) || !(args.stopTimeout > 0)) throw new Error('--timeout 与 --stop-timeout 必须为正数')
  return args
}

async function main(argv) {
  const args = parse(argv)
  mkdirSync(ARTIFACTS, { recursive: true })
  const release = await lockfile.lock(control(args.profile), { lockfilePath: join(control(args.profile), 'operation.lock'), retries: 0, stale: 30_000 })
    .catch(() => { throw new Error('另一个 dsh-superagent 控制操作正在进行。') })
  try {
    if (args.respectStop && ['start', 'restart'].includes(args.action) && manuallyStopped(args.profile)) {
      console.log('手动停止状态生效，自动恢复已跳过。'); return 0
    }
    if (args.action === 'status') return await status(args.profile, args.url)
    // 只有 stop 会关闭自动恢复；restart 的停止超时失败也不能把它关掉。
    if (['stop', 'restart'].includes(args.action)) await stop(args.profile, args.url, args.stopTimeout, args.action === 'stop')
    if (['start', 'restart'].includes(args.action)) return await start(args.profile, args.url, args.timeout)
    return 0
  } finally { await release() }
}

main(process.argv.slice(2)).then(code => process.exit(code), error => { console.error(error.message); process.exit(1) })
