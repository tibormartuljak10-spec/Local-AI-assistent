@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Building the Windows installer requires Node.js 22.12 or newer and npm.
  echo Install Node.js from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=12)?0:1)" >nul 2>&1
if errorlevel 1 (
  echo This installer build requires Node.js 22.12 or newer.
  pause
  exit /b 1
)

echo Installing desktop packaging dependencies...
call npm install
if errorlevel 1 (
  echo Dependency installation failed.
  pause
  exit /b 1
)

echo Building the Windows x64 installer...
call npm run dist:win
if errorlevel 1 (
  echo The Windows installer could not be built.
  pause
  exit /b 1
)

echo.
echo Installer created in the release folder.
pause
