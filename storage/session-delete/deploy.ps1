# dsh-session-delete 部署脚本。
#
# 安装布局（2026-11 起）：本插件是 dsh-xykp 包里的子插件
#   <profile>\node_modules\dsh-xykp\storage\session-delete\
# 浏览器端是 dsh-xykp 的**包级** bundle <profile>\node_modules\dsh-xykp\client.js，
# 由仓库根目录的 client.js 合并产物提供（DSH 客户端加载器只认整包名）。
#
# 用法：
#   pwsh -File D:\AI\DeepseekHarness\plugins\storage\session-delete\deploy.ps1
#   pwsh -File ...\deploy.ps1 -ProfileDir 'D:\AI\DeepseekHarness\home\profiles\web'

param(
    [string]$ProfileDir = 'D:\AI\DeepseekHarness\home\profiles\web'
)

$ErrorActionPreference = 'Stop'
$pluginDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $pluginDir '..\..')).Path
$toolsDir = Join-Path (Split-Path $repoRoot) 'tools'
$target = Join-Path $ProfileDir 'node_modules\dsh-xykp\storage\session-delete'
$bundle = Join-Path $ProfileDir 'node_modules\dsh-xykp\client.js'

if (-not (Test-Path $target)) {
    throw "找不到部署目标：$target（先确认 profile 里装了 dsh-xykp）"
}

Write-Host '== 1. 合并浏览器端 UI 到包级 bundle =='
$merge = Join-Path $toolsDir 'merge-session-delete-client.mjs'
if (-not (Test-Path $merge)) { throw "找不到合并脚本：$merge" }
& node $merge
if ($LASTEXITCODE -ne 0) { throw '合并 client.js 失败' }

Write-Host '== 2. 复制宿主半边与源码副本 =='
Copy-Item -Force (Join-Path $pluginDir 'lib\index.js') (Join-Path $target 'lib\index.js')
Copy-Item -Force (Join-Path $pluginDir 'lib\client.js') (Join-Path $target 'lib\client.js')
Copy-Item -Force (Join-Path $pluginDir 'package.json') (Join-Path $target 'package.json')
Copy-Item -Force (Join-Path $pluginDir 'README.md') (Join-Path $target 'README.md')
Write-Host "  -> $target"

Write-Host '== 3. 复制包级 client.js =='
Copy-Item -Force (Join-Path $repoRoot 'client.js') $bundle
Write-Host "  -> $bundle"

Write-Host '== 4. 检查 xykp 补丁里的注册行 =='
$patch = Join-Path $ProfileDir 'node_modules\dsh-xykp\cordis.patch.yml'
$hits = @(Select-String -Path $patch -Pattern 'dsh-session-delete' -SimpleMatch)
if ($hits.Count -eq 0) {
    Write-Warning " $patch 里没有 dsh-session-delete 的 insert 条目，插件不会被加载"
} else {
    Write-Host "  已注册（$($hits.Count) 处）"
}

Write-Host ''
Write-Host '部署完成。重启 dsh web 后生效：pwsh -File D:\AI\DeepseekHarness\restart-dsh.ps1'
Write-Host '注意：重启前不要刷新页面——新的浏览器端 bundle 会加载，而宿主还是旧代码。'
