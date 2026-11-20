param(
    [ValidatePattern('^[a-z][a-z0-9-]{0,31}$')][string]$Profile = 'superagent-windows',
    [ValidateRange(1024,65535)][int]$Port = 3082,
    [string]$DshBin,
    [switch]$Feishu,
    [switch]$GitHub,
    [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot
try {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    $npx = (Get-Command npx.cmd -ErrorAction Stop).Source
    & $node -e "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1)"
    if ($LASTEXITCODE) { throw 'Install Node.js 24 or newer first.' }
    Get-Command git.exe -ErrorAction Stop | Out-Null
    & $npx --yes pnpm@10.34.7 install --frozen-lockfile --config.confirm-modules-purge=false
    if ($LASTEXITCODE) { throw 'Dependency installation failed.' }
    & $node node_modules/tsdown/dist/run.mjs
    if ($LASTEXITCODE) { throw 'Super-agent build failed.' }
    if (!$DshBin) {
        $runtime = Join-Path $PSScriptRoot '.artifacts/dsh-runtime'
        $DshBin = Join-Path $runtime 'node_modules/@deepseek-ai/dsh/lib/bin.js'
        $installedVersion = if (Test-Path -LiteralPath $DshBin) { & $node -p "require('./.artifacts/dsh-runtime/node_modules/@deepseek-ai/dsh/package.json').version" } else { '' }
        if ($installedVersion -ne '0.2.2-rc.5') {
            & $npm install --prefix $runtime --no-audit --no-fund --save-exact '@deepseek-ai/dsh@0.2.2-rc.5'
            if ($LASTEXITCODE) { throw 'DSH installation failed.' }
        }
    }
    $features = @()
    if ($Feishu) { $features += '--feishu' }
    if ($GitHub) { $features += '--github' }
    if ($NoStart) { $features += '--no-start' }
    & $node bin/deploy.mjs $Profile $Port $DshBin @features
    if ($LASTEXITCODE) { throw 'Super-agent profile setup or startup failed.' }
} finally { Pop-Location }
