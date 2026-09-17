//! R4.0 — DXGI Desktop Duplication 抓帧（GPU 路径）。
//!
//! 比 GDI `BitBlt` 少一次全屏 CPU 拷贝。失败时调用方回退 GDI。
//! 仅主输出；多屏虚拟仍走 GDI。

#![cfg(target_os = "windows")]

use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CPU_ACCESS_READ, D3D11_MAPPED_SUBRESOURCE,
    D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::{
    DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTPUT_DESC, IDXGIAdapter,
    IDXGIOutput1, IDXGIOutputDuplication, IDXGIResource,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::core::{IUnknown, Interface};

pub struct DxgiDuplicator {
    device: ID3D11Device,
    ctx: ID3D11DeviceContext,
    dup: IDXGIOutputDuplication,
    staging: Option<ID3D11Texture2D>,
    width: u32,
    height: u32,
    com_owned: bool,
}

impl DxgiDuplicator {
    pub fn open_primary() -> Result<Self, String> {
        Self::open_primary_inner()
    }

    fn open_primary_inner() -> Result<Self, String> {
        unsafe {
            let com_owned = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
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

            let mut primary: Option<IDXGIOutput1> = None;
            for i in 0..8u32 {
                let Ok(out) = adapter.EnumOutputs(i) else { break };
                let desc: DXGI_OUTPUT_DESC =
                    out.GetDesc().map_err(|e| format!("Output Desc：{e}"))?;
                let rc: RECT = desc.DesktopCoordinates;
                if rc.left == 0 && rc.top == 0 {
                    primary = Some(out.cast().map_err(|e| format!("Output1：{e}"))?);
                    break;
                }
            }
            let out1 = primary.ok_or("找不到主显示器输出")?;
            let desc = out1.GetDesc().map_err(|e| format!("主屏 Desc：{e}"))?;
            let rc = desc.DesktopCoordinates;
            let width = (rc.right - rc.left).max(1) as u32;
            let height = (rc.bottom - rc.top).max(1) as u32;

            let dup = out1
                .DuplicateOutput(&device)
                .map_err(|e| format!("DuplicateOutput：{e}"))?;

            Ok(Self {
                device,
                ctx,
                dup,
                staging: None,
                width,
                height,
                com_owned,
            })
        }
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn acquire_bgra(&mut self) -> Result<Option<Vec<u8>>, String> {
        use windows::Win32::Graphics::Dxgi::DXGI_OUTDUPL_FRAME_INFO;
        unsafe {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut res: Option<IDXGIResource> = None;
            match self.dup.AcquireNextFrame(50, &mut info, &mut res) {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(None),
                Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST => {
                    return Err("DXGI 访问丢失".into());
                }
                Err(e) => return Err(format!("AcquireNextFrame：{e}")),
            }
            let Some(res) = res else {
                let _ = self.dup.ReleaseFrame();
                return Ok(None);
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
                self.device
                    .CreateTexture2D(&sd, None, Some(&mut st))
                    .map_err(|e| format!("staging：{e}"))?;
                self.staging = Some(st.ok_or("staging 创建为空")?);
                self.width = desc.Width;
                self.height = desc.Height;
            }
            let staging = self.staging.clone().ok_or("staging 缺失")?;
            self.ctx.CopyResource(&staging, &tex);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.ctx
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .map_err(|e| format!("Map：{e}"))?;
            let w = self.width as usize;
            let h = self.height as usize;
            let pitch = mapped.RowPitch as usize;
            let mut out = vec![0u8; w * h * 4];
            let src = mapped.pData as *const u8;
            if !src.is_null() {
                for y in 0..h {
                    std::ptr::copy_nonoverlapping(
                        src.add(y * pitch),
                        out.as_mut_ptr().add(y * w * 4),
                        w * 4,
                    );
                }
            }
            self.ctx.Unmap(&staging, 0);
            let _ = self.dup.ReleaseFrame();
            Ok(Some(out))
        }
    }
}

impl Drop for DxgiDuplicator {
    fn drop(&mut self) {
        if self.com_owned {
            unsafe { CoUninitialize() };
        }
    }
}

pub struct DxgiCapture {
    inner: Option<DxgiDuplicator>,
    disabled: bool,
}

// MTA COM；async 要求 Send。
unsafe impl Send for DxgiCapture {}
unsafe impl Send for DxgiDuplicator {}

impl DxgiCapture {
    pub fn new() -> Self {
        Self {
            inner: None,
            disabled: false,
        }
    }

    pub fn is_enabled(&self) -> bool {
        !self.disabled
    }

    /// Ok(None)=无新帧；Err=不可用（GDI 回退）。
    pub fn grab(&mut self) -> Result<Option<(u32, u32, Vec<u8>)>, String> {
        if self.disabled {
            return Err("DXGI 已禁用".into());
        }
        if self.inner.is_none() {
            match DxgiDuplicator::open_primary() {
                Ok(d) => self.inner = Some(d),
                Err(e) => {
                    self.disabled = true;
                    return Err(e);
                }
            }
        }
        let d = self.inner.as_mut().unwrap();
        match d.acquire_bgra() {
            Ok(Some(bgra)) => {
                let sz = d.size();
                Ok(Some((sz.0, sz.1, bgra)))
            }
            Ok(None) => Ok(None),
            Err(e) => {
                self.inner = None;
                if !e.contains("访问丢失") {
                    self.disabled = true;
                }
                Err(e)
            }
        }
    }
}

impl Default for DxgiCapture {
    fn default() -> Self {
        Self::new()
    }
}

pub fn bgra_to_rgba(bgra: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bgra.len());
    for p in bgra.chunks_exact(4) {
        out.extend_from_slice(&[p[2], p[1], p[0], 255]);
    }
    out
}

pub fn bgra_to_nv12(bgra: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
    let w = w as usize;
    let h = h as usize;
    if bgra.len() < w * h * 4 {
        return Err("BGRA 长度不足".into());
    }
    let y_size = w * h;
    let uv_w = w / 2;
    let uv_h = h / 2;
    let mut out = vec![0u8; y_size + uv_w * uv_h * 2];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            let b = bgra[i] as f32;
            let g = bgra[i + 1] as f32;
            let r = bgra[i + 2] as f32;
            let yv = (0.257 * r + 0.504 * g + 0.098 * b + 16.0).clamp(0.0, 255.0) as u8;
            out[y * w + x] = yv;
        }
    }
    for y in 0..uv_h {
        for x in 0..uv_w {
            let px = |dx: usize, dy: usize| {
                let i = ((y * 2 + dy) * w + (x * 2 + dx)) * 4;
                (bgra[i] as f32, bgra[i + 1] as f32, bgra[i + 2] as f32)
            };
            let samples = [px(0, 0), px(1, 0), px(0, 1), px(1, 1)];
            let (mut u, mut v) = (0f32, 0f32);
            for (b, g, r) in samples {
                u += -0.148 * r - 0.291 * g + 0.439 * b + 128.0;
                v += 0.439 * r - 0.368 * g - 0.071 * b + 128.0;
            }
            u = (u / 4.0).clamp(0.0, 255.0);
            v = (v / 4.0).clamp(0.0, 255.0);
            let uv = y_size + (y * uv_w + x) * 2;
            out[uv] = u as u8;
            out[uv + 1] = v as u8;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bgra_to_rgba_swaps() {
        let bgra = [10u8, 20, 30, 255];
        let rgba = bgra_to_rgba(&bgra);
        assert_eq!(&rgba[..], &[30, 20, 10, 255]);
    }

    #[test]
    fn nv12_len() {
        let bgra = vec![0u8; 4 * 4 * 4];
        let nv = bgra_to_nv12(&bgra, 4, 4).unwrap();
        assert_eq!(nv.len(), 4 * 4 + 4 * 4 / 2);
    }
}
