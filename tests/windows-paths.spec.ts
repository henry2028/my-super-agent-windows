/** Windows configuration paths must be accepted on both the host and shared settings surface. */
import { expect, it } from 'vitest'
import { Config } from '../src/deployment.ts'
import { SettingsSchema } from '../src/policy.ts'

it('accepts drive-letter and UNC paths while refusing relative state directories', () => {
  for (const stateDir of ['C:/dsh/state', 'C:\\dsh\\state', '\\\\server\\share\\state', '/srv/state']) {
    expect(() => Config({ stateDir })).not.toThrow()
  }
  expect(() => Config({ stateDir: 'state/relative' })).toThrow()
})
it('accepts a Windows execution root in persisted settings', () => {
  const settings = SettingsSchema.parse({})
  expect(SettingsSchema.parse({ ...settings, executor: { ...settings.executor, directory: 'C:/work/tickets' } }).executor.directory).toBe('C:/work/tickets')
})
