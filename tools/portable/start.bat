@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required. Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
if not exist "server\.env" (
  copy "server\.env.example" "server\.env" >nul
  echo Created server\.env. Open it in a text editor and put your Runware key after RUNWARE_API_KEY=
  echo Without a key the editor works but the AI buttons will say the key is missing.
  echo You can also run: start.bat --mock   to try the AI with fake free results.
  echo.
)
node server\serve.js --open %*
pause
