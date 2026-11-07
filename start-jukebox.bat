@echo off
cd /d "%~dp0"
where bun >nul 2>nul
if %errorlevel%==0 (
  bun start
) else (
  echo Bun not found - install it from https://bun.sh, falling back to node.
  node start.js
)
pause
