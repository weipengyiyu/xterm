@echo off
setlocal
chcp 65001 >nul
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" %*
set "launchExit=%ERRORLEVEL%"
if not "%launchExit%"=="0" if not defined XTERM_PROOF pause
exit /b %launchExit%
