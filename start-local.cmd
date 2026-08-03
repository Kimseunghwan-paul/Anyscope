@echo off
setlocal
cd /d "%~dp0"

set "CLAUSESCOPE_NODE=C:\Users\GS\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%CLAUSESCOPE_NODE%" goto start

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js could not be found.
  echo Install Node.js 22.13 or later, then run this file again.
  pause
  exit /b 1
)
set "CLAUSESCOPE_NODE=node"

:start
echo ClauseScope Universal local server is starting.
echo Keep this window open and visit http://localhost:3000
echo.
"%CLAUSESCOPE_NODE%" build\run-vinext.mjs dev

echo.
echo The local server has stopped.
pause
