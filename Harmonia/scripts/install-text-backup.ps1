$ErrorActionPreference = 'Stop'
$taskName = 'Harmonia-TextBackup'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$scriptHost = Join-Path $env:SystemRoot 'System32\wscript.exe'
$runner = Join-Path $PSScriptRoot 'run-hidden.vbs'
$backup = Join-Path $PSScriptRoot 'backup-text.mjs'
$arguments = '//B //NoLogo "' + $runner + '" "' + $nodePath + '" "' + $backup + '"'
$action = New-ScheduledTaskAction -Execute $scriptHost -Argument $arguments -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$logon.Delay = 'PT1M'
$hourly = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logon, $hourly) -Principal $principal -Settings $settings -Description 'Back up Harmonia persona, memories and text documents hourly; preserve all changed snapshots in D:\Backup\QQbot.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Installed ${taskName}: hourly and one minute after sign-in; started the first backup."
