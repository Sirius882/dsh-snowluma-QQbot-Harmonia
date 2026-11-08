$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$workspaceRoot = Split-Path $projectRoot -Parent
$cacheDir = Join-Path $workspaceRoot '.cache\feature-install'
$commit = 'd0bbd44aa4a81f2a8ed78e0201efb43b790669a5'
$target = Join-Path $projectRoot 'vendor\dsh-alive'
New-Item -ItemType Directory -Force $cacheDir | Out-Null
$needsAlive = !(Test-Path -LiteralPath (Join-Path $target 'lib\index.js'))
$needsGui = !(Test-Path -LiteralPath (Join-Path $target 'tools\settings-alive.ps1')) -or !(Test-Path -LiteralPath (Join-Path $target 'tools\settings-alive.cmd'))
if ($needsAlive -or $needsGui) {
    $archive = Join-Path $cacheDir 'dsh-qq-bot.zip'
    Invoke-WebRequest ('https://codeload.github.com/phfb/dsh-qq-bot/zip/' + $commit) -OutFile $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $cacheDir -Force
    $source = Join-Path $cacheDir ('dsh-qq-bot-' + $commit + '\dsh-alive')
    New-Item -ItemType Directory -Force $target | Out-Null
    if ($needsAlive) {
        Copy-Item -LiteralPath (Join-Path $source 'lib') -Destination $target -Recurse
        foreach ($file in @('package.json','README.md','LICENSE')) { Copy-Item -LiteralPath (Join-Path $source $file) -Destination $target }
    }
    $toolsDir = Join-Path $target 'tools'
    New-Item -ItemType Directory -Force $toolsDir | Out-Null
    foreach ($file in @('settings-alive.ps1','settings-alive.cmd')) {
        if (!(Test-Path -LiteralPath (Join-Path $toolsDir $file))) {
            Copy-Item -LiteralPath (Join-Path $source ('tools\' + $file)) -Destination $toolsDir
        }
    }
}
$guiBinding = @{ dataDir = (Join-Path $projectRoot 'runtime\alive') } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $target 'tools\bot-config.json'), $guiBinding, (New-Object System.Text.UTF8Encoding($false)))
Push-Location $projectRoot
try {
    npm install --cache (Join-Path $cacheDir 'npm') --no-audit --no-fund
    if ($LASTEXITCODE) { throw 'App dependencies failed' }
    node scripts/patch-alive.mjs
    if ($LASTEXITCODE) { throw 'Alive adaptation failed' }
    dsh plugin --profile web add ('file:' + $target.Replace('\','/')) dsh-meme@0.1.77 --store-dir (Join-Path $cacheDir 'pnpm-store')
    if ($LASTEXITCODE) { throw 'DSH dependency installation failed' }
    node scripts/patch-meme.mjs
    if ($LASTEXITCODE) { throw 'Meme adaptation failed' }
    node scripts/migrate-stickers.mjs
    if ($LASTEXITCODE) { throw 'Meme index migration failed' }
    node scripts/setup-features.mjs
    if ($LASTEXITCODE) { throw 'Feature setup failed' }
    $topicSkill = Join-Path $env:USERPROFILE '.agents\skills\harmonia-topic-research'
    if (!(Test-Path -LiteralPath $topicSkill)) {
        New-Item -ItemType Directory -Force (Split-Path $topicSkill -Parent) | Out-Null
        New-Item -ItemType Junction -Path $topicSkill -Target (Join-Path $projectRoot 'skills\harmonia-topic-research') | Out-Null
    }
} finally { Pop-Location }
Write-Output 'Feature dependencies configured. Restart services using the existing root entrypoint when ready.'
