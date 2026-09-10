# -*- coding: utf-8 -*-
"""Capture only the PastePanda window client area; click tabs by fraction of width."""
import ctypes
import os
import time

from PIL import Image, ImageGrab

user32 = ctypes.windll.user32
OUT = r"D:\AItool\winapp\pastePanda\design\promo\shots\raw"
os.makedirs(OUT, exist_ok=True)
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    user32.SetProcessDPIAware()


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


def find_hwnd():
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_long)
    def cb(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            n = user32.GetWindowTextLengthW(hwnd)
            if n:
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, buf, n + 1)
                t = buf.value
                if "PastePanda" in t and "siw" not in t.lower():
                    found.append(hwnd)
        return True

    user32.EnumWindows(cb, 0)
    return found[0] if found else None


def get_rect(hwnd):
    r = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return r


def cap(hwnd, name):
    user32.ShowWindow(hwnd, 3)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.6)
    r = get_rect(hwnd)
    w, h = r.right - r.left, r.bottom - r.top
    # skip if absurd multi-monitor span (maximized should be ~display size)
    sm_w = user32.GetSystemMetrics(0)
    sm_h = user32.GetSystemMetrics(1)
    print(f"{name}: win={w}x{h} at ({r.left},{r.top}) screen={sm_w}x{sm_h}")
    # clamp to primary screen if needed
    if w > sm_w * 1.6 or h > sm_h * 1.6:
        # likely DPI-virtualized multi-monitor; use work area
        r.left, r.top = 0, 0
        r.right, r.bottom = sm_w, sm_h
        w, h = sm_w, sm_h
        print(f"  clamped to primary {w}x{h}")
    img = ImageGrab.grab(bbox=(r.left, r.top, r.right, r.bottom), all_screens=True)
    path = os.path.join(OUT, name)
    img.save(path)
    print(f"  saved {path} {img.size}")
    return img


def click_frac(hwnd, fx, fy):
    r = get_rect(hwnd)
    w, h = r.right - r.left, r.bottom - r.top
    x = int(r.left + w * fx)
    y = int(r.top + h * fy)
    user32.SetCursorPos(x, y)
    time.sleep(0.12)
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.05)
    user32.mouse_event(0x0004, 0, 0, 0, 0)
    time.sleep(0.5)
    print(f"  click frac=({fx:.3f},{fy:.3f}) -> ({x},{y})")


def main():
    hwnd = find_hwnd()
    if not hwnd:
        print("not found")
        return
    print("hwnd", hwnd)
    cap(hwnd, "40-base.png")
    # From good 2048-wide shot: 记录≈0.121, 工具≈0.149, 知识≈0.176 of width; y≈45/1118≈0.040
    # On 2578 window those fractions still apply
    click_frac(hwnd, 0.149, 0.040)
    cap(hwnd, "41-tools.png")
    click_frac(hwnd, 0.176, 0.040)
    cap(hwnd, "42-kb.png")
    # open a note for detail - click first note row ~ y 0.22 of height, x 0.15
    click_frac(hwnd, 0.15, 0.22)
    cap(hwnd, "43-kb-note.png")
    click_frac(hwnd, 0.121, 0.040)
    cap(hwnd, "44-record.png")
    print("done")


if __name__ == "__main__":
    main()
