"""诊断 PastePanda 主进程窗口状态（纯 ctypes，无需编译）。"""
import ctypes
import ctypes.wintypes as wt
import sys

u32 = ctypes.WinDLL("user32", use_last_error=True)
k32 = ctypes.WinDLL("kernel32", use_last_error=True)

u32.IsWindowVisible.argtypes = [wt.HWND]
u32.IsWindowVisible.restype = wt.BOOL
u32.IsIconic.argtypes = [wt.HWND]
u32.IsIconic.restype = wt.BOOL
u32.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
u32.GetWindowRect.restype = wt.BOOL
u32.GetWindowLongW.argtypes = [wt.HWND, ctypes.c_int]
u32.GetWindowLongW.restype = ctypes.c_long
u32.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
u32.GetWindowTextW.restype = ctypes.c_int
u32.EnumWindows.argtypes = [ctypes.c_void_p, wt.LPARAM]
u32.EnumWindows.restype = wt.BOOL
u32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
u32.GetWindowThreadProcessId.restype = wt.DWORD

GWL_STYLE = -16
GWL_EXSTYLE = -20
WS_VISIBLE = 0x10000000
WS_MINIMIZE = 0x20000000
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_APPWINDOW = 0x00040000

WNDENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def collect(pid_filter):
    found = []

    def cb(hwnd, _lparam):
        pid = wt.DWORD()
        u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value != pid_filter:
            return True
        style = u32.GetWindowLongW(hwnd, GWL_STYLE)
        ex = u32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        r = wt.RECT()
        u32.GetWindowRect(hwnd, ctypes.byref(r))
        buf = ctypes.create_unicode_buffer(256)
        u32.GetWindowTextW(hwnd, buf, 256)
        found.append(
            {
                "hwnd": hwnd,
                "title": buf.value,
                "visible_api": bool(u32.IsWindowVisible(hwnd)),
                "ws_visible": bool(style & WS_VISIBLE),
                "minimized": bool(u32.IsIconic(hwnd)),
                "rect": (r.left, r.top, r.right, r.bottom),
                "size": (r.right - r.left, r.bottom - r.top),
                "style": hex(style & 0xFFFFFFFF),
                "exstyle": hex(ex & 0xFFFFFFFF),
                "toolwin": bool(ex & WS_EX_TOOLWINDOW),
            }
        )
        return True

    u32.EnumWindows(WNDENUMPROC(cb), 0)
    return found


def monitors():
    out = []

    def cb(hmon, hdc, lprc, data):
        r = ctypes.cast(lprc, ctypes.POINTER(wt.RECT)).contents
        out.append((r.left, r.top, r.right, r.bottom))
        return True

    MONITORENUMPROC = ctypes.WINFUNCTYPE(
        wt.BOOL, wt.HMONITOR, wt.HDC, ctypes.POINTER(wt.RECT), wt.LPARAM
    )
    u32.EnumDisplayMonitors(0, 0, MONITORENUMPROC(cb), 0)
    return out


if __name__ == "__main__":
    pid = int(sys.argv[1])
    wins = collect(pid)
    print(f"PID {pid} 拥有窗口数: {len(wins)}")
    print("显示器:", monitors())
    for w in wins:
        print("-" * 60)
        for k, v in w.items():
            print(f"  {k:12}: {v}")
    if not wins:
        print("  (无窗口)")

    # 前台窗口是谁
    fg = u32.GetForegroundWindow()
    fpid = wt.DWORD()
    u32.GetWindowThreadProcessId(fg, ctypes.byref(fpid))
    buf = ctypes.create_unicode_buffer(256)
    u32.GetWindowTextW(fg, buf, 256)
    print("-" * 60)
    print(f"当前前台窗口: hwnd={fg} pid={fpid.value} title={buf.value!r}")
