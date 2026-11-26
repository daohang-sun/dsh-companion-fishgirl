@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === 大肥鱼 Live2D 桌宠 - WebView2 透明桌宠 ===
echo.
echo 使用 Windows 系统自带的 Edge WebView2 Runtime，无需 Electron、无需游戏引擎。
echo 拖动窗口顶部移动 · F9 切换鼠标穿透 · Ctrl+Shift+Q 退出
echo.

if not exist config.json (
  copy /Y config.example.json config.json >nul
  echo 已生成 config.json，请把 modelPath 改为解压出的 DeepSeek 文件夹后重试。
  notepad config.json
  goto END
)

python webview2\host.py
if errorlevel 1 goto FAIL
goto END

:FAIL
echo.
echo 启动失败。请检查：
echo 1. 已安装 Python 3 且加入 PATH
echo 2. 系统已安装 Edge / WebView2 Runtime
echo 3. config.json 的 modelPath 指向含 大肥鱼.model3.json 的目录
pause

:END
