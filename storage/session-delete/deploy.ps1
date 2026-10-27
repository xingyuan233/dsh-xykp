# 把 dsh-session-delete 部署到本机 dsh web profile 的 node_modules。
#
# 用法：
#   pwsh -File D:\devoding\dsh-session-delete\deploy.ps1
#   pwsh -File D:\devoding\dsh-session-delete\deploy.ps1 -ProfileDir 'D:\AI\DeepseekHarness\home\profiles\web'
#
# 只复制文件，不重启宿主；重启请用 D:\AI\DeepseekHarness\restart-dsh.ps1。

param(
    [string]$ProfileDir = 'D:\AI\DeepseekHarness\home\profiles\web'
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$target = Join-Path $ProfileDir 'node_modules\dsh-session-delete'

if (-not (Test-Path (Join-Path $ProfileDir 'package.json'))) {
    throw "找不到 dsh profile：$ProfileDir"
}
if (-not (Test-Path (Join-Path $source 'lib\index.js'))) {
    throw "源目录不完整，缺少 lib\index.js：$source"
}

Write-Host "源目录   : $source"
Write-Host "目标目录 : $target"

# 只清理本插件自己的目录，绝不碰 node_modules 里的其他包。
New-Item -ItemType Directory -Force -Path (Join-Path $target 'lib') | Out-Null

Copy-Item -LiteralPath (Join-Path $source 'package.json') -Destination (Join-Path $target 'package.json') -Force
Copy-Item -LiteralPath (Join-Path $source 'lib\index.js') -Destination (Join-Path $target 'lib\index.js') -Force
Copy-Item -LiteralPath (Join-Path $source 'lib\client.js') -Destination (Join-Path $target 'lib\client.js') -Force
if (Test-Path (Join-Path $source 'README.md')) {
    Copy-Item -LiteralPath (Join-Path $source 'README.md') -Destination (Join-Path $target 'README.md') -Force
}

# 语法自检：宿主是 ESM，客户端是 CJS 包裹（用 node --check 校验解析）。
node --check (Join-Path $target 'lib\index.js')
node --check (Join-Path $target 'lib\client.js')

Write-Host ''
Write-Host '已部署。检查清单：'
Write-Host "  1) profile 的 cordis.patch.yml 需要包含：- insert: [{ id: dsh-session-delete, name: dsh-session-delete }]"
Write-Host '  2) 重启 dsh web：pwsh -File D:\AI\DeepseekHarness\restart-dsh.ps1'
