/**
 * 平台差异的唯一集中处：可执行文件解析、shell 调用、CLI 包装器。
 * 其余模块不应直接判断 process.platform；需要分叉时从这里取。
 *
 * Windows 与 POSIX 的差别不在"路径分隔符"这种小事上，而是三处语义：
 * 1. PATH 解析要按 PATHEXT 补扩展名（gh → gh.exe / gh.cmd），且 X_OK 在 Windows 上恒真；
 * 2. 不存在 env(1)、sh(1)、ps(1)、fcntl，包装器写成 shell 脚本无法执行，必须生成 .cmd；
 * 3. 没有 SIGTERM 的协作式退出，收尾要靠 taskkill 进程树。
 */
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

export const isWindows = process.platform === 'win32'

/** Launch JavaScript CLI wrappers through Node, preserving each argument without a shell. */
export function commandArgv(program: string, args: readonly string[]): string[] {
  if (/\.(?:mjs|cjs|js)$/i.test(program)) return [process.execPath, program, ...args]
  if (isWindows && /\.(?:cmd|bat)$/i.test(program)) throw new Error('Use the native .exe or a .mjs CLI wrapper instead of a Windows batch launcher')
  return [program, ...args]
}

/** PATHEXT 的扩展名，按系统声明顺序；缺失时回落到 Windows 默认值。 */
const extensions = (): string[] => (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(value => value.trim()).filter(Boolean)

/** 包装器文件名：POSIX 用命令本名，Windows 必须带扩展名才能被 PATH 解析命中。 */
export const shimFile = (name: string): string => isWindows ? `${name}.cmd` : name

/** 同一个命令名在磁盘上可能的文件名；POSIX 只有一种写法。 */
export function executableCandidates(path: string): string[] {
  if (!isWindows) return [path]
  const lower = path.toLowerCase()
  if (extensions().some(extension => lower.endsWith(extension.toLowerCase()))) return [path]
  return [path, ...extensions().map(extension => path + extension.toLowerCase())]
}

/** 在 PATH 中查找一个可执行文件，跳过 `exclude` 命中的目录；Windows 按 PATHEXT 补全。 */
export function findExecutable(name: string, path: string, exclude?: (directory: string) => boolean): string | undefined {
  const directories = isAbsolute(name) ? [] : path.split(delimiter).filter(directory => directory && isAbsolute(directory) && !(exclude?.(directory) ?? false))
  const candidates = isAbsolute(name) ? [name] : directories.map(directory => join(directory, name))
  for (const candidate of candidates) {
    for (const file of executableCandidates(candidate)) {
      try { if (statSync(file).isFile()) { accessSync(file, constants.X_OK); return file } } catch { /* 不是可执行文件，试下一个 */ }
    }
  }
  return undefined
}

/** 查找系统里可用的 PowerShell：PowerShell 7 叫 pwsh，Windows PowerShell 5.1 叫 powershell.exe。 */
export function powershell(path: string): string | undefined {
  return findExecutable('pwsh', path) ?? findExecutable('powershell', path)
}

/**
 * 一条 shell 命令在目标平台上的 argv。
 * POSIX 用 sh -c；Windows 用 PowerShell 的单行命令语义，没有 pwsh 时退回 powershell.exe。
 * 调用方传入的是项目文档与配置里的命令文本，语义按"能被 shell 解释的一行"处理。
 */
export function shellArgv(command: string, path: string): string[] {
  if (!isWindows) return ['sh', '-c', command]
  const shell = powershell(path)
  if (!shell) throw new Error('执行 prepare 命令需要 PowerShell：既没有 pwsh，也没有 powershell.exe')
  return [shell, '-NoProfile', '-NonInteractive', '-Command', command]
}

/**
 * 把 `PATH=<path>` 前缀从 argv 换成 spawn 的 env。
 * POSIX 上 `env PATH=... cmd` 是最直接的写法；Windows 没有 env(1)，但 DSH 的 subprocess 会把显式 env 合并进清洗后的环境，语义等价。
 */
export function pathOverride(argv: string[], path: string): { argv: string[]; env?: Record<string, string> } {
  if (!isWindows) return { argv: ['env', `PATH=${path}`, ...argv] }
  return { argv, env: { PATH: path } }
}

/**
 * Windows 上的 CLI 包装器：把自身的临时覆盖 PATH 固定为生成期的干净值，再转发参数。
 * 不写批处理循环去过滤 PATH —— 生成时就知道干净路径，运行时再算既慢又容易在引号上出错。
 */
export function windowsRunShim(program: string, cleanPath: string): string {
  const launch = commandArgv(program, []).map(value => `"${value.replaceAll('%', '%%')}"`).join(' ')
  return `set "PATH=${cleanPath.replaceAll('%', '%%')}"\r\n${launch} %*\r\n`
}

/** Windows 上的封禁命令包装器：报错并以 1 退出。 */
export function windowsFailShim(message: string): string {
  return `echo ${message.replaceAll('%', '%%').replaceAll('^', '^^').replaceAll('&', '^&').replaceAll('|', '^|').replaceAll('<', '^<').replaceAll('>', '^>')} 1>&2\r\nexit /b 1\r\n`
}
