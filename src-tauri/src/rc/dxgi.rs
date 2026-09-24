//! R4.0 — DXGI Desktop Duplication 抓帧（GPU 路径）。
//!
//! 比 GDI `BitBlt` 少一次全屏 CPU 拷贝。失败时调用方回退 GDI。
//!
//! R6：从「仅主屏的 `DxgiCapture`」升级为 [`DxgiPool`]——
//! 每个输出一个 duplicator，主屏 / 指定单屏 / 虚拟屏（多输出拼接）三种抓取
//! 都走 GPU 路径，H.264 硬编因此不再被「抓整屏就回退 GDI+JPEG」卡死。
//! 多屏拼接在 CPU 侧做：各输出读回自己的 BGRA，按桌面坐标贴进虚拟屏画布，
//! 行拷贝走 memcpy，代价远低于 GDI 全屏 BitBlt + 逐像素转换。

#![cfg(target_os = "windows")]

use windows::core::{IUnknown, Interface};
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET,
    D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::{
    IDXGIAdapter, IDXGIOutput1, IDXGIOutputDuplication, IDXGIResource, DXGI_ERROR_ACCESS_LOST,
    DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTPUT_DESC,
};
use windows::Win32::System::Com::CoUninitialize;

/// 单个输出的 duplicator + 复用的读回缓冲。
struct OutputDup {
    dup: IDXGIOutputDuplication,
    /// 桌面坐标（物理像素，虚拟屏坐标系）。
    left: i32,
    top: i32,
    width: u32,
    height: u32,
    staging: Option<ID3D11Texture2D>,
    /// P1 零拷贝路径：GPU 侧 BGRA 暂存纹理（DEFAULT 用法，不读回）。
    gpu_staging: Option<ID3D11Texture2D>,
    /// 最近一次读回的 BGRA（跨圈保留：虚拟屏拼接时，没更新的输出沿用旧内容）。
    buf: Vec<u8>,
}

/// P1 零拷贝抓帧结果：BGRA 纹理仍在显存里（自有纹理，DD 的 ReleaseFrame 后仍有效）。
pub struct GpuGrab {
    pub tex: ID3D11Texture2D,
    pub width: u32,
    pub height: u32,
}

impl OutputDup {
    /// 抓一帧读回 BGRA。返回是否真有新帧（超时 = false）。
    fn acquire(
        &mut self,
        device: &ID3D11Device,
        ctx: &ID3D11DeviceContext,
        timeout_ms: u32,
    ) -> Result<bool, String> {
        unsafe {
            let mut info = windows::Win32::Graphics::Dxgi::DXGI_OUTDUPL_FRAME_INFO::default();
            let mut res: Option<IDXGIResource> = None;
            match self.dup.AcquireNextFrame(timeout_ms, &mut info, &mut res) {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(false),
                Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST => {
                    return Err("DXGI 访问丢失".into());
                }
                Err(e) => return Err(format!("AcquireNextFrame：{e}")),
            }
            let inner = (|| -> Result<bool, String> {
                let Some(res) = res else {
                    return Ok(false);
                };
                let tex: ID3D11Texture2D = res.cast().map_err(|e| format!("tex cast：{e}"))?;
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                tex.GetDesc(&mut desc);

                let need_new = match &self.staging {
                    Some(s) => {
                        let mut d = D3D11_TEXTURE2D_DESC::default();
                        s.GetDesc(&mut d);
                        d.Width != desc.Width || d.Height != desc.Height
                    }
                    None => true,
                };
                if need_new {
                    let mut sd = desc;
                    sd.Usage = D3D11_USAGE_STAGING;
                    sd.BindFlags = 0;
                    sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                    sd.MiscFlags = 0;
                    sd.MipLevels = 1;
                    sd.ArraySize = 1;
                    let mut st: Option<ID3D11Texture2D> = None;
                    device.CreateTexture2D(&sd, None, Some(&mut st))
                        .map_err(|e| format!("staging：{e}"))?;
                    self.staging = Some(st.ok_or("staging 创建为空")?);
                    self.width = desc.Width;
                    self.height = desc.Height;
                }
                let staging = self.staging.clone().ok_or("staging 缺失")?;
                ctx.CopyResource(&staging, &tex);
                let w = self.width as usize;
                let h = self.height as usize;
                let need = w * h * 4;
                if self.buf.len() != need {
                    self.buf = vec![0u8; need];
                }
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                ctx.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                    .map_err(|e| format!("Map：{e}"))?;
                let pitch = mapped.RowPitch as usize;
                let src = mapped.pData as *const u8;
                if !src.is_null() {
                    for y in 0..h {
                        std::ptr::copy_nonoverlapping(
                            src.add(y * pitch),
                            self.buf.as_mut_ptr().add(y * w * 4),
                            w * 4,
                        );
                    }
                }
                ctx.Unmap(&staging, 0);
                Ok(true)
            })();
            let _ = self.dup.ReleaseFrame();
            inner
        }
    }

    /// P1 零拷贝：把 DD 帧拷进自有 BGRA GPU 纹理并交出。不 Map、不读回。
    fn acquire_gpu(
        &mut self,
        device: &ID3D11Device,
        ctx: &ID3D11DeviceContext,
        timeout_ms: u32,
    ) -> Result<Option<GpuGrab>, String> {
        unsafe {
            let mut info = windows::Win32::Graphics::Dxgi::DXGI_OUTDUPL_FRAME_INFO::default();
            let mut res: Option<IDXGIResource> = None;
            match self.dup.AcquireNextFrame(timeout_ms, &mut info, &mut res) {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(None),
                Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST => {
                    return Err("DXGI 访问丢失".into());
                }
                Err(e) => return Err(format!("AcquireNextFrame：{e}")),
            }
            let inner = (|| -> Result<Option<GpuGrab>, String> {
                let Some(res) = res else {
                    return Ok(None);
                };
                let tex: ID3D11Texture2D = res.cast().map_err(|e| format!("tex cast：{e}"))?;
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                tex.GetDesc(&mut desc);

                let need_new = match &self.gpu_staging {
                    Some(s) => {
                        let mut d = D3D11_TEXTURE2D_DESC::default();
                        s.GetDesc(&mut d);
                        d.Width != desc.Width || d.Height != desc.Height
                    }
                    None => true,
                };
                if need_new {
                    let mut sd = desc;
                    // GPU 侧暂存：VP 输入视图/编码器都吃 DEFAULT 纹理；
                    // BIND_RENDER_TARGET | BIND_SHADER_RESOURCE 是 VP 视图的安全集合
                    sd.Usage = windows::Win32::Graphics::Direct3D11::D3D11_USAGE_DEFAULT;
                    sd.BindFlags = (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0)
                        as u32;
                    sd.CPUAccessFlags = 0;
                    sd.MiscFlags = 0;
                    sd.MipLevels = 1;
                    sd.ArraySize = 1;
                    let mut st: Option<ID3D11Texture2D> = None;
                    device.CreateTexture2D(&sd, None, Some(&mut st))
                        .map_err(|e| format!("gpu staging：{e}"))?;
                    self.gpu_staging = Some(st.ok_or("gpu staging 创建为空")?);
                    self.width = desc.Width;
                    self.height = desc.Height;
                }
                let staging = self.gpu_staging.clone().ok_or("gpu staging 缺失")?;
                ctx.CopyResource(&staging, &tex);
                Ok(Some(GpuGrab {
                    tex: staging,
                    width: self.width,
                    height: self.height,
                }))
            })();
            let _ = self.dup.ReleaseFrame();
            inner
        }
    }
}

pub struct DxgiPool {
    device: Option<ID3D11Device>,
    ctx: Option<ID3D11DeviceContext>,
    outs: Vec<OutputDup>,
    /// 虚拟屏拼接画布（跨圈复用容量）。
    canvas: Vec<u8>,
    com_owned: bool,
    disabled: bool,
}

// MTA COM；async 要求 Send。会话任务串行访问。
unsafe impl Send for DxgiPool {}
unsafe impl Send for OutputDup {}

impl Default for DxgiPool {
    fn default() -> Self {
        Self::new()
    }
}

impl DxgiPool {
    pub fn new() -> Self {
        Self {
            device: None,
            ctx: None,
            outs: Vec::new(),
            canvas: Vec::new(),
            com_owned: false,
            disabled: false,
        }
    }

    pub fn is_enabled(&self) -> bool {
        !self.disabled
    }

    /// 抓一帧。`monitor >= 0` 抓指定显示器；`virtual_screen` 抓整块虚拟屏；
    /// 否则抓主屏。`Ok(None)` = 屏幕没变化（本圈无帧）。
    ///
    /// 错误语义（调用方一律回退 JPEG，但**是否禁用整池**不同）：
    /// - `[no_output]` 前缀 = 拓扑对不上（比如指定显示器在本 GPU 适配器上不存在），
    ///   换个范围还能用，不禁用；
    /// - 其它错误 = DXGI/D3D 本身坏了，禁用整池；「访问丢失」先重建一次，
    ///   重建失败才禁用。
    pub fn grab(
        &mut self,
        virtual_screen: bool,
        monitor: i32,
    ) -> Result<Option<(u32, u32, Vec<u8>)>, String> {
        if self.disabled {
            return Err("DXGI 已禁用".into());
        }
        if self.outs.is_empty() {
            match self.open() {
                Ok(()) => {}
                Err(e) => {
                    self.disabled = true;
                    return Err(e);
                }
            }
        }
        match self.grab_inner(virtual_screen, monitor) {
            Ok(v) => Ok(v),
            Err(e) => {
                if e.contains("访问丢失") {
                    match self.rebuild() {
                        Ok(()) => Ok(None),
                        Err(re) => {
                            self.disabled = true;
                            Err(format!("DXGI 重建失败：{re}"))
                        }
                    }
                } else if e.starts_with("[no_output]") {
                    Err(e)
                } else {
                    self.disabled = true;
                    Err(e)
                }
            }
        }
    }

    /// P1 零拷贝抓帧：单输出场景（主屏 / 指定单屏）把 DD 帧拷进**自有 GPU 纹理**，
    /// 全程不做 CPU 读回。多输出拼接没有 GPU 直通（要在 GPU 上合成），显式报错，
    /// 调用方回落 CPU 管线。
    ///
    /// 错误**不禁用**整池：GPU 路径失败时 CPU 路径（staging 读回）可能还好好的。
    pub fn grab_gpu(
        &mut self,
        virtual_screen: bool,
        monitor: i32,
    ) -> Result<Option<GpuGrab>, String> {
        if virtual_screen {
            return Err("[gpu_unavailable] 多屏拼接没有零拷贝路径（调用方应回落 CPU 管线）".into());
        }
        if self.disabled {
            return Err("[gpu_unavailable] DXGI 已禁用".into());
        }
        if self.outs.is_empty() {
            match self.open() {
                Ok(()) => {}
                Err(e) => return Err(format!("[gpu_unavailable] {e}")),
            }
        }
        let device = self
            .device
            .as_ref()
            .ok_or_else(|| "[gpu_unavailable] D3D11 设备缺失".to_string())?;
        let ctx = self
            .ctx
            .as_ref()
            .ok_or_else(|| "[gpu_unavailable] D3D11 上下文缺失".to_string())?;
        let idx = if monitor >= 0 {
            let (mx, my, mw, mh) = crate::screenshot::monitor_region(monitor)
                .map_err(|e| format!("[gpu_unavailable] 显示器 {monitor} 不可用：{e}"))?;
            self.outs
                .iter()
                .position(|o| {
                    o.left == mx && o.top == my && o.width == mw as u32 && o.height == mh as u32
                })
                .ok_or_else(|| "[gpu_unavailable] 显示器没有对应 DXGI 输出".to_string())?
        } else {
            self.outs
                .iter()
                .position(|o| o.left == 0 && o.top == 0)
                .ok_or_else(|| "[gpu_unavailable] 找不到主显示器输出".to_string())?
        };
        self.outs[idx].acquire_gpu(device, ctx, 30)
    }

    /// 编码器侧要用的 D3D11 设备（MFCreateDXGIDeviceManager 绑定 + VP 转换）。
    pub fn d3d_device(&self) -> Option<ID3D11Device> {
        self.device.clone()
    }

    pub fn d3d_ctx(&self) -> Option<ID3D11DeviceContext> {
        self.ctx.clone()
    }

    fn open(&mut self) -> Result<(), String> {
        let (device, ctx, outs, com_owned) = open_outputs()?;
        self.device = Some(device);
        self.ctx = Some(ctx);
        self.outs = outs;
        self.com_owned = com_owned;
        Ok(())
    }

    /// 重建（「访问丢失」后）：分辨率切换 / 显示器热插拔 / 安全桌面切换都会触发。
    fn rebuild(&mut self) -> Result<(), String> {
        log::info!("[RC] DXGI 访问丢失，重建 duplicators");
        self.drop_com();
        self.open()
    }

    fn drop_com(&mut self) {
        // 🔴 必须先放掉所有 COM 引用再 CoUninitialize，顺序反了就是悬垂释放
        self.outs.clear();
        self.device = None;
        self.ctx = None;
        self.canvas.clear();
        if self.com_owned {
            unsafe { CoUninitialize() };
            self.com_owned = false;
        }
    }

    fn grab_inner(
        &mut self,
        virtual_screen: bool,
        monitor: i32,
    ) -> Result<Option<(u32, u32, Vec<u8>)>, String> {
        let device = self
            .device
            .as_ref()
            .ok_or_else(|| "D3D11 设备缺失".to_string())?;
        let ctx = self
            .ctx
            .as_ref()
            .ok_or_else(|| "D3D11 上下文缺失".to_string())?;
        if monitor >= 0 {
            let (mx, my, mw, mh) = crate::screenshot::monitor_region(monitor)
                .map_err(|e| format!("[no_output] 显示器 {monitor} 不可用：{e}"))?;
            let idx = self
                .outs
                .iter()
                .position(|o| {
                    o.left == mx
                        && o.top == my
                        && o.width == mw as u32
                        && o.height == mh as u32
                })
                .ok_or_else(|| {
                    format!("[no_output] 显示器 {monitor} 没有对应的 DXGI 输出（多 GPU？）")
                })?;
            let o = &mut self.outs[idx];
            let fresh = o.acquire(device, ctx, 30)?;
            if !fresh {
                return Ok(None);
            }
            let (w, h) = (o.width, o.height);
            let buf = std::mem::take(&mut o.buf);
            return Ok(Some((w, h, buf)));
        }

        if !virtual_screen {
            // 主屏：沿用原约定（桌面坐标 (0,0) 的输出）
            let idx = self
                .outs
                .iter()
                .position(|o| o.left == 0 && o.top == 0)
                .ok_or_else(|| "[no_output] 找不到主显示器输出".to_string())?;
            let o = &mut self.outs[idx];
            let fresh = o.acquire(device, ctx, 30)?;
            if !fresh {
                return Ok(None);
            }
            let (w, h) = (o.width, o.height);
            let buf = std::mem::take(&mut o.buf);
            return Ok(Some((w, h, buf)));
        }

        // 虚拟屏：全部输出拼接。画布尺寸与 GDI 路径同源（SM_*VIRTUALSCREEN），
        // 长宽向上取偶（NV12/H.264 要求）；多出的 1px 是黑边，注入映射误差 <1px。
        let (sx, sy, sw, sh) = virtual_screen_metrics();
        if sw <= 0 || sh <= 0 {
            return Err("[no_output] 虚拟屏幕尺寸无效".into());
        }
        let cw = ((sw as u32) + 1) & !1;
        let ch = ((sh as u32) + 1) & !1;
        self.canvas.clear();
        self.canvas.resize(cw as usize * ch as usize * 4, 0);

        let mut any_fresh = false;
        for o in self.outs.iter_mut() {
            let fresh = o.acquire(device, ctx, 16)?;
            any_fresh = any_fresh || fresh;
            if o.buf.is_empty() {
                continue;
            }
            // 贴进画布（行 memcpy）。输出超出画布右/下的部分裁掉；
            // 画布起点在输出左侧/上侧时取 0。
            let ox = (o.left - sx).max(0) as usize;
            let oy = (o.top - sy).max(0) as usize;
            if ox >= cw as usize || oy >= ch as usize {
                continue;
            }
            let copy_w = (o.width as usize).min(cw as usize - ox);
            let copy_h = (o.height as usize).min(ch as usize - oy);
            for y in 0..copy_h {
                let src = &o.buf[y * o.width as usize * 4..(y * o.width as usize + copy_w) * 4];
                let dst = ((oy + y) * cw as usize + ox) * 4;
                self.canvas[dst..dst + copy_w * 4].copy_from_slice(src);
            }
        }
        if !any_fresh {
            return Ok(None);
        }
        let buf = std::mem::take(&mut self.canvas);
        Ok(Some((cw, ch, buf)))
    }
}

impl Drop for DxgiPool {
    fn drop(&mut self) {
        self.drop_com();
    }
}

fn open_outputs()
-> Result<(ID3D11Device, ID3D11DeviceContext, Vec<OutputDup>, bool), String> {
    unsafe {
        // 🔴 走 `ensure_mta_quiet` 而非 `.is_ok()`（2026-09-23）：被拒时（线程已是 STA）
        // 公寓仍是 STA，D3D11 抓屏 + 硬编 MFT 都在上面跑必然出问题，而这条信息过去
        // 被 `.is_ok()` 静默吞掉。返回语义与 `.is_ok()` 逐字等价（S_OK/S_FALSE 都算持有）。
        let com_owned = super::mft_diag::ensure_mta_quiet("DxgiPool::open_outputs");
        let inner = (|| -> Result<(ID3D11Device, ID3D11DeviceContext, Vec<OutputDup>), String> {
            let levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
            let mut device: Option<ID3D11Device> = None;
            let mut ctx: Option<ID3D11DeviceContext> = None;
            windows::Win32::Graphics::Direct3D11::D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                None,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&levels),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut ctx),
            )
            .map_err(|e| format!("D3D11 设备：{e}"))?;
            let device = device.ok_or("D3D11 设备为空")?;
            let ctx = ctx.ok_or("D3D11 上下文为空")?;

            let dxgi_dev: IUnknown = device.cast().map_err(|e| format!("cast dxgi：{e}"))?;
            let dxgi_dev: windows::Win32::Graphics::Dxgi::IDXGIDevice =
                dxgi_dev.cast().map_err(|e| format!("IDXGIDevice：{e}"))?;
            let adapter: IDXGIAdapter = dxgi_dev
                .GetAdapter()
                .map_err(|e| format!("GetAdapter：{e}"))?;

            let mut outs = Vec::new();
            for i in 0..8u32 {
                let Ok(out) = adapter.EnumOutputs(i) else {
                    break;
                };
                let desc: DXGI_OUTPUT_DESC = match out.GetDesc() {
                    Ok(d) => d,
                    Err(_) => continue,
                };
                let rc: RECT = desc.DesktopCoordinates;
                let width = (rc.right - rc.left).max(1) as u32;
                let height = (rc.bottom - rc.top).max(1) as u32;
                let Ok(out1) = out.cast::<IDXGIOutput1>() else {
                    continue;
                };
                match out1.DuplicateOutput(&device) {
                    Ok(dup) => {
                        outs.push(OutputDup {
                            dup,
                            left: rc.left,
                            top: rc.top,
                            width,
                            height,
                            staging: None,
                            gpu_staging: None,
                            buf: Vec::new(),
                        });
                    }
                    // 个别输出复制不了（休眠 / 受保护内容）不能拖垮整池，
                    // 该屏在拼接画布里留黑，由用户改抓单屏或 JPEG 兜底。
                    Err(e) => log::warn!("[RC] 输出 {} DuplicateOutput 失败：{e}", i),
                }
            }
            if outs.is_empty() {
                return Err("没有任何可复制的显示器输出".into());
            }
            Ok((device, ctx, outs))
        })();
        match inner {
            Ok((device, ctx, outs)) => Ok((device, ctx, outs, com_owned)),
            // 失败路径必须把 MTA 引用退掉，否则池禁用后 COM 计数悬挂
            Err(e) => {
                if com_owned {
                    CoUninitialize();
                }
                Err(e)
            }
        }
    }
}

/// 虚拟屏几何（物理像素）。与 `screenshot::virtual_screen_metrics` 同源——
/// 那个是私有的，这里直接读同一组 SM 常量，两处口径由常量保证一致。
fn virtual_screen_metrics() -> (i32, i32, i32, i32) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

mod color;

pub use color::{bgra_to_nv12, bgra_to_nv12_into, bgra_to_rgba};

#[cfg(test)]
mod tests;
