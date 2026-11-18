/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { existsSync, realpathSync } from 'node:fs'
import { checkSync } from 'proper-lockfile'
import { installWorkers } from './pool/bridge.ts'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  // Windows service restarts can terminate the host before it releases proper-lockfile's
  // 30s lease. Wait for that lease to expire; never remove another process's live lock.
  const deadline = Date.now() + 35_000
  const lockDirectory = existsSync(machine.stateDir) ? realpathSync(machine.stateDir) : machine.stateDir
  while (checkSync(lockDirectory, { realpath: false, stale: 30_000 })) {
    if (Date.now() >= deadline) throw new Error('The super-agent state directory is still locked by another host')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  // Construct only once: Runtime's Service base registers orchestrator before acquiring its lock.
  const workers = installWorkers(ctx, machine.stateDir, config.workers)
  const runtime = new Runtime(ctx, machine, restart, workers)
  ctx.effect(() => async () => { await runtime.stop() })
  await runtime.ready
  ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
