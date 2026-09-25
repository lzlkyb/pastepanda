//! dup.rs — DXGI Duplication 采集段计时探针（2026-09-24）。
//!
//! # 回答什么
//!
//! 「确认采集方式与耗时」：主工程 `rc/dxgi.rs` 用的就是 DXGI Desktop
//! Duplication（DuplicateOutput + AcquireNextFrame）——方式本身健康（与
//! OBS / Parsec 同源）。本探针量化它的两个成本：
//!
//! 1. **AcquireNextFrame 等待**：新帧到达的等待时间（取决于屏幕变化频率——
//!    静止屏幕会等到超时，这是正常现象不是故障）；
//! 2. **AcquireNextFrame 本体 + 纹理引用获取**：拿到帧后开销（应为亚毫秒）。
//!
//! 产品 [RC-PERF] 的 cap 段与这里同源可对照。跑本探针时最好屏幕上有动画
//! （视频 / 窗口拖动），否则「等新帧」的时间会失真地大。

use anyhow::Result;
use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::*;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::System::Com::*;

pub fn run(_args: &[String]) -> Result<()> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    println!("═══════════════════════════════════════════════════════════");
    println!(" DXGI Duplication 采集计时（默认输出，AcquireNextFrame 循环 6s）");
    println!(" 提示：屏幕上放点动画（视频/拖动窗口），否则等待时长不代表采集慢");
    println!("═══════════════════════════════════════════════════════════\n");

    unsafe {
        // 设备（默认适配器，与产品 grab_gpu 同款 BCRA flush 语义略不同——探针只计时）
        let mut device = None;
        let mut ctx = None;
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_FLAG(0),
            None,
            7,
            Some(&mut device),
            None,
            Some(&mut ctx),
        )?;
        let device = device.unwrap();
        let ctx = ctx.unwrap();

        let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
        let adapter = factory.EnumAdapters1(0)?;
        let desc = adapter.GetDesc1()?;
        let name: String = desc
            .Description
            .iter()
            .take_while(|c| **c != 0)
            .map(|c| char::from_u32(*c as u32).unwrap_or('?'))
            .collect();
        println!("适配器 [0] {name}\n");

        let mut output: Option<IDXGIOutput> = None;
        let mut oi = 0u32;
        loop {
            match adapter.EnumOutputs(oi) {
                Ok(o) => {
                    // windows 0.58：GetDesc() 无出参，返回 Result<DXGI_OUTPUT_DESC>
                    match o.GetDesc() {
                        Ok(od) if od.AttachedToDesktop.as_bool() => {
                            output = Some(o);
                            break;
                        }
                        _ => oi += 1,
                    }
                }
                Err(_) => break,
            }
        }
        let output = output.ok_or_else(|| anyhow::anyhow!("无桌面输出"))?;
        let out_desc: DXGI_OUTPUT_DESC = output.GetDesc()?;
        println!(
            "输出：{}×{} @ 主桌面\n",
            (out_desc.DesktopCoordinates.right - out_desc.DesktopCoordinates.left).abs(),
            (out_desc.DesktopCoordinates.bottom - out_desc.DesktopCoordinates.top).abs()
        );
        // DuplicateOutput 是 IDXGIOutput1 的方法（0.58 里 IDXGIOutput 没有）
        let out1: IDXGIOutput1 = output.cast().map_err(|e| anyhow::anyhow!("cast：{e}"))?;

        let dup: IDXGIOutputDuplication = out1
            .DuplicateOutput(&device)
            .map_err(|e| anyhow::anyhow!("DuplicateOutput：{e}"))?;

        // 计时循环：6 秒
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
        let mut waits: Vec<f64> = Vec::new();
        let mut acquire_self: Vec<f64> = Vec::new();
        let mut timeouts = 0u32;
        let mut lost = false;
        while std::time::Instant::now() < deadline {
            let t0 = std::time::Instant::now();
            let mut info = Default::default();
            let mut res: Option<IDXGIResource> = None;
            match dup.AcquireNextFrame(100, &mut info, &mut res) {
                Ok(()) => {
                    let t1 = std::time::Instant::now();
                    waits.push(t0.elapsed().as_secs_f64() * 1000.0);
                    let _ = t1;
                    // 拿到帧后立刻释放（探针不读像素；产品 GPU 路径同样不读回）
                    let _ = dup.ReleaseFrame();
                    let t2 = std::time::Instant::now();
                    acquire_self.push((t2 - t1).as_secs_f64() * 1000.0);
                }
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                    timeouts += 1;
                }
                Err(e)
                    if e.code() == DXGI_ERROR_ACCESS_LOST
                        || e.code() == DXGI_ERROR_INVALID_CALL =>
                {
                    lost = true;
                    break;
                }
                Err(e) => {
                    eprintln!("AcquireNextFrame：{e}");
                    break;
                }
            }
        }

        waits.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let n = waits.len();
        println!("6s 内拿到新帧 {n} 次，超时 {timeouts} 次，access_lost={lost}");
        if n > 0 {
            let mean = waits.iter().sum::<f64>() / n as f64;
            let p95 = waits[(n as f64 * 0.95) as usize % n];
            let max = waits[n - 1];
            let self_mean = acquire_self.iter().sum::<f64>() / acquire_self.len() as f64;
            println!("AcquireNextFrame 等待：均值 {mean:.2}ms / p95 {p95:.2}ms / max {max:.2}ms");
            println!("释放帧开销：均值 {self_mean:.3}ms");
            let fps = n as f64 / 6.0;
            println!("新帧率：{fps:.1} fps（屏幕变化频率，与刷新率/内容变化有关）");
        }
        println!("\n结论参照：产品 cap 段（[RC-PERF]）应与本均值同量级；");
        println!("若产品 cap 长期显著高于这里，问题在产品的帧循环而非 DXGI 本身。");
    }
    Ok(())
}
