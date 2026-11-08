# 一键还原本地补丁：宿主核心补丁 +（可选）tools\patched-plugins 整包覆盖
#
# 用法：
#   pwsh -File restore-all.ps1 -Check     只查状态
#   pwsh -File restore-all.ps1            应用全部（不重启）
#   pwsh -File restore-all.ps1 -Restart   应用后重启 dsh web
param(
    [switch]$Check,
    [switch]$Restart
)
$ErrorActionPreference = 'Stop'
$base = 'D:\AI\DeepseekHarness'
$fail = 0

Write-Host '=== 宿主核心补丁 ==='
$coreAll = Join-Path $PSScriptRoot 'apply-all.ps1'
if (Test-Path $coreAll) {
    if ($Check) { & $coreAll -Check } else { & $coreAll }
    if ($LASTEXITCODE -ne 0) { $fail++ }
} else {
    Write-Host "WARN 缺少 $coreAll"
    $fail++
}

Write-Host '=== 插件整包补丁 ==='
$patched = Join-Path $base 'tools\patched-plugins'
$dstRoot = Join-Path $base 'home\profiles\web\node_modules'
if (-not (Test-Path $patched)) {
    Write-Host '（没有 tools\patched-plugins，跳过）'
} else {
    $dirs = @(Get-ChildItem $patched -Directory)
    if ($dirs.Count -eq 0) { Write-Host '（空）' }
    foreach ($d in $dirs) {
        if ($Check) { Write-Host ("· {0}（整包覆盖）" -f $d.Name); continue }
        $dst = Join-Path $dstRoot $d.Name
        New-Item -ItemType Directory -Force -Path $dst | Out-Null
        robocopy $d.FullName $dst /E /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) {
            Write-Host ("✗ {0} 覆盖失败 exit={1}" -f $d.Name, $LASTEXITCODE)
            $fail++
        } else {
            Write-Host ("+ {0} 已覆盖" -f $d.Name)
        }
    }
}

if ($fail -gt 0) { Write-Host "`n有 $fail 处问题。" } else { Write-Host "`n全部一致。" }

if ($Restart -and -not $Check) {
    Write-Host '重启 dsh web…'
    & (Join-Path $base 'restart-dsh.ps1') -DelaySeconds 10 | Out-Null
}
exit ([int]($fail -gt 0))
