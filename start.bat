@echo off
setlocal
cd /d "%~dp0"

set "INSTALLER="
for %%f in ("%~dp0release\Local-Project-Assistant-Setup-*.exe") do if exist "%%~ff" set "INSTALLER=%%~ff"
if defined INSTALLER (
  start "" "%INSTALLER%"
  exit /b 0
)

set "APP_EXE=%LOCALAPPDATA%\Programs\Local Project Assistant\Local Project Assistant.exe"
if exist "%APP_EXE%" (
  start "" "%APP_EXE%"
  exit /b 0
)

where node >nul 2>&1
if errorlevel 1 (
  echo The Windows desktop app is not installed yet.
  echo First run build-windows.bat on a PC with Node.js 22.12 or newer,
  echo then install the setup file from the release folder.
  pause
  exit /b 1
)

node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=12)?0:1)" >nul 2>&1
if errorlevel 1 (
  echo Building or launching from source requires Node.js 22.12 or newer.
  pause
  exit /b 1
)

if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo Installing desktop app development dependencies...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

echo Starting Local Project Assistant in its Windows desktop window...
call npm run start:desktop
if errorlevel 1 (
  echo The desktop app could not start.
  pause
  exit /b 1
)
