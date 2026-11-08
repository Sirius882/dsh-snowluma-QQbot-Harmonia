@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts\configure-snowluma.mjs
if errorlevel 1 goto done
cd /d "%~dp0vendor\snowluma"
set "PATH=%CD%;%PATH%"
node.exe check-node-version.cjs
if errorlevel 1 goto done
set "SNOWLUMA_LOG_DIR=%~dp0..\.cache\harmonia\snowluma-logs"
node.exe index.mjs
:done
pause
