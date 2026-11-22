@echo off
cd /d "%~dp0"
echo === Big Fish Live2D Desktop Pet (browser mode, no install) ===
echo.
node server-only.mjs
if errorlevel 1 (
  echo.
  echo Failed to start. Check that Node.js is installed and modelPath in config.json is correct.
  pause
)
