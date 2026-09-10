# -*- coding: utf-8 -*-
"""Reliable multi-view capture via screen grab of window rect (DPI-aware)."""
import ctypes
import os
import time

from PIL import Image, ImageFilter, ImageDraw, ImageFont

user32 = ctypes.windll.user32
OUT = r"D:\AItool\winapp\pastePanda\design\promo\shots\raw"
os.makedirs(OUT, exist_ok=True)

# Per-monitor DPI aware
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


def find_hwnd():
    result = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_long)
    def cb(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            n = user32.GetWindowTextLengthW(hwnd)
            if n:
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, buf, n + 1)
                if "PastePanda" in buf.value and "siw" not in buf.value.lower():
                    result.append(hwnd)
        return True

    user32.EnumWindows(cb, 0)
    return result[0] if result else None


def rect_of(hwnd):
    r = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return r


def grab(hwnd, name):
    user32.ShowWindow(hwnd, 3)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.55)
    r = rect_of(hwnd)
    # exclude 1px border noise
    bbox = (r.left, r.top, r.right, r.bottom)
    print(f"{name} bbox={bbox} size=({r.right-r.left}x{r.bottom-r.top})")
    from PIL import ImageGrab

    img = ImageGrab.grab(bbox=bbox, all_screens=True)
    path = os.path.join(OUT, name)
    img.save(path)
    print(f"  -> {path} {img.size}")
    return img


def click(hwnd, rx, ry):
    r = rect_of(hwnd)
    x, y = r.left + rx, r.top + ry
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.1)
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.05)
    user32.mouse_event(0x0004, 0, 0, 0, 0)
    time.sleep(0.45)
    print(f"  click rel=({rx},{ry}) abs=({x},{y})")


def main():
    hwnd = find_hwnd()
    if not hwnd:
        print("window not found")
        return
    print("hwnd", hwnd)
    # baseline record view
    grab(hwnd, "30-record.png")
    # header: hamburger ~50, logo center, tabs: 记录/工具/知识
    # From 2048-wide maximized: tabs roughly at 248/305/360 y=45
    # But client may have different chrome. Probe header y=48
    for name, rx in (("31-tools.png", 306), ("32-kb.png", 361), ("33-record.png", 249)):
        click(hwnd, rx, 48)
        grab(hwnd, name)
    # open menu
    click(hwnd, 48, 48)
    grab(hwnd, "34-menu.png")
    # escape
    user32.keybd_event(0x1B, 0, 0, 0)
    time.sleep(0.05)
    user32.keybd_event(0x1B, 0, 0x0002, 0)
    time.sleep(0.35)
    grab(hwnd, "35-record-final.png")
    print("done")


if __name__ == "__main__":
    main()
