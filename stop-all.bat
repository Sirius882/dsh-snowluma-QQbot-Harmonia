@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Harmonia\scripts\manage-services.ps1" -Action Stop
if errorlevel 1 pause
