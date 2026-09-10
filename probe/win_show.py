"""把指定 hwnd 的窗口显示到前台，并回报显示前后的状态。"""
import ctypes
import ctypes.wintypes as wt
import sys
import time

u32 = ctypes.WinDLL("user32", use_last_error=True)
u32.IsWindowVisible.argtypes = [wt.HWND]
u32.IsWindowVisible.restype = wt.BOOL
u32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]
u32.ShowWindow.restype = wt.BOOL
u32.SetForegroundWindow.argtypes = [wt.HWND]
u32.SetForegroundWindow.restype = wt.BOOL
u32.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
u32.GetWindowRect.restype = wt.BOOL
u32.GetWindowLongW.argtypes = [wt.HWND, ctypes.c_int]
u32.GetWindowLongW.restype = ctypes.c_long

SW_SHOW = 5
SW_RESTORE = 9
GWL_STYLE = -16
WS_VISIBLE = 0x10000000


def snap(hwnd):
    r = wt.RECT()
    u32.GetWindowRect(hwnd, ctypes.byref(r))
    style = u32.GetWindowLongW(hwnd, GWL_STYLE)
    return {
        "visible": bool(u32.IsWindowVisible(hwnd)),
        "ws_visible": bool(style & WS_VISIBLE),
        "rect": (r.left, r.top, r.right, r.bottom),
    }


if __name__ == "__main__":
    hwnd = int(sys.argv[1])
    print("before:", snap(hwnd))
    u32.ShowWindow(hwnd, SW_SHOW)
    time.sleep(0.5)
    u32.ShowWindow(hwnd, SW_RESTORE)
    time.sleep(0.5)
    print("after :", snap(hwnd))
    fg = u32.SetForegroundWindow(hwnd)
    print("SetForegroundWindow:", bool(fg))
    time.sleep(0.3)
    print("前台窗口是否为本窗口:", u32.GetForegroundWindow() == hwnd)
