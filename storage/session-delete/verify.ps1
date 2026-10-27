# dsh-session-delete 升级后自检。
#
# 用途：dsh 本体或 profile 依赖升级之后，一条命令确认「删除会话」插件仍然在位、仍能工作。
# 只读检查 + 跑离线测试，不会修改 dsh 本体、profile 数据或任何会话。
#
# 用法：
#   pwsh -File D:\devoding\dsh-session-delete\verify.ps1
#   pwsh -File D:\devoding\dsh-session-delete\verify.ps1 -ProfileDir 'D:\AI\DeepseekHarness\home\profiles\web'

param(
    [string]$ProfileDir = 'D:\AI\DeepseekHarness\home\profiles\web',
    [string]$DshHome = 'D:\AI\DeepseekHarness\home',
    [string]$DshEntry = 'D:\AI\DeepseekHarness\npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
)

$ErrorActionPreference = 'Continue'
$source = $PSScriptRoot
$target = Join-Path $ProfileDir 'node_modules\dsh-session-delete'
$patch = Join-Path $ProfileDir 'cordis.patch.yml'
$failures = 0

function Pass([string]$label) { Write-Host "  [通过] $label" -ForegroundColor Green }
function Fail([string]$label, [string]$detail) {
    Write-Host "  [失败] $label" -ForegroundColor Red
    if ($detail) { Write-Host "         $detail" -ForegroundColor DarkYellow }
    $script:failures += 1
}

Write-Host "== 1. 插件文件 =="
foreach ($file in @('package.json', 'lib\index.js', 'lib\client.js')) {
    $path = Join-Path $target $file
    if (Test-Path $path) { Pass "部署副本存在：$file" } else { Fail "缺少部署副本：$path" '重新运行 deploy.ps1' }
}
foreach ($file in @('lib\index.js', 'lib\client.js')) {
    $path = Join-Path $source $file
    if (Test-Path $path) { Pass "源码存在：$file" } else { Fail "缺少源码：$path" }
}

Write-Host "`n== 2. profile 补丁 =="
if (Test-Path $patch) {
    $hits = @(Select-String -Path $patch -Pattern 'dsh-session-delete' -SimpleMatch)
    if ($hits.Count -ge 2) { Pass "cordis.patch.yml 含 dsh-session-delete 条目（$($hits.Count) 处）" }
    else { Fail 'cordis.patch.yml 缺少 dsh-session-delete 的 insert 条目' '按 README 补一条 - insert: [{ id: dsh-session-delete, name: ''dsh-session-delete'' }]' }
}
else { Fail "找不到 profile 补丁：$patch" }

Write-Host "`n== 3. 宿主能否组合出该条目 =="
if (Test-Path $DshEntry) {
    $env:DSH_HOME = $DshHome
    $dump = & node $DshEntry --profile web --dump-config 2>&1
    if ($LASTEXITCODE -ne 0) {
        Fail 'dump-config 执行失败（补丁语法或组合有错）' (($dump | Select-Object -Last 5) -join ' | ')
    }
    elseif (($dump -join "`n") -match 'id:\s*dsh-session-delete') {
        Pass 'dump-config 输出中存在 dsh-session-delete'
    }
    else {
        Fail 'dump-config 输出中没有 dsh-session-delete' '检查补丁是否被覆盖/条目是否 disabled'
    }
}
else { Fail "找不到 dsh 入口：$DshEntry" }

Write-Host "`n== 4. 插件自身逻辑（离线测试）=="
$test = Join-Path $source 'test\offline.mjs'
if (Test-Path $test) {
    $output = & node $test 2>&1
    if ($LASTEXITCODE -eq 0) { Pass (($output | Select-Object -Last 1)) }
    else { Fail '离线测试未通过' (($output | Select-Object -Last 8) -join ' | ') }
}
else { Fail "找不到离线测试：$test" }

Write-Host ''
if ($failures -eq 0) {
    Write-Host '结论：插件在位且自测通过。' -ForegroundColor Green
    Write-Host '如果界面里还看不到「永久删除会话」，请重启 dsh web 并强制刷新页面。'
    exit 0
}
else {
    Write-Host "结论：有 $failures 项需要处理。" -ForegroundColor Red
    Write-Host '常见修复：重新运行 deploy.ps1，再重启 dsh web（restart-dsh.ps1）。'
    exit 1
}
