@echo off
cd /d "%~dp0"
where bun >nul 2>nul
if %errorlevel%==0 (
  bun dev
) else (
  echo Bun not found - install it from https://bun.sh, then reopen this window.
  pause
  exit /b 1
)
pause
