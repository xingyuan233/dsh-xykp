# dsh-session-delete 安装自检。
#
# 检查内容：
#   1. 离线单元测试（永久删除 + 末尾截断）；
#   2. profile 里的安装布局（dsh-xykp 子插件）；
#   3. 包级 client.js 是否包含本插件的浏览器端（含新菜单/Remote）；
#   4. xykp 的 cordis.patch.yml 里是否有注册行。
#
# 用法：pwsh -File verify.ps1 [-ProfileDir <path>]

param(
    [string]$ProfileDir = 'D:\AI\DeepseekHarness\home\profiles\web'
)

$ErrorActionPreference = 'Stop'
$pluginDir = $PSScriptRoot
$failed = 0
function Check([string]$label, [bool]$ok) {
    if ($ok) {
        Write-Host "  ✓ $label"
    } else {
        $script:failed += 1
        Write-Host "  ✗ $label" -ForegroundColor Red
    }
}

Write-Host '== 1. 离线单元测试 =='
& node (Join-Path $pluginDir 'test\offline.mjs')
Check '永久删除离线测试通过' ($LASTEXITCODE -eq 0)

Write-Host '== 2. profile 安装布局 =='
$target = Join-Path $ProfileDir 'node_modules\dsh-xykp\storage\session-delete'
$bundle = Join-Path $ProfileDir 'node_modules\dsh-xykp\client.js'
$patch = Join-Path $ProfileDir 'node_modules\dsh-xykp\cordis.patch.yml'
Check "存在 $target\lib\index.js" (Test-Path (Join-Path $target 'lib\index.js'))
Check "存在 $target\lib\client.js" (Test-Path (Join-Path $target 'lib\client.js'))
Check "存在 $bundle" (Test-Path $bundle)

Write-Host '== 3. 浏览器 bundle 内容 =='
if (Test-Path $bundle) {
    $text = Get-Content $bundle -Raw
    Check 'bundle 含 deleteSession' ($text.Contains('deleteSession'))
    Check 'bundle 含「永久删除会话」菜单文案' ($text.Contains('永久删除会话'))
    Check 'bundle 不含末尾截断残留' (-not $text.Contains('deleteTurnsFrom') -and -not $text.Contains('previewTurns'))
}

Write-Host '== 4. xykp 注册行 =='
if (Test-Path $patch) {
    $hits = @(Select-String -Path $patch -Pattern 'dsh-session-delete' -SimpleMatch)
    Check 'cordis.patch.yml 含 dsh-session-delete' ($hits.Count -gt 0)
}

Write-Host '== 5. 已移除末尾截断的收尾检查 =='
$agentFile = 'D:\AI\DeepseekHarness\npm\node_modules\@deepseek-ai\dsh-agent\lib\index.js'
if (Test-Path $agentFile) {
    $agentText = Get-Content $agentFile -Raw
    Check 'dsh-agent 无 agent-close 补丁残留' (-not $agentText.Contains('async close(id)'))
} else {
    Check "存在 $agentFile" $false
}
$coreDir = 'D:\AI\DeepseekHarness\plugins\core'
Check 'agent-close 补丁文件已删' (-not (Test-Path (Join-Path $coreDir 'agent-close.mjs')))
Check 'user-footer-slot 补丁文件已删' (-not (Test-Path (Join-Path $coreDir 'user-footer-slot.mjs')))

Write-Host ''
if ($failed -eq 0) {
    Write-Host '自检通过。改过代码后记得：deploy.ps1 → 重启 dsh web。'
    exit 0
}
Write-Host "自检失败：$failed 项" -ForegroundColor Red
exit 1
