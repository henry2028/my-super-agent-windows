/**
 * worker 进程（dsh headless）拿不到宿主的凭据服务，只认环境变量；
 * 宿主的模型 key 就写在 `$DSH_HOME/.credentials.yaml` 的 refs 段里，这里统一读出来。
 */
import { readFileSync } from 'node:fs'

/** 默认凭据文件：`$DSH_HOME/.credentials.yaml`，DSH_HOME 缺省时用用户目录下的 .dsh。 */
export const credentialsFile = (): string =>
  `${process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? process.env.HOME ?? '.'}\\.dsh`}\\.credentials.yaml`

/** 需要交给 worker 进程的模型凭据环境变量；读不到就返回空，Codex 用不到它。 */
export function modelKeyEnv(file = credentialsFile()): Record<string, string> {
  if (process.env.DEEPSEEK_API_KEY) return { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY }
  try {
    const line = readFileSync(file, 'utf8').split(/\r?\n/).find(row => /^\s*DEEPSEEK_API_KEY:/.test(row))
    const value = line?.replace(/^\s*DEEPSEEK_API_KEY:\s*/, '').trim().replace(/^['"]|['"]$/g, '')
    return value ? { DEEPSEEK_API_KEY: value } : {}
  } catch { return {} }
}
