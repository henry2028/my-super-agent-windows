import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const [profile, portText, launcher, ...options] = process.argv.slice(2)
const port = Number(portText)
if (!profile || !/^[a-z][a-z0-9-]{0,31}$/.test(profile) || ['web', 'headless', 'tui', 'node_modules'].includes(profile) ||
    !Number.isInteger(port) || port < 1024 || port > 65535 || !launcher ||
    options.some(flag => !['--feishu', '--github', '--no-start'].includes(flag))) {
  throw new Error('Usage: node bin/deploy.mjs <dedicated-profile> <port> <DSH bin.js> [--feishu] [--github] [--no-start]')
}
const dshBin = realpathSync(launcher)
const dshVersion = JSON.parse(readFileSync(join(dirname(dshBin), '..', 'package.json'), 'utf8'))
if (dshVersion.name !== '@deepseek-ai/dsh' || dshVersion.version !== '0.2.2-rc.1') {
  throw new Error('This workspace extension is built for official DSH 0.2.2-rc.1.')
}
const home = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
const profileDir = join(home, 'profiles', profile)
const stateDir = join(home, 'state', profile)
const marker = join(profileDir, 'superagent-windows-install.json')
const connections = join(profileDir, 'workers.json')
const env = { ...process.env, DSH_HOME: home }
const json = value => JSON.stringify(value, null, 2) + '\n'
const run = (args, quiet = false) => {
  const result = spawnSync(process.execPath, [dshBin, ...args], { env,
    stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`DSH failed with exit status ${result.status}`)
}
if (existsSync(profileDir) && !existsSync(marker)) throw new Error('This profile already exists. Choose another name to preserve it.')
if (existsSync(marker)) {
  const prior = JSON.parse(readFileSync(marker, 'utf8'))
  if (prior.checkout !== root) throw new Error('This profile belongs to another checkout. Choose another profile name.')
  if (prior.port !== port || prior.feishu !== options.includes('--feishu') || prior.github !== options.includes('--github'))
    throw new Error('This profile already exists with other options. Reuse the original flags or edit its patch locally.')
}

// Resolve the vendored extension's peers from the same DSH launcher that mounts it.
const requireDsh = createRequire(dshBin)
const requireBundle = createRequire(join(root, 'package.json'))
const extension = readFileSync(join(root, 'compat/workspace/index.mjs'), 'utf8')
  .replace(/from "(@deepseek-ai\/[^"]+|zod)";/g, (_line, name) => {
    const resolved = name === 'zod' ? requireBundle.resolve(name) : requireDsh.resolve(name)
    return `from ${JSON.stringify(pathToFileURL(resolved).href)};`
  })

mkdirSync(profileDir, { recursive: true })
if (!existsSync(marker)) writeFileSync(marker, json({ checkout: root, port,
  feishu: options.includes('--feishu'), github: options.includes('--github') }), { flag: 'wx' })
const manifestFile = join(profileDir, 'package.json')
const patchFile = join(profileDir, 'cordis.patch.yml')
const baseFile = join(profileDir, 'cordis.yml')
const installFile = (file, contents) => { if (!existsSync(file)) writeFileSync(file, contents, { flag: 'wx' }) }
installFile(manifestFile, json({ name: `dsh-profile-${profile}`, private: true, dependencies: { 'dsh-superagent': `link:${root.replaceAll('\\', '/')}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-superagent'] } } }))
installFile(baseFile, '[]\n')
installFile(connections, json({ agents: {} }))
const workspaceFile = join(profileDir, 'superagent-workspace.mjs')
writeFileSync(workspaceFile, extension)
installFile(patchFile, json([
  { id: 'webserver', config: { host: '127.0.0.1', port } },
  { id: 'workspace', disabled: true },
  { insert: [{ id: 'superagent-workspace', name: workspaceFile.replaceAll('\\', '/') }] },
  { id: 'dsh-superagent', config: { stateDir: stateDir.replaceAll('\\', '/'), workers: { connectionsFile: connections.replaceAll('\\', '/') } } },
  { id: 'dsh-superagent-github', disabled: !options.includes('--github') },
  { id: 'dsh-superagent-feishu', disabled: !options.includes('--feishu') },
]))
const plugin = join(profileDir, 'node_modules', 'dsh-superagent')
mkdirSync(dirname(plugin), { recursive: true })
if (!existsSync(plugin)) symlinkSync(root, plugin, process.platform === 'win32' ? 'junction' : 'dir')
if (realpathSync(plugin) !== realpathSync(root)) throw new Error('Profile plugin link points to a different checkout.')
mkdirSync(join(stateDir, 'tasks'), { recursive: true })
run(['--profile', profile, '--dump-config'], true)
console.log(`Profile: ${profileDir}\nWorker connections: ${connections}\nLocal work orders: ${join(stateDir, 'tasks')}\nOpen http://127.0.0.1:${port} using the login URL printed by DSH.`)
if (!options.includes('--no-start')) run(['--profile', profile])
