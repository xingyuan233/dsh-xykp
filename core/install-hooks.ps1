# 安装 / 修复「补丁自动还原」钩子（幂等，可反复跑）
#
#   pwsh -File D:\AI\DeepseekHarness\plugins\core\install-hooks.ps1          # 写入
#   pwsh -File D:\AI\DeepseekHarness\plugins\core\install-hooks.ps1 -Check   # 只看状态
#
# 给两个 package.json 的 scripts.postinstall 挂上 auto-restore.cmd：
#   DSH\npm\package.json              → 宿主 npm install（升级 dsh）之后自动打核心补丁
#   HOME\profiles\web\package.json    → profile pnpm install 之后自动跑 restore-all
#
# 什么时候需要重跑：宿主或 profile 的 package.json 被整体重写/重建过
#（比如重装 dsh、换 profile 目录）。平时 npm/pnpm 只会改 dependencies，钩子会留着。
param([switch]$Check)
$ErrorActionPreference = 'Stop'

$base = 'D:\AI\DeepseekHarness'
$hook = Join-Path $base 'plugins\core\auto-restore.cmd'
if (-not (Test-Path $hook)) { throw "找不到钩子脚本：$hook" }

$targets = @(
    [pscustomobject]@{ File = (Join-Path $base 'npm\package.json'); Command = $hook }
    [pscustomobject]@{ File = (Join-Path $base 'home\profiles\web\package.json'); Command = "$hook --full" }
)

$dirty = 0
foreach ($t in $targets) {
    if (-not (Test-Path $t.File)) { Write-Host "跳过（不存在）：$($t.File)"; continue }
    $json = Get-Content $t.File -Raw | ConvertFrom-Json
    $cur = $null
    if ($json.PSObject.Properties['scripts'] -and $json.scripts.PSObject.Properties['postinstall']) {
        $cur = [string]$json.scripts.postinstall
    }
    if ($cur -eq $t.Command) { Write-Host "ok      $($t.File)"; continue }

    if ($Check) {
        Write-Host "DIFF    $($t.File)`n        当前=<$cur>`n        期望=<$($t.Command)>"
        $dirty++
        continue
    }

    if (-not $json.PSObject.Properties['scripts']) {
        $json | Add-Member -NotePropertyName scripts -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    if ($json.scripts.PSObject.Properties['postinstall']) {
        $json.scripts.postinstall = $t.Command
    } else {
        $json.scripts | Add-Member -NotePropertyName postinstall -NotePropertyValue $t.Command -Force
    }
    $bak = $t.File + '.bak-hooks'
    if (-not (Test-Path $bak)) { Copy-Item $t.File $bak }
    $json | ConvertTo-Json -Depth 10 | Set-Content $t.File -Encoding utf8
    Write-Host "wrote   $($t.File)"
    $dirty++
}

if ($Check) {
    if ($dirty -eq 0) { Write-Host "`n钩子都在。" } else { Write-Host "`n有 $dirty 处需要修，直接跑一次不带 -Check 的即可。" }
} else {
    Write-Host "`n完成，改动 $dirty 处。"
}
