//! 端到端验证：`WCA_EXCLUDED_FROM_DDA`（attrib 24）能否让 Desktop Duplication 抓不到窗口。
//!
//! # 为什么要它
//! 主产品用 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` 排除录屏控制条，但在
//! WebView2 窗口上稳定返回 `0x80070008`。降级通道 `WCA_EXCLUDED_FROM_DDA` 只对
//! Desktop Duplication 生效——正好是本产品的抓屏路径。但它是否真的让窗口从帧里消失，
//! 只能靠**真抓一帧看像素**来回答，不能靠文档推断。
//!
//! # 用法
//! ```text
//! cargo run --release --bin exclude -- --no-exclude   # 对照：窗口应被 DDA 抓到（红）
//! cargo run --release --bin exclude -- --exclude      # 实验：窗口应从帧里消失（非红）
//! ```
//! 两次用同一个窗口位置与同一个像素采样点，只有 WCA 一个变量。

use anyhow::{anyhow, Result};
use windows::core::{s, w, Interface};
use windows::Win32::Foundation::{BOOL, COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Direct3D::*;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows::Win32::UI::WindowsAndMessaging::*;

const WIN_X: i32 = 260;
const WIN_Y: i32 = 220;
const WIN_W: i32 = 420;
const WIN_H: i32 = 180;

const WCA_EXCLUDED_FROM_DDA: u32 = 24;

#[repr(C)]
struct Wcad {
    attrib: u32,
    pv_data: *mut core::ffi::c_void,
    cb_data: u32,
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let exclude = args.iter().any(|a| a == "--exclude");
    let label = if exclude { "exclude" } else { "no-exclude" };

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        // 多显示器下 DDA 抓的是输出 0；窗口放在主屏左上区域，保证在抓取范围内。
        let hwnd = create_red_window()?;
        let _ = ShowWindow(hwnd, SW_SHOWNORMAL);
        let _ = UpdateWindow(hwnd);
        std::thread::sleep(std::time::Duration::from_millis(600));

        if exclude {
            let mut on = BOOL(1);
            let mut data = Wcad {
                attrib: WCA_EXCLUDED_FROM_DDA,
                pv_data: (&raw mut on).cast(),
                cb_data: std::mem::size_of::<BOOL>() as u32,
            };
            let module = GetModuleHandleW(w!("user32.dll"))?;
            let address = GetProcAddress(module, s!("SetWindowCompositionAttribute"))
                .ok_or_else(|| anyhow!("无 SetWindowCompositionAttribute"))?;
            type Fn = unsafe extern "system" fn(HWND, *mut Wcad) -> BOOL;
            let apply: Fn = std::mem::transmute(address);
            let ok = apply(hwnd, &mut data).as_bool();
            println!("[{label}] SetWindowCompositionAttribute(24) = {ok}");
            std::thread::sleep(std::time::Duration::from_millis(600));
        }

        let rgb = grab_pixel(hwnd, WIN_X + WIN_W / 2, WIN_Y + WIN_H / 2)?;
        let (b, g, r) = (rgb & 0xFF, (rgb >> 8) & 0xFF, (rgb >> 16) & 0xFF);
        let captured = r > 180 && g < 90 && b < 90;
        println!("[{label}] DDA 帧中心像素 B={b} G={g} R={r} ⇒ 窗口{}", if captured { "被捕获（红）" } else { "已排除（非红）" });

        let _ = DestroyWindow(hwnd);
        if exclude {
            // 校验判据：加排除后必须**不再**是红色；对照跑必须**是**红色。
            if captured {
                return Err(anyhow!("❌ 失败：WCA 未能让窗口从 DDA 帧里消失"));
            }
            println!("✅ 通过：WCA_EXCLUDED_FROM_DDA 对 Desktop Duplication 生效");
        } else if !captured {
            return Err(anyhow!("❌ 对照失败：基线窗口本应被 DDA 抓到"));
        } else {
            println!("✅ 对照通过：未设排除时窗口确实出现在 DDA 帧里");
        }
    }
    Ok(())
}

unsafe fn create_red_window() -> Result<HWND> {
    let module = GetModuleHandleW(None)?;
    let instance: HINSTANCE = module.into();
    let brush = CreateSolidBrush(COLORREF(0x0000FF)); // COLORREF 是 0x00BBGGRR ⇒ 纯红
    let class = WNDCLASSW {
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(window_proc),
        hInstance: instance,
        hbrBackground: brush,
        lpszClassName: w!("PPExcludeProbe"),
        ..Default::default()
    };
    if RegisterClassW(&class) == 0 {
        return Err(anyhow!("RegisterClassW 失败：{:?}", windows::core::Error::from_win32()));
    }
    let hwnd = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        w!("PPExcludeProbe"),
        w!("probe"),
        WS_POPUP | WS_VISIBLE,
        WIN_X,
        WIN_Y,
        WIN_W,
        WIN_H,
        None,
        None,
        instance,
        None,
    )?;
    Ok(hwnd)
}

unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    DefWindowProcW(hwnd, msg, wp, lp)
}

/// 抓一帧并读指定物理像素（BGRA8 小端 ⇒ u32 = A<<24|R<<16|G<<8|B）。
unsafe fn grab_pixel(_hwnd: HWND, x: i32, y: i32) -> Result<u32> {
    let mut device = None;
    let mut ctx = None;
    D3D11CreateDevice(
        None,
        D3D_DRIVER_TYPE_HARDWARE,
        HINSTANCE::default(),
        D3D11_CREATE_DEVICE_FLAG(0),
        None,
        7,
        Some(&mut device),
        None,
        Some(&mut ctx),
    )?;
    let device = device.ok_or_else(|| anyhow!("无 D3D11 设备"))?;
    let ctx = ctx.ok_or_else(|| anyhow!("无 D3D11 上下文"))?;

    let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
    let adapter = factory.EnumAdapters1(0)?;
    let mut output: Option<IDXGIOutput> = None;
    for index in 0..8u32 {
        match adapter.EnumOutputs(index) {
            Ok(candidate) => {
                if candidate.GetDesc().map(|d| d.AttachedToDesktop.as_bool()).unwrap_or(false) {
                    output = Some(candidate);
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let output = output.ok_or_else(|| anyhow!("无桌面输出"))?;
    let out_desc = output.GetDesc()?;
    println!(
        "  DDA 输出：{:#?} 桌面坐标 {}..{} × {}..{}",
        out_desc.DeviceName,
        out_desc.DesktopCoordinates.left,
        out_desc.DesktopCoordinates.right,
        out_desc.DesktopCoordinates.top,
        out_desc.DesktopCoordinates.bottom
    );
    let out1: IDXGIOutput1 = output.cast()?;
    let dup: IDXGIOutputDuplication = out1.DuplicateOutput(&device)?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut tick = 0i32;
    loop {
        if std::time::Instant::now() > deadline {
            return Err(anyhow!("5s 内没等到新帧"));
        }
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut res: Option<IDXGIResource> = None;
        match dup.AcquireNextFrame(400, &mut info, &mut res) {
            Ok(()) => {
                // 🔴 LastPresentTime == 0 ⇒ 空帧：桌面这段没有真实更新，此时 surface 内容未定义
                //（实测整帧全黑）。必须跳过并制造一次变化，否则读到的「全黑」会被误读成「排除生效」。
                if info.LastPresentTime == 0 {
                    let _ = dup.ReleaseFrame();
                    tick = (tick + 1) % 16;
                    let _ = SetWindowPos(
                        _hwnd,
                        None,
                        WIN_X + tick,
                        WIN_Y,
                        0,
                        0,
                        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                    );
                    continue;
                }
                let texture: ID3D11Texture2D = res.unwrap().cast()?;
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                texture.GetDesc(&mut desc);
                println!(
                    "  帧：{}×{} format={:?} dirty={:?}",
                    desc.Width, desc.Height, desc.Format, info.TotalMetadataBufferSize
                );
                if x < 0 || y < 0 || x >= desc.Width as i32 || y >= desc.Height as i32 {
                    let _ = dup.ReleaseFrame();
                    return Err(anyhow!("采样点 ({x},{y}) 超出帧范围 {}×{}", desc.Width, desc.Height));
                }
                desc.Usage = D3D11_USAGE_STAGING;
                desc.BindFlags = 0;
                desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                desc.MiscFlags = 0;
                let mut staging: Option<ID3D11Texture2D> = None;
                device.CreateTexture2D(&desc, None, Some(&mut staging))?;
                let staging = staging.unwrap();
                ctx.CopyResource(&staging, &texture);
                ctx.Flush();
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                ctx.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
                // 整帧统计：全黑说明抓取/读回本身有问题，而不是采样点选错。
                let mut sum = 0u64;
                let mut peak = 0u32;
                let mut samples = 0u64;
                for row_index in (0..desc.Height as usize).step_by(16) {
                    let line = (mapped.pData as *const u8).add(row_index * mapped.RowPitch as usize);
                    for column in (0..desc.Width as usize).step_by(16) {
                        let value = *(line.add(column * 4) as *const u32);
                        sum += u64::from(value & 0xFF) + u64::from((value >> 8) & 0xFF) + u64::from((value >> 16) & 0xFF);
                        peak = peak.max(value);
                        samples += 1;
                    }
                }
                println!(
                    "  整帧采样 {samples} 点 · 平均通道值 {:.1} · peak=0x{peak:08X}",
                    sum as f64 / (samples.max(1) as f64 * 3.0)
                );
                let row = (mapped.pData as *const u8).add(y as usize * mapped.RowPitch as usize);
                let pixel = *(row.add(x as usize * 4) as *const u32);
                ctx.Unmap(&staging, 0);
                let _ = dup.ReleaseFrame();
                return Ok(pixel);
            }
            Err(error) if error.code() == DXGI_ERROR_WAIT_TIMEOUT => continue,
            Err(error) => return Err(anyhow!("AcquireNextFrame：{error}")),
        }
    }
}
