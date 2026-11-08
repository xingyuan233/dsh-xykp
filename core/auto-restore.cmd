@echo off
rem dsh patch auto-restore: called by npm / pnpm postinstall hooks.
rem   auto-restore.cmd          -> core patches only  (host: DSH\npm\package.json)
rem   auto-restore.cmd --full   -> core + tools\patched-plugins (profile: HOME\profiles\web\package.json)
rem Always exit 0: a failed restore must never break the package install.
setlocal
set BASE=D:\AI\DeepseekHarness
set LOG=%BASE%\plugins\core\auto-restore.log
set PWSH=C:\Program Files\PowerShell\7\pwsh.exe
if not exist "%PWSH%" set PWSH=powershell.exe
echo ==== [%DATE% %TIME%] auto-restore %* cwd=%CD% ==== >>"%LOG%"
if /i "%~1"=="--full" (
  "%PWSH%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%BASE%\plugins\core\restore-all.ps1" >>"%LOG%" 2>&1
) else (
  "%PWSH%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%BASE%\plugins\core\apply-all.ps1" >>"%LOG%" 2>&1
)
echo ==== [%DATE% %TIME%] exit=%ERRORLEVEL% ==== >>"%LOG%"
exit /b 0
