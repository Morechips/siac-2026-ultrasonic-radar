@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22.12 or newer.
  pause
  exit /b 1
)
if not exist "node_modules\vite\bin\vite.js" (
  echo Installing dependencies. Internet is required for the first run...
  call npm.cmd ci
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo.
echo Sonar Lab: http://localhost:5173/
echo Open this address in desktop Chrome.
echo Keep this window open. Press Ctrl+C to stop.
echo.
call npm.cmd run dev
if errorlevel 1 pause
