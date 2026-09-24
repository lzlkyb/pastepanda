//! 动态加载 FFmpeg DLL 并解析符号。
//!
//! 🔴 **本文件是探针的核心论点**：avcodec-63.dll 必须以 `LoadLibraryEx` 加载，
//! 绝不能静态导入。静态导入会把它写进 PE 的 Import Directory，Windows loader 在
//! **进程启动时**就解析它 —— 文件缺失（升级残留 / 杀软删 / 磁盘满 / 用户手删）时
//! 结果是「**整个 app 打不开**」，而不是「硬件编码不可用」。这与口径 B 被否决
//! 是同一个坑（见 docs 的 §3.8.8）。
//!
//! ⚠️ **第二个坑（这才是本探针要实测的）**：`avcodec-63.dll` 自己依赖同目录的
//! `libvpl-2.dll`。默认的 DLL 搜索顺序里**不包含「被加载 DLL 所在目录」**，
//! 所以直接 `LoadLibraryExW(avcodec绝对路径, NULL, 0)` 会在解析 libvpl-2.dll 时失败。
//! 解法是 `LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR`（把一个"被加载 DLL 自身的目录"
//! 加进它的依赖搜索路径）。本文件默认就用它，并在 `--no-dll-dir` 下可复现失败，
//! 用于证明这个 flag 是必需的而不是"顺手加的"。

use anyhow::{bail, Context, Result};
use std::ffi::{c_void, CString};
use std::path::Path;

// kernel32 永远在位 —— 静态链接它不构成「可选依赖」问题。
#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryExW(path: *const u16, hfile: *mut c_void, flags: u32) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
    fn FreeLibrary(module: *mut c_void) -> i32;
    fn GetLastError() -> u32;
}

/// `LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR`：把**被加载 DLL 自身所在目录**加入其依赖搜索路径。
/// 这是 libvpl-2.dll 能被找到的唯一原因。
const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x0000_0100;
/// 让 System32 / 应用目录等标准位置对**依赖**也生效（否则 DLL_LOAD_DIR 是唯一路径）。
const LOAD_LIBRARY_SEARCH_DEFAULT_DIRS: u32 = 0x0000_1000;

/// 一个已加载的 DLL（Drop 时 FreeLibrary）。不可 Copy —— 复制会导致重复卸载。
pub struct Dll {
    handle: *mut c_void,
    name: String,
}

impl Dll {
    /// 按绝对路径加载。`dll_load_dir=true` 时把 DLL 自身目录加进依赖搜索路径
    /// （**生产形态用 true**；`false` 仅用于复现「不加这个 flag 会失败」）。
    pub fn load(path: &Path, dll_load_dir: bool) -> Result<Self> {
        let abs = std::fs::canonicalize(path)
            .with_context(|| format!("DLL 路径不存在或不可访问：{}", path.display()))?;
        // canonicalize 在 Windows 上会给出 \\?\ 前缀，LoadLibraryExW 能吃下
        let wide: Vec<u16> = abs
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let flags = if dll_load_dir {
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS
        } else {
            0
        };
        let handle = unsafe { LoadLibraryExW(wide.as_ptr(), std::ptr::null_mut(), flags) };
        if handle.is_null() {
            let err = unsafe { GetLastError() };
            bail!(
                "LoadLibraryExW 失败：{}（GetLastError={err}；{}）",
                abs.display(),
                explain_loader_error(err)
            );
        }
        let name = abs
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(Self { handle, name })
    }

    /// 解析符号。失败信息要能直接指向「版本不匹配」而不是干瘪的 not found。
    pub fn sym<T>(&self, name: &str) -> Result<T> {
        let cname = CString::new(name).expect("符号名不含 NUL");
        let p = unsafe { GetProcAddress(self.handle, cname.as_ptr() as *const u8) };
        if p.is_null() {
            bail!(
                "符号缺失：{}!{}（DLL 版本不匹配？本 DLL 由 FFmpeg 9.0.2 / libavcodec 63 构建）",
                self.name,
                name
            );
        }
        // 函数指针与 *mut c_void 同为 8 字节；调用方给出的 T 必须是 extern fn 指针类型。
        Ok(unsafe { std::mem::transmute_copy::<*mut c_void, T>(&p) })
    }
}

impl Drop for Dll {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { FreeLibrary(self.handle) };
        }
    }
}

/// 把 Windows loader 的错误码翻成人话 —— 这两个码在「DLL 布局不对」时最常出现。
fn explain_loader_error(code: u32) -> &'static str {
    match code {
        126 => "ERROR_MOD_NOT_FOUND：依赖 DLL 找不到（本工程踩过：libvpl-2.dll 在别的目录）",
        127 => "ERROR_PROC_NOT_FOUND：依赖 DLL 里找不到需要的导出",
        193 => "ERROR_BAD_EXE_FORMAT：位数/架构不匹配（x64 进程加载了 x86 DLL？）",
        5 => "ERROR_ACCESS_DENIED：被占用或权限不足",
        _ => "见 Windows 系统错误码表",
    }
}

use std::os::windows::ffi::OsStrExt;
