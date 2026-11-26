"""
WebView2 ctypes 绑定（仅依赖 Windows 系统自带的 Edge WebView2 Runtime）。

为什么用 ctypes：当前环境不允许运行时编译 C#（Add-Type / csc 均被安全策略拦截），
而 WebView2 的 C API 是标准 COM，用 ctypes 直接调即可，无需任何编译步骤或第三方包。

vtable 顺序来自官方 WebView2.h 1.0.4370.26：
  ICoreWebView2Environment.CreateCoreWebView2Controller           = slot 3
  ICoreWebView2Controller.put_Bounds                              = slot 6
  ICoreWebView2Controller.put_IsVisible                           = slot 4
  ICoreWebView2Controller.get_CoreWebView2                        = slot 25
  ICoreWebView2Controller2.put_DefaultBackgroundColor            = slot 27
  ICoreWebView2.Navigate                                          = slot 5
  ICoreWebView2.ExecuteScript                                     = slot 29
"""
import ctypes
import uuid
from ctypes import wintypes, CFUNCTYPE, POINTER, c_void_p, c_long, c_ulong, c_int, c_double, byref

U = ctypes.windll.user32
K = ctypes.windll.kernel32

# ── Win32 常量 ──────────────────────────────────────────────────────────────
GWLP_USERDATA = -21
WS_POPUP = 0x80000000
WS_VISIBLE = 0x10000000
WS_EX_LAYERED = 0x00080000
WS_EX_TRANSPARENT = 0x00000020
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_TOPMOST = 0x00000008
LWA_ALPHA = 0x00000002
HWND_TOPMOST = -1
SWP_NOSIZE = 0x0001
SWP_NOACTIVATE = 0x0010
HTCAPTION = 2
HTCLIENT = 1
WM_DESTROY = 0x0002
WM_CLOSE = 0x0010
WM_NCHITTEST = 0x0084
WM_HOTKEY = 0x0312
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
VK_F9 = 0x78
VK_F10 = 0x79
PM_REMOVE = 0x0001
COLORREF = wintypes.DWORD
HRESULT = c_long


class WNDCLASSEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.UINT), ("style", wintypes.UINT),
        ("lpfnWndProc", c_void_p), ("cbClsExtra", c_int), ("cbWndExtra", c_int),
        ("hInstance", c_void_p), ("hIcon", c_void_p),
        ("hCursor", c_void_p), ("hbrBackground", c_void_p),
        ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR),
        ("hIconSm", c_void_p),
    ]


class RECT(ctypes.Structure):
    _fields_ = [("left", c_long), ("top", c_long), ("right", c_long), ("bottom", c_long)]


class MSG(ctypes.Structure):
    _fields_ = [("hwnd", wintypes.HWND), ("message", wintypes.UINT),
                ("wParam", wintypes.WPARAM), ("lParam", wintypes.LPARAM),
                ("time", wintypes.DWORD), ("pt", wintypes.POINT)]


WNDPROC = CFUNCTYPE(c_long, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
U.RegisterClassExW.argtypes = [POINTER(WNDCLASSEXW)]
U.RegisterClassExW.restype = wintypes.ATOM
U.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
                              c_int, c_int, c_int, c_int, wintypes.HWND, wintypes.HMENU,
                              wintypes.HINSTANCE, c_void_p]
U.CreateWindowExW.restype = wintypes.HWND
U.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
U.DefWindowProcW.restype = c_long
U.PeekMessageW.argtypes = [POINTER(MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT, wintypes.UINT]
U.TranslateMessage.argtypes = [POINTER(MSG)]
U.DispatchMessageW.argtypes = [POINTER(MSG)]
U.SetLayeredWindowAttributes.argtypes = [wintypes.HWND, COLORREF, wintypes.BYTE, wintypes.DWORD]
U.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, c_int, c_int, c_int, c_int, wintypes.UINT]
U.GetWindowRect.argtypes = [wintypes.HWND, POINTER(RECT)]
U.GetWindowLongPtrW.argtypes = [wintypes.HWND, c_int]
U.GetWindowLongPtrW.restype = c_void_p
U.SetWindowLongPtrW.argtypes = [wintypes.HWND, c_int, c_void_p]
U.SetWindowLongPtrW.restype = c_void_p
U.RegisterHotKey.argtypes = [wintypes.HWND, c_int, wintypes.UINT, wintypes.UINT]
U.UnregisterHotKey.argtypes = [wintypes.HWND, c_int]
U.ReleaseCapture.restype = c_int


def make_window(title: str, w: int, h: int, x: int, y: int, proc, ex_style: int = 0):
    """创建无边框透明窗口，返回 HWND。proc 必须是已保活的 WNDPROC 实例。"""
    wc = WNDCLASSEXW()
    wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
    wc.lpfnWndProc = ctypes.cast(proc, c_void_p)
    wc.hInstance = K.GetModuleHandleW(None)
    wc.hCursor = U.LoadCursorW(None, 32512)
    wc.hbrBackground = 6
    wc.lpszClassName = "FishGirlWV2_" + str(ctypes.cast(proc, c_void_p).value)
    U.RegisterClassExW(byref(wc))
    hwnd = U.CreateWindowExW(ex_style, wc.lpszClassName, title,
                             WS_POPUP | WS_VISIBLE, x, y, w, h,
                             None, None, wc.hInstance, None)
    if not hwnd:
        raise ctypes.WinError()
    return hwnd


# ── COM 回调 ────────────────────────────────────────────────────────────────
REFIID = POINTER(ctypes.c_byte * 16)


def guid(s: str):
    return (ctypes.c_byte * 16).from_buffer_copy(uuid.UUID(s).bytes_le)


IID_IUNKNOWN = guid("00000000-0000-0000-C000-000000000046")
FN_QI = CFUNCTYPE(HRESULT, c_void_p, REFIID, POINTER(c_void_p))
FN_ADDREF = CFUNCTYPE(c_ulong, c_void_p)
FN_RELEASE = CFUNCTYPE(c_ulong, c_void_p)
FN_INVOKE_ENV = CFUNCTYPE(HRESULT, c_void_p, HRESULT, c_void_p)
FN_INVOKE_CTRL = CFUNCTYPE(HRESULT, c_void_p, HRESULT, c_void_p)


class VTableEnvCreated(ctypes.Structure):
    _fields_ = [("QueryInterface", FN_QI), ("AddRef", FN_ADDREF),
                ("Release", FN_RELEASE), ("Invoke", FN_INVOKE_ENV)]


class VTableCtrlCreated(ctypes.Structure):
    _fields_ = [("QueryInterface", FN_QI), ("AddRef", FN_ADDREF),
                ("Release", FN_RELEASE), ("Invoke", FN_INVOKE_CTRL)]


class ComHandler(ctypes.Structure):
    _fields_ = [("vtbl", c_void_p), ("ref", c_int)]


class HandlerBase:
    def __init__(self, vtbl_type, invoke_type, invoke_fn):
        self.vtbl = vtbl_type(FN_QI(self._qi), FN_ADDREF(self._addref),
                              FN_RELEASE(self._release), invoke_type(invoke_fn))
        self.com = ComHandler(ctypes.cast(byref(self.vtbl), c_void_p), 1)

    def _qi(self, this, riid, ppv):
        if not riid or not ppv:
            return -2147467261
        want = ctypes.string_at(riid, 16)
        if want == bytes(IID_IUNKNOWN):
            ppv[0] = ctypes.cast(byref(self.com), c_void_p)
            self.com.ref += 1
            return 0
        ppv[0] = None
        return -2147467262

    def _addref(self, this):
        self.com.ref += 1
        return self.com.ref

    def _release(self, this):
        self.com.ref -= 1
        return self.com.ref

    @property
    def ptr(self):
        return ctypes.cast(byref(self.com), c_void_p)


def call(method_index, obj, restype=HRESULT, *args):
    """按 vtable 槽位调用 COM 方法。参数自动映射为 ctypes 类型。"""
    vt = ctypes.cast(obj, POINTER(POINTER(c_void_p)))[0]
    atypes = []
    for a in args:
        if isinstance(a, ctypes.Structure):
            atypes.append(POINTER(type(a)))
        elif isinstance(a, str):
            atypes.append(wintypes.LPCWSTR)
        elif isinstance(a, ctypes._SimpleCData):
            atypes.append(type(a))
        else:
            atypes.append(c_void_p)
    proto = CFUNCTYPE(restype, c_void_p, *atypes)
    fn = ctypes.cast(vt[method_index], proto)
    return fn(obj, *args)


# ── Loader ─────────────────────────────────────────────────────────────────
import os as _os
LOADER = ctypes.CDLL(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "WebView2Loader.dll"))
CreateEnv = LOADER.CreateCoreWebView2EnvironmentWithOptions
CreateEnv.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, c_void_p, c_void_p]
CreateEnv.restype = HRESULT
GetVer = LOADER.GetAvailableCoreWebView2BrowserVersionString
GetVer.argtypes = [wintypes.LPCWSTR, POINTER(wintypes.LPWSTR)]
GetVer.restype = HRESULT


def runtime_version():
    ver = wintypes.LPWSTR()
    hr = GetVer(None, byref(ver))
    return ver.value if hr == 0 else None
