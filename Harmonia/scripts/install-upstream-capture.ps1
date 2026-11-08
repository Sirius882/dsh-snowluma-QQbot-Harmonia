$ErrorActionPreference = 'Stop'
$launcher = Join-Path $env:USERPROFILE '.dsh\Start-Web-Silent.ps1'
$capture = Join-Path $PSScriptRoot 'capture-dsh.mjs'
$captureUri = ([Uri]$capture).AbsoluteUri
$text = [IO.File]::ReadAllText($launcher)
function Protect-Chatlog {
    $logDirectory = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'chatlog'
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User,
        [Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
        [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $logDirectory -AclObject $acl
    [IO.File]::WriteAllText((Join-Path $logDirectory '.gitignore'), "*`n", [Text.UTF8Encoding]::new($false))
}
if ($text.Contains($captureUri)) {
    Protect-Chatlog
    Write-Output 'DSH upstream capture is already installed.'
    exit 0
}
if ($text.Contains('--import')) { throw 'Launcher already has an import; inspect before modifying it.' }
$anchor = '-ArgumentList @((''"'' + $entry'
if (!$text.Contains($anchor)) { throw 'DSH launcher arguments changed; no files modified.' }
$replacement = '-ArgumentList @(''--import'',(''"'' + ''' + $captureUri.Replace("'", "''") + ''' + ''"''),(''"'' + $entry'
$updated = $text.Replace($anchor, $replacement)
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseInput($updated, [ref]$null, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count) { throw 'Updated launcher failed PowerShell parsing; no files modified.' }
Protect-Chatlog
[IO.File]::WriteAllText($launcher, $updated, [Text.UTF8Encoding]::new($false))
Write-Output 'Installed DSH upstream capture. Restart the idle DSH Web service to activate it.'
