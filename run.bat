@echo off
setlocal
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org/
    pause
    exit /b 1
)

node "%~dp0scripts\launch.js" %*
set "launchExit=%ERRORLEVEL%"
if not "%launchExit%"=="0" pause
exit /b %launchExit%
