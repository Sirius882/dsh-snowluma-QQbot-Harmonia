$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$cacheDir = Join-Path (Split-Path $projectRoot -Parent) '.cache\harmonia'
New-Item -ItemType Directory -Force $cacheDir,(Join-Path $projectRoot 'vendor') | Out-Null
$sources = @(
    @('https://github.com/Derpyu520/qq-bridge.git', 'qq-bridge'),
    @('https://github.com/gl813788-byte/codex-qq-bot.git', 'codex-qq-bot'),
    @('https://github.com/gtaifu/dsh-wechat-bridge.git', 'wechat-bridge'),
    @('https://github.com/SnowLuma/SnowLuma.git', 'snowluma-source')
)
foreach ($source in $sources) {
    $destination = Join-Path $projectRoot ('vendor\' + $source[1])
    if (!(Test-Path -LiteralPath $destination)) {
        git clone --depth 1 $source[0] $destination
        if ($LASTEXITCODE) { throw "Clone failed: $($source[1])" }
    }
}
$snowDir = Join-Path $projectRoot 'vendor\snowluma'
if (!(Test-Path -LiteralPath (Join-Path $snowDir 'index.mjs'))) {
    # Keep the tested release pinned. Upgrade only after checking configuration and transport compatibility.
    $archive = Join-Path $cacheDir 'SnowLuma-v2.2.1-win-x64.zip'
    Invoke-WebRequest 'https://github.com/SnowLuma/SnowLuma/releases/download/v2.2.1/SnowLuma-v2.2.1-win-x64.zip' -OutFile $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $snowDir
}
foreach ($directory in @($projectRoot, (Join-Path $projectRoot 'vendor\wechat-bridge'), (Join-Path $projectRoot 'vendor\qq-bridge'), (Join-Path $projectRoot 'vendor\codex-qq-bot'))) {
    Push-Location $directory
    try {
        npm install --cache (Join-Path $cacheDir 'npm') --no-audit --no-fund
        if ($LASTEXITCODE) { throw "npm install failed: $directory" }
    } finally { Pop-Location }
}
Write-Host 'Dependencies installed. Existing user configuration and login state preserved.'
