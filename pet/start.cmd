@echo off
cd /d "%~dp0"
echo === Big Fish Live2D Desktop Pet - offline launcher ===
echo.
echo Using system Chrome/Edge app window. No npm install, no network needed.
echo.

if not exist config.json goto NOCONFIG
node launch.mjs
if errorlevel 1 goto FAIL
goto END

:NOCONFIG
copy /Y config.example.json config.json >nul
echo config.json created.
echo Please set "modelPath" to your extracted DeepSeek folder, then run again.
notepad config.json
goto END

:FAIL
echo.
echo Failed to start.
echo 1. Check modelPath in config.json points to the extracted DeepSeek folder.
echo 2. Check Chrome or Edge is installed.
echo 3. Or open this folder and run: node server-only.mjs
pause

:END
