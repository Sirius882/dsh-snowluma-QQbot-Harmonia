param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$cacheDir = Join-Path (Split-Path $projectRoot -Parent) '.cache\harmonia'
New-Item -ItemType Directory -Force $cacheDir | Out-Null
Set-Location -LiteralPath $projectRoot
try {
    $worker = Start-Process -FilePath $NodePath -ArgumentList ('"' + (Join-Path $PSScriptRoot 'autostart.mjs') + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $cacheDir 'autostart.out.log') -RedirectStandardError (Join-Path $cacheDir 'autostart.err.log')
    # Start-Process -Wait also waits for the long-lived services spawned by the worker.
    $worker.WaitForExit()
    $worker.Refresh()
    exit $worker.ExitCode
} catch {
    Add-Content -LiteralPath (Join-Path $cacheDir 'autostart.err.log') -Value ('Autostart launcher failed: ' + $_.Exception.GetType().Name)
    exit 1
}
