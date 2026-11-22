@echo off
cd /d "%~dp0"
echo === Big Fish Live2D Desktop Pet - Electron window (needs npm install) ===
echo.

if not exist node_modules\electron\dist\electron.exe goto NEEDINSTALL
node launch-electron.mjs
goto END

:NEEDINSTALL
echo Electron not found. Installing (needs network, ~100MB)...
call npm install
if errorlevel 1 goto FAIL
node launch-electron.mjs
goto END

:FAIL
echo.
echo npm install failed. Use start.cmd instead - no install and no network needed.
pause

:END
