# 编译 qqbridge.dll + injector.exe（用 VS2022 的 cl）
# 依赖：Dobby（D:\devoding\C++\pakes\dobby\build\win64）
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dobby = 'D:\devoding\C++\pakes\dobby'
$vs = 'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat'

Push-Location $here
try {
    cmd /c "`"$vs`" >nul 2>&1 && cl /nologo /utf-8 /EHsc /W3 /std:c++17 qqbridge.cpp /I `"$dobby\include`" /link /LIBPATH:`"$dobby\build\win64`" dobby.lib /DLL /OUT:qqbridge.dll"
    if ($LASTEXITCODE -ne 0) { throw "qqbridge build failed" }
    cmd /c "`"$vs`" >nul 2>&1 && cl /nologo /utf-8 /EHsc /W3 /std:c++17 injector.cpp /OUT:injector.exe"
    if ($LASTEXITCODE -ne 0) { throw "injector build failed" }
    Copy-Item "$dobby\build\win64\dobby.dll" "$here\dobby.dll" -Force
    "built: qqbridge.dll + injector.exe (+ dobby.dll)"
} finally {
    Pop-Location
}
