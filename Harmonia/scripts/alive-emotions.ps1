$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$appRoot = Split-Path $PSScriptRoot -Parent
$dataDir = Join-Path $appRoot 'runtime\alive'
$statePath = Join-Path $dataDir 'alive-state.json'
$controlPath = Join-Path $dataDir 'alive-control.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$form = New-Object System.Windows.Forms.Form
$form.Text = '哈尔莫妮娅 · 当前情绪值'
$form.ClientSize = New-Object System.Drawing.Size 530, 450
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font 'Microsoft YaHei UI', 10
$hint = New-Object System.Windows.Forms.Label
$hint.SetBounds(18, 14, 495, 55)
$hint.Text = '直接调整当前数值（0–100%）。修改后自动勾选，只应用勾选项。数值生效后仍会随插件规则变化。'
$form.Controls.Add($hint)
$rows = @{}
$labels = [ordered]@{ missing = '想念'; jealousy = '吃醋'; warmth = '暖意'; worry = '担心'; boredom = '无聊'; annoyanceDebt = '恼火'; lust = '亲密欲望' }
$y = 76
foreach ($key in $labels.Keys) {
    $check = New-Object System.Windows.Forms.CheckBox
    $check.Text = $labels[$key]
    $check.SetBounds(22, $y, 160, 28)
    $number = New-Object System.Windows.Forms.NumericUpDown
    $number.SetBounds(200, $y, 110, 28)
    $number.Minimum = 0; $number.Maximum = 100; $number.DecimalPlaces = 1
    $number.Tag = $key
    $number.Add_ValueChanged({ if (!$script:loading) { $rows[$this.Tag].Check.Checked = $true } })
    $current = New-Object System.Windows.Forms.Label
    $current.SetBounds(335, $y + 3, 170, 25)
    $form.Controls.AddRange(@($check, $number, $current))
    $rows[$key] = @{ Check = $check; Number = $number; Current = $current }
    $y += 37
}
$status = New-Object System.Windows.Forms.Label
$status.SetBounds(18, 342, 495, 55)
$form.Controls.Add($status)
$refresh = New-Object System.Windows.Forms.Button
$refresh.Text = '读取当前值'; $refresh.SetBounds(180, 405, 140, 30)
$apply = New-Object System.Windows.Forms.Button
$apply.Text = '应用勾选项'; $apply.SetBounds(335, 405, 170, 30)
$form.Controls.AddRange(@($refresh, $apply))
$script:loading = $false
$script:pendingId = $null
$script:pendingAt = $null
function Read-CurrentMood {
    $script:loading = $true
    try {
        $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($key in $labels.Keys) {
            $scale = if ($key -eq 'annoyanceDebt') { 60.0 } else { 1.0 }
            $percent = [math]::Round([double]$state.mood.$key / $scale * 100, 1)
            $rows[$key].Current.Text = "当前：$percent%"
            if (!$rows[$key].Check.Checked) { $rows[$key].Number.Value = [decimal][math]::Max(0, [math]::Min(100, $percent)) }
        }
        $cfg = Get-Content -LiteralPath (Join-Path $dataDir 'alive-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if (!$cfg.lustModeEnabled) { $rows['lust'].Current.Text += '（模式关闭）' }
        return $true
    } catch { $status.Text = '读取失败：' + $_.Exception.Message; return $false }
    finally { $script:loading = $false }
}
$refresh.Add_Click({
    if (Read-CurrentMood) { $status.Text = '已读取当前状态。亲密欲望模式关闭时仅改数值，不会启用该模式。' }
})
$apply.Add_Click({
    try {
        $values = @{}
        foreach ($key in $labels.Keys) { if ($rows[$key].Check.Checked) { $values[$key] = [double]$rows[$key].Number.Value } }
        if (!$values.Count) { $status.Text = '请先修改或勾选要调整的情绪。'; return }
        if (Test-Path -LiteralPath $controlPath) {
            $previous = Get-Content -LiteralPath $controlPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($previous.cmd) { $status.Text = '插件还有未处理的控制请求，请稍后再试。'; return }
        }
        $script:pendingId = [guid]::NewGuid().ToString()
        $payload = @{ cmd = 'set-mood'; id = $script:pendingId; values = $values } | ConvertTo-Json
        [System.IO.File]::WriteAllText($controlPath, $payload, $utf8)
        $script:pendingAt = Get-Date
        $apply.Enabled = $false; $refresh.Enabled = $false
        foreach ($row in $rows.Values) { $row.Number.Enabled = $false; $row.Check.Enabled = $false }
        $status.Text = '正在等待运行中的插件确认…'
    } catch { $script:pendingId = $null; $status.Text = '提交失败：' + $_.Exception.Message }
})
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 400
$timer.Add_Tick({
    if (!$script:pendingId) { return }
    try {
        $reply = Get-Content -LiteralPath $controlPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($reply.id -eq $script:pendingId -and !$reply.cmd -and $reply.doneAt) {
            if ($reply.ok -eq $false) { $status.Text = '插件拒绝：' + $reply.error }
            else {
                foreach ($row in $rows.Values) { $row.Check.Checked = $false }
                if (Read-CurrentMood) { $status.Text = '已生效：运行中的插件已确认并保存。' }
            }
            $script:pendingId = $null
        } elseif (((Get-Date) - $script:pendingAt).TotalSeconds -ge 10) {
            $status.Text = '尚未收到确认，请检查DSH插件是否运行。请求保留，插件恢复后仍可能应用；不要重复提交。'
            $script:pendingId = $null
        }
        if (!$script:pendingId) {
            $apply.Enabled = $true; $refresh.Enabled = $true
            foreach ($row in $rows.Values) { $row.Number.Enabled = $true; $row.Check.Enabled = $true }
        }
    } catch { }
})
$form.Add_FormClosed({ $timer.Stop(); $timer.Dispose() })
if (Read-CurrentMood) { $status.Text = '已读取当前状态。只修改数值，不解除静音、不清配额。' }
$timer.Start()
[void]$form.ShowDialog()
