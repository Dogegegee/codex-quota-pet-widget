@echo off
setlocal

cd /d "%~dp0"

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)

if not exist "dist\index.html" (
  echo Building widget...
  call npm run build
  if errorlevel 1 exit /b 1
)

start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
