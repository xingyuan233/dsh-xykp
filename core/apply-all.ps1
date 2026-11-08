# 应用 / 检查 / 还原全部 dsh 核心补丁（实体在 DSH\plugins\core，跟着插件仓库走）
#
# 这个脚本不认识任何具体补丁：plugins\core\ 下的每个 *.mjs 是一个功能补丁，
# 文件名就是功能名；旧格式（<名字>\apply.ps1）也自动兼容。
#
# 用法：
#   pwsh -File apply-all.ps1           应用全部（幂等）
#   pwsh -File apply-all.ps1 -Check    只列状态
#   pwsh -File apply-all.ps1 -Restore  还原全部（从 .backup\）
param(
    [switch]$Check,
    [switch]$Restore
)
$ErrorActionPreference = 'Stop'
$engine = Join-Path $PSScriptRoot 'apply-all.mjs'
$argv = @($engine)
if ($Check) { $argv += '--check' }
if ($Restore) { $argv += '--restore' }
& node @argv
exit $LASTEXITCODE
