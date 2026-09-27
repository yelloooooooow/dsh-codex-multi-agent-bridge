@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-unified-bridge.ps1"
exit /b %ERRORLEVEL%
