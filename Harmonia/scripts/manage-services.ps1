param([ValidateSet('Start','Stop','Restart')][string]$Action = 'Start')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$dshEntry = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
$snowNode = Join-Path $projectRoot 'vendor\snowluma\node.exe'
$bridgeEntry = Join-Path $projectRoot 'service.mjs'
$taskNames = @('Harmonia-Autostart', 'DSH-Web')

function Get-ManagedServiceKind($Process) {
    if ($Process.Name -ne 'node.exe') { return $null }
    if ($Process.ExecutablePath -eq $snowNode -and $Process.CommandLine -match 'index\.mjs') { return 'SnowLuma' }
    if ($Process.CommandLine -match [regex]::Escape($dshEntry) -and $Process.CommandLine -match '\sweb(?:\s|$)') { return 'DSH' }
    if ($Process.CommandLine -match [regex]::Escape($bridgeEntry)) { return 'Bridge' }
    return $null
}
function Get-BridgePort {
    $text = Get-Content -LiteralPath (Join-Path $projectRoot 'config\.env') -Raw
    $match = [regex]::Match($text, '(?m)^PORT\s*=\s*(\d+)\s*$')
    if ($match.Success) { return [int]$match.Groups[1].Value }
    return 8080
}
function Stop-BotServices {
    foreach ($name in $taskNames) {
        Disable-ScheduledTask -TaskName $name | Out-Null
        Stop-ScheduledTask -TaskName $name
    }
    # Only the old launcher used a relative service.mjs command; identify that process by the authenticated local service identity.
    $legacyPid = $null
    $port = Get-BridgePort
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/health') -TimeoutSec 5
        if ($health.service -ne 'Harmonia') { throw 'Bridge port belongs to another service; stopping refused.' }
        $candidate = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listener.OwningProcess)
        if ($candidate.Name -ne 'node.exe' -or $candidate.CommandLine -notmatch '(?:^|\s|["\x27])service\.mjs(?:$|\s|["\x27])') {
            if ((Get-ManagedServiceKind $candidate) -ne 'Bridge') { throw 'Bridge process identity mismatch; stopping refused.' }
        }
        $legacyPid = $candidate.ProcessId
    }
    $managed = @(Get-CimInstance Win32_Process | Where-Object { (Get-ManagedServiceKind $_) -or $_.ProcessId -eq $legacyPid })
    # Kill each verified service tree once, including DSH-owned tools; never target QQ.exe or other Node applications.
    $managedIds = @($managed | ForEach-Object { $_.ProcessId })
    foreach ($process in $managed) {
        if ($managedIds -contains $process.ParentProcessId) { continue }
        if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $process.ProcessId /T /F | Out-Null
            if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue)) { throw 'A managed service could not be stopped.' }
        }
    }
    $remaining = @(Get-CimInstance Win32_Process | Where-Object { Get-ManagedServiceKind $_ })
    if ($remaining.Count) { throw 'Managed processes remain; check task permissions.' }
    Write-Output 'Stopped Harmonia bridge, SnowLuma and global DSH. Automatic restart is disabled until start-all.bat runs.'
}
function Wait-LocalPort([int]$Port) {
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { return }
        Start-Sleep -Seconds 1
    }
    throw "Service did not start on port $Port; inspect .cache logs."
}
function Start-BotServices {
    foreach ($name in $taskNames) { Enable-ScheduledTask -TaskName $name | Out-Null }
    Start-ScheduledTask -TaskName DSH-Web
    Wait-LocalPort 3080
    Start-ScheduledTask -TaskName Harmonia-Autostart
    $port = Get-BridgePort
    Wait-LocalPort $port
    $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/health') -TimeoutSec 5
    if ($health.service -ne 'Harmonia') { throw 'Bridge port belongs to another service.' }
    Write-Output 'Started global DSH, SnowLuma and Harmonia. Silent automatic startup/recovery is enabled.'
    Write-Output ('Brain=' + $health.brain + ', ready=' + $health.brainReady + ', QQ=' + $health.qqConnected + ', WeChat=' + $health.wechat)
    if (!$health.qqConnected) { Write-Output 'QQ may still be reconnecting; if login expired, sign into the bot account.' }
}

# Dot-sourcing exposes process selectors for isolated tests without changing service state.
if ($MyInvocation.InvocationName -eq '.') { return }
try {
    foreach ($name in $taskNames) { Get-ScheduledTask -TaskName $name -ErrorAction Stop | Out-Null }
    if ($Action -eq 'Stop' -or $Action -eq 'Restart') { Stop-BotServices }
    if ($Action -eq 'Start' -or $Action -eq 'Restart') { Start-BotServices }
} catch {
    Write-Error $_
    exit 1
}
