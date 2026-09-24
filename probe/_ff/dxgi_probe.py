"""DXGI 适配器枚举顺序探针（ctypes 直调 COM，零依赖）。
用途：验证 HKCU\\...\\UserGpuPreferences 的 GpuPreference 是否真的改变了
本进程可见的适配器顺序 —— 这是判断「GPU 偏好是否生效」的唯一进程内直接证据。
"""
import ctypes
from ctypes import (c_void_p, c_uint32, c_int32, c_uint16, c_ubyte, c_size_t,
                    c_wchar, POINTER, Structure, byref)


class GUID(Structure):
    _fields_ = [("Data1", c_uint32), ("Data2", c_uint16), ("Data3", c_uint16),
                ("Data4", c_ubyte * 8)]


class LUID(Structure):
    _fields_ = [("LowPart", c_uint32), ("HighPart", c_int32)]


class ADAPTER_DESC1(Structure):
    _fields_ = [
        ("Description", c_wchar * 128),
        ("VendorId", c_uint32),
        ("DeviceId", c_uint32),
        ("SubSysId", c_uint32),
        ("Revision", c_uint32),
        ("DedicatedVideoMemory", c_size_t),
        ("DedicatedSystemMemory", c_size_t),
        ("SharedSystemMemory", c_size_t),
        ("AdapterLuid", LUID),
        ("Flags", c_uint32),
    ]


IID_IDXGIFactory1 = GUID(0x770AAE78, 0xF26F, 0x4DBA,
                        (c_ubyte * 8)(0xA8, 0x29, 0x25, 0x3C, 0x83, 0xD1, 0xB3, 0x87))


def vtbl_fn(obj, idx, restype, *argtypes):
    """取 COM 对象 vtable 第 idx 个方法（idx 含 IUnknown 的 3 个）。"""
    vt = ctypes.cast(obj, POINTER(POINTER(c_void_p)))[0]
    return ctypes.WINFUNCTYPE(restype, c_void_p, *argtypes)(vt[idx])


def main():
    dxgi = ctypes.WinDLL("dxgi")
    CreateDXGIFactory1 = dxgi.CreateDXGIFactory1
    CreateDXGIFactory1.argtypes = [POINTER(GUID), POINTER(c_void_p)]
    CreateDXGIFactory1.restype = ctypes.c_long

    fac = c_void_p()
    hr = CreateDXGIFactory1(byref(IID_IDXGIFactory1), byref(fac))
    if hr < 0:
        print("CreateDXGIFactory1 失败 hr=%#x" % (hr & 0xFFFFFFFF))
        return 1

    enum_adapters1 = vtbl_fn(fac, 12, ctypes.c_long, ctypes.c_uint, POINTER(c_void_p))
    i = 0
    while True:
        ad = c_void_p()
        if enum_adapters1(fac, i, byref(ad)) < 0:
            break
        get_desc1 = vtbl_fn(ad, 10, ctypes.c_long, POINTER(ADAPTER_DESC1))
        d = ADAPTER_DESC1()
        if get_desc1(ad, byref(d)) >= 0:
            kind = "软件" if (d.Flags & 1) else "硬件"
            print("  [%d] %-34s vendor=%#06x %s" % (i, d.Description, d.VendorId, kind))
        i += 1
    print("  共 %d 个适配器" % i)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
