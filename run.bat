@echo off
setlocal
chcp 65001 >nul
if exist "%~dp0runtime\node.exe" (
    "%~dp0runtime\node.exe" "%~dp0scripts\launch.js" %*
    if errorlevel 1 (
        pause
        exit /b 1
    )
    exit /b 0
)
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
