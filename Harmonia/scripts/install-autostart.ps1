$ErrorActionPreference = 'Stop'
$taskName = 'Harmonia-Autostart'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$launcher = Join-Path $PSScriptRoot 'start-silent.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcher + '" -NodePath "' + $nodePath + '"'
$hiddenRunner = Join-Path $PSScriptRoot 'run-hidden.vbs'
$scriptHost = Join-Path $env:SystemRoot 'System32\wscript.exe'
$hiddenArguments = '//B //NoLogo "' + $hiddenRunner + '" "' + $powershell + '" ' + $arguments
$action = New-ScheduledTaskAction -Execute $scriptHost -Argument $hiddenArguments -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = 'PT30S'
$monitor = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 2)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($trigger,$monitor) -Principal $principal -Settings $settings -Description 'Start Harmonia and SnowLuma silently after Windows sign-in; reconnect only the configured bot QQ.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Installed $taskName for $user (30 seconds after sign-in, checks every 2 minutes)."
