"""
大肥鱼 Live2D 桌宠 · WebView2 透明宿主（Windows 系统自带组件，无外接游戏引擎/无 Electron）

职责：
  1. 启动同目录上层的 server.mjs（本机 HTTP + Live2D 模型服务 + 命令/事件队列），
     等待它写出 api.json；
  2. 创建透明、无边框、置顶的 Win32 窗口，用系统 WebView2 Runtime 加载桌宠页面；
  3. 顶部 44px 作为拖拽区（HTCAPTION），其余区域交给 Live2D 交互；
  4. 热键：F9 切换鼠标穿透，Ctrl+Shift+Q 退出；
  5. 全链路不写 token 到页面，只把 url + token 作为 URL 参数传给本地页。

依赖：仅 Python 3.8+ 与 Windows 自带 Edge WebView2 Runtime。
"""
import ctypes
import json
import os
import subprocess
import sys
import time
from ctypes import wintypes, c_void_p, c_long, byref, POINTER, CFUNCTYPE
from pathlib import Path

import wv2
from wv2 import (U, MSG, RECT as RECT_T, WNDPROC, HandlerBase, VTableEnvCreated,
                 VTableCtrlCreated, FN_INVOKE_ENV, FN_INVOKE_CTRL,
                 CreateEnv, call, COLORREF, LWA_ALPHA, HWND_TOPMOST,
                 SWP_NOSIZE, SWP_NOACTIVATE, HTCAPTION, HTCLIENT,
                 WM_DESTROY, WM_NCHITTEST, WM_HOTKEY, MOD_CONTROL, MOD_SHIFT,
                 VK_F9, PM_REMOVE, runtime_version)

# ex_style 组合单独算
EX_STYLE = wv2.WS_EX_LAYERED | wv2.WS_EX_TOOLWINDOW

PET_DIR = Path(__file__).resolve().parent.parent          # pet/
CONFIG_PATH = PET_DIR / "config.json"
API_PATH = PET_DIR / "api.json"
USER_DATA = Path(__file__).resolve().parent / "userdata"
SERVER = PET_DIR / "server.mjs"

STATE = {
    "hwnd": None, "env": None, "controller": None, "webview": None,
    "drag_top": 44, "click_through": False, "running": True,
    "server": None, "status": "starting",
}


def log(msg):
    print(f"[WebView2桌宠] {msg}", flush=True)


# ── 本机服务 ────────────────────────────────────────────────────────────────
def start_server():
    """启动 server-only.mjs，等待 api.json 就绪。返回 {url, token}。"""
    cfg = {}
    if CONFIG_PATH.exists():
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    port = int(cfg.get("port") or 18731)
    # 清掉环境变量注入，避免 node 子进程被 shim 干扰
    env = dict(os.environ)
    for k in list(env):
        kl = k.lower()
        if kl in ("node_options", "node_extra_ca_certs") or "experimental" in kl:
            env.pop(k, None)
    # 用 server-only.mjs：它自带模型探测 + listen()，且不依赖 Electron
    script = PET_DIR / "server-only.mjs"
    log(f"启动本机服务 {script.name}（端口 {port}）…")
    proc = subprocess.Popen(
        ["node", str(script)], cwd=str(PET_DIR), env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
    )
    STATE["server"] = proc
    # 等待 api.json（最多 25 秒）
    deadline = time.time() + 25
    while time.time() < deadline:
        if API_PATH.exists():
            try:
                data = json.loads(API_PATH.read_text(encoding="utf-8"))
                if data.get("url") and data.get("token"):
                    log("本机服务已就绪")
                    return data
            except Exception:
                pass
        if proc.poll() is not None:
            out = ""
            try:
                out = proc.stdout.read()[-2000:]
            except Exception:
                pass
            raise RuntimeError(f"本机服务启动失败（code={proc.returncode}）：\n{out}")
        time.sleep(0.25)
    raise TimeoutError("本机服务 25 秒内未写出 api.json，请检查 modelPath 配置")


# ── 窗口过程 ────────────────────────────────────────────────────────────────
def make_wndproc():
    def proc(hwnd, msg, wparam, lparam):
        if msg == WM_NCHITTEST:
            # 顶部条可拖动；其余交给 WebView2 处理点击
            rc = RECT_T()
            U.GetWindowRect(hwnd, byref(rc))
            # lParam 是屏幕坐标
            x = lparam & 0xFFFF
            if x >= 32768:
                x -= 65536
            y = (lparam >> 16) & 0xFFFF
            if y >= 32768:
                y -= 65536
            if rc.top <= y <= rc.top + STATE["drag_top"]:
                return HTCAPTION
            return HTCLIENT
        if msg == WM_HOTKEY:
            hotkey_id = int(wparam)
            if hotkey_id == 1:  # F9：切换穿透
                STATE["click_through"] = not STATE["click_through"]
                flags = EX_STYLE | (wv2.WS_EX_TRANSPARENT if STATE["click_through"] else 0)
                U.SetWindowLongPtrW(hwnd, -20, flags)  # GWL_EXSTYLE
                U.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                               SWP_NOSIZE | SWP_NOACTIVATE | 0x0002)  # SWP_FRAMECHANGED
                log("鼠标穿透：" + ("开" if STATE["click_through"] else "关"))
            elif hotkey_id == 2:  # Ctrl+Shift+Q：退出
                U.DestroyWindow(hwnd)
            return 0
        if msg == WM_DESTROY:
            STATE["running"] = False
            U.PostQuitMessage(0)
            return 0
        return U.DefWindowProcW(hwnd, msg, wparam, lparam)
    return WNDPROC(proc)


# ── WebView2 回调 ───────────────────────────────────────────────────────────
class EnvHandler(HandlerBase):
    def __init__(self, url):
        super().__init__(VTableEnvCreated, FN_INVOKE_ENV, self.invoke)
        self.url = url

    def invoke(self, this, hr, env):
        if hr != 0 or not env:
            log(f"创建 WebView2 环境失败 hr={hr}")
            STATE["running"] = False
            return 0
        STATE["env"] = env
        ch = CtrlHandler(self.url)
        STATE["_ctrl_handler"] = ch
        h = call(3, env, c_long, wintypes.HWND(STATE["hwnd"]), ch.ptr)
        if h != 0:
            log(f"创建 Controller 失败 hr={h}")
            STATE["running"] = False
        return 0


class CtrlHandler(HandlerBase):
    def __init__(self, url):
        super().__init__(VTableCtrlCreated, FN_INVOKE_CTRL, self.invoke)
        self.url = url

    def invoke(self, this, hr, ctrl):
        if hr != 0 or not ctrl:
            log(f"创建 Controller 回调失败 hr={hr}")
            STATE["running"] = False
            return 0
        STATE["controller"] = ctrl
        try:
            # ICoreWebView2Controller2::put_DefaultBackgroundColor —— 透明背景
            call(27, ctrl, c_long, COLORREF(0x00FFFFFF))
        except Exception as e:
            log(f"透明背景设置失败（不影响使用）：{e}")
        wv = c_void_p()
        h = call(25, ctrl, c_long, byref(wv))
        if h != 0 or not wv.value:
            log(f"获取 WebView 失败 hr={h}")
            STATE["running"] = False
            return 0
        STATE["webview"] = wv
        # 按当前窗口尺寸设置 WebView2 边界
        rc = RECT_T()
        U.GetWindowRect(STATE["hwnd"], byref(rc))
        call(6, ctrl, c_long, RECT_T(0, 0, rc.right - rc.left, rc.bottom - rc.top))
        call(4, ctrl, c_long, wintypes.BOOL(1))  # put_IsVisible
        nav = call(5, wv, c_long, self.url)
        if nav != 0:
            log(f"导航失败 hr={nav}")
        else:
            log("页面已加载：" + self.url.split("?")[0])
            STATE["status"] = "ready"
        return 0


# ── 主流程 ──────────────────────────────────────────────────────────────────
def main():
    ver = runtime_version()
    if not ver:
        log("未检测到 WebView2 Runtime。请确认系统已安装 Edge / WebView2 Runtime。")
        sys.exit(2)
    log(f"WebView2 Runtime {ver}")

    info = start_server()
    url = info["url"].rstrip("/") + "/?token=" + info["token"]

    # 默认窗口尺寸与位置（右下角）
    w, h = 360, 520
    sm = wintypes.HWND()
    width = U.GetSystemMetrics(0)
    height = U.GetSystemMetrics(1)
    x, y = max(0, width - w - 40), max(0, height - h - 60)

    proc = make_wndproc()
    hwnd = wv2.make_window("大肥鱼 · 桌宠", w, h, x, y, proc, EX_STYLE)
    STATE["hwnd"] = hwnd
    U.SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA)
    U.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE)

    U.RegisterHotKey(hwnd, 1, 0, VK_F9)                       # F9 穿透
    U.RegisterHotKey(hwnd, 2, MOD_CONTROL | MOD_SHIFT, ord("Q"))  # Ctrl+Shift+Q 退出

    USER_DATA.mkdir(parents=True, exist_ok=True)
    eh = EnvHandler(url)
    STATE["_env_handler"] = eh
    hr = CreateEnv(None, str(USER_DATA), None, eh.ptr)
    if hr != 0:
        log(f"CreateEnv 失败 hr={hr}")
        sys.exit(3)

    log("窗口已就绪：拖动顶部移动 · F9 鼠标穿透 · Ctrl+Shift+Q 退出")
    msg = MSG()
    while STATE["running"]:
        if not U.PeekMessageW(byref(msg), None, 0, 0, PM_REMOVE):
            time.sleep(0.015)
            continue
        U.TranslateMessage(byref(msg))
        U.DispatchMessageW(byref(msg))

    for hid in (1, 2):
        U.UnregisterHotKey(hwnd, hid)
    srv = STATE.get("server")
    if srv and srv.poll() is None:
        srv.terminate()
        try:
            srv.wait(timeout=3)
        except Exception:
            srv.kill()
    log("已退出")


if __name__ == "__main__":
    main()
