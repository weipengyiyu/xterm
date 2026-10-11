@echo off
start "" "%SystemRoot%\System32\wscript.exe" "%~dp0launcher.vbs" %*
exit /b %ERRORLEVEL%
