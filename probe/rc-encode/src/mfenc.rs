//! mfenc.rs — MF 硬编码器 QvS 旋钮 × 编码耗时矩阵探针（2026-09-24）。
//!
//! # 回答什么
//!
//! `encode_h264/mf.rs` 的低延迟三件套（MF_LOW_LATENCY / AVLowLatencyMode /
//! B帧=0 / RefFrame=1 / CBR+GOP1s+GIR）2026-09-19 起已在产品生效——
//! docs 里的「MF 基线 1440p 10.08ms / 1080p 7.15ms」就是**生效后**的数字。
//! 唯一刻意留白的旋钮是 `CODECAPI_AVEncCommonQualityVsSpeed`（mf.rs:255
//! 注释：等 enc 段实测再决定）。本探针把它补上：
//!
//! - QvS ∈ {默认, 0, 50, 100}（0=偏画质，100=偏速度）× 两种内容形态
//!   （screen=近似 UI / noise=高熵上界）× 两档分辨率；
//! - 输入用 **GPU NV12 纹理**（与产品 `encode_texture` 零拷贝路径同构：
//!   MFT 绑 D3D manager、sample 用 MFCreateDXGISurfaceBuffer 包装），
//!   计时只围 `submit_and_collect`（喂帧→出包），staging 上传不计入；
//! - async MFT 事件协议照 `mf.rs::submit_and_collect` 逐行镜像
//! （NeedInput→ProcessInput→HaveOutput→ProcessOutput，低延迟一进一出）。
//!
//! 口径提示：探针的「enc ms」= ProcessInput+事件等待+ProcessOutput 墙钟，
//! 与产品 [RC-PERF] 的 enc 段同口径（可直接对比 10.08/7.15 基线）。

use anyhow::Result;
use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::*;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::*;

pub fn run(args: &[String]) -> Result<()> {
    let get = |k: &str, d: u32| -> u32 {
        args.iter()
            .position(|a| a == k)
            .and_then(|i| args.get(i + 1))
            .and_then(|v| v.parse().ok())
            .unwrap_or(d)
    };
    let w = get("--w", 2560);
    let h = get("--h", 1440);
    let frames = get("--frames", 120);
    let fps = get("--fps", 60);
    let bitrate = get("--bitrate", 14_000_000);
    let cpu_mode = args.iter().any(|a| a == "--cpu");

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        MFStartup(MF_VERSION, MFSTARTUP_FULL)?;
    }

    println!("═══════════════════════════════════════════════════════════");
    println!(" MF QvS 旋钮 × 编码耗时矩阵（{w}x{h} @{fps}fps，{bitrate}bps，{frames} 帧/格）");
    println!("═══════════════════════════════════════════════════════════\n");

    // 内容形态 × QvS 两个维度都要跑；每个组合全新 MFT 实例（避免状态污染）。
    let qvs_list: Vec<Option<u32>> = vec![None, Some(0), Some(50), Some(100)];
    println!(
        "{:<10} {:<12} {:>8} {:>8} {:>8} {:>8} {:>9}",
        "QvS", "内容", "均值", "p50", "p95", "max", "KB/帧"
    );
    println!("{}", "-".repeat(72));

    println!(
        "输入路径：{}（--cpu = 内存 NV12 样本，否则 D3D11 纹理零拷贝路径）
",
        if cpu_mode { "CPU 内存样本" } else { "GPU 纹理" }
    );
    for content in ["screen", "noise"] {
        for qvs in &qvs_list {
            match bench_one(w, h, fps, bitrate, frames, *qvs, content, cpu_mode) {
                Ok(st) => {
                    let q = qvs.map(|v| v.to_string()).unwrap_or_else(|| "默认".into());
                    println!(
                        "{:<10} {:<12} {:>7.2} {:>7.2} {:>7.2} {:>7.2} {:>8.1}",
                        q, content, st.mean, st.p50, st.p95, st.max, st.kb_per_frame
                    );
                }
                Err(e) => {
                    let q = qvs.map(|v| v.to_string()).unwrap_or_else(|| "默认".into());
                    println!("{:<10} {:<12}  ✗ 失败：{}", q, content, e);
                }
            }
        }
    }

    println!("\n说明：QvS=0 偏画质 / 100 偏速度（CODECAPI_AVEncCommonQualityVsSpeed）。\n\
              与产品基线（mf.rs:159）同口径：1440p 10.08ms、1080p 7.15ms。");

    unsafe {
        MFShutdown();
        CoUninitialize();
    }
    Ok(())
}

struct Stats {
    mean: f64,
    p50: f64,
    p95: f64,
    max: f64,
    kb_per_frame: f64,
}

fn bench_one(
    w: u32,
    h: u32,
    fps: u32,
    bitrate: u32,
    frames: u32,
    qvs: Option<u32>,
    content: &str,
    cpu_mode: bool,
) -> Result<Stats, String> {
    unsafe {
        // ── 1. 枚举硬件 MFT，选 NVIDIA 优先（与本机主工程选型一致）──
        let factory: IDXGIFactory1 =
            CreateDXGIFactory1().map_err(|e| format!("factory：{e}"))?;
        let out_info = MFT_REGISTER_TYPE_INFO {
            guidMajorType: MFMediaType_Video,
            guidSubtype: MFVideoFormat_H264,
        };
        let mut count = 0u32;
        let mut acts: *mut Option<IMFActivate> = std::ptr::null_mut();
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE,
            None, // 🔴 不能带 NV12 输入约束（async MFT 设型前枚举为空，mft_pick ①）
            Some(&out_info),
            &mut acts,
            &mut count,
        )
        .map_err(|e| format!("MFTEnumEx：{e}"))?;
        if count == 0 || acts.is_null() {
            return Err("无硬件 H.264 MFT".into());
        }
        let slice = std::slice::from_raw_parts(acts, count as usize);
        // NVIDIA 优先（name 含 NVIDIA），否则按枚举序；读 LUID 供设备同卡绑定
        let mut chosen: Option<(IMFActivate, u64, String)> = None;
        println!("候选 MFT：");
        for a in slice.iter().flatten() {
            let name = friendly_name(a);
            let luid_raw = a.GetUINT64(&MFT_ENUM_ADAPTER_LUID);
            println!("  - {name}  LUID_attr={luid_raw:?}");
            let luid = luid_raw.unwrap_or(0);
            let is_nv = name.contains("NVIDIA");
            if is_nv {
                chosen = Some((a.clone(), luid, name));
                break;
            }
            if chosen.is_none() {
                chosen = Some((a.clone(), luid, name));
            }
        }
        // 适配器侧 LUID 对照
        for i in 0..6u32 {
            let Ok(ad) = factory.EnumAdapters1(i) else { break };
            let Ok(d) = ad.GetDesc1() else { continue };
            let al = ((d.AdapterLuid.HighPart as i64 as u64) << 32)
                | d.AdapterLuid.LowPart as u64;
            let n: String = d
                .Description
                .iter()
                .take_while(|c| **c != 0)
                .map(|c| char::from_u32(*c as u32).unwrap_or('?'))
                .collect();
            println!("  适配器 [{i}] {n}  LUID={al:#x}");
        }
        let (act, luid, name) = chosen.ok_or("无候选")?;
        let transform = act.ActivateObject::<IMFTransform>().map_err(|e| format!("激活：{e}"))?;

        // ── 2. D3D11 设备：必须与 MFT 同适配器。实测 MFT_ENUM_ADAPTER_LUID 属性
        // 不存在（MF_E_ATTRIBUTE_NOT_FOUND 0xC00D36E6），退回厂商名字→VendorId 匹配。
        let vendor_hint: u32 = if name.contains("NVIDIA") {
            0x10DE
        } else if name.contains("Intel") {
            0x8086
        } else if name.contains("AMD") || name.contains("Advanced Micro") {
            0x1002
        } else {
            0
        };
        let mut adapter: Option<IDXGIAdapter1> = None;
        for i in 0..6u32 {
            let Ok(ad) = factory.EnumAdapters1(i) else { break };
            let d = ad.GetDesc1().map_err(|e| format!("desc：{e}"))?;
            let matched = if vendor_hint != 0 {
                d.VendorId == vendor_hint && d.Flags & 0x2 == 0 // 硬件
            } else {
                i == 0
            };
            if matched {
                adapter = Some(ad);
                break;
            }
        }
        let adapter = adapter.ok_or("没有与 MFT 厂商匹配的适配器")?;
        let mut device = None;
        let mut ctx = None;
        D3D11CreateDevice(
            &adapter,
            D3D_DRIVER_TYPE_UNKNOWN, // 带适配器时必须 UNKNOWN（0）
            HMODULE::default(),
            D3D11_CREATE_DEVICE_FLAG(0),
            None,
            7,
            Some(&mut device),
            None,
            Some(&mut ctx),
        )
        .map_err(|e| format!("D3D11CreateDevice：{e}"))?;
        let device = device.ok_or("device 空")?;
        let ctx = ctx.ok_or("ctx 空")?;

        // ── 3. async 解锁 + D3D manager（先于设类型）──
        let attrs = transform.GetAttributes().map_err(|e| format!("attrs：{e}"))?;
        let is_async = attrs.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) != 0;
        let events = if is_async {
            attrs
                .SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)
                .map_err(|e| format!("unlock：{e}"))?;
            Some(transform.cast::<IMFMediaEventGenerator>().map_err(|e| format!("事件源：{e}"))?)
        } else {
            None
        };
        if !cpu_mode {
            let mut token = 0u32;
            let mut mgr: Option<IMFDXGIDeviceManager> = None;
            MFCreateDXGIDeviceManager(&mut token, &mut mgr).map_err(|e| format!("mgr：{e}"))?;
            let mgr = mgr.ok_or("mgr 空")?;
            mgr.ResetDevice(&device, token).map_err(|e| format!("ResetDevice：{e}"))?;
            let unk: windows::core::IUnknown = mgr.cast().map_err(|e| format!("cast：{e}"))?;
            transform
                .ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, unk.as_raw() as usize)
                .map_err(|e| format!("SET_D3D_MANAGER：{e}"))?;
        }

        // ── 4. 类型协商：先输出后输入（顺序反了 async MFT 全拒）──
        let out_type = pick_output_type(&transform, w, h, fps, bitrate)?;
        transform
            .SetOutputType(0, &out_type, 0)
            .map_err(|e| format!("SetOutputType：{e}"))?;
        let in_type = create_video_type(&MFVideoFormat_NV12, w, h, fps)?;
        transform
            .SetInputType(0, &in_type, 0)
            .map_err(|e| format!("SetInputType：{e}"))?;
        // 流变化再协商（NVIDIA 常见，mf.rs:175 同款）
        for _ in 0..2 {
            if let Ok(mt) = transform.GetOutputAvailableType(0, 0) {
                let _ = mt.SetUINT32(&MF_MT_AVG_BITRATE, bitrate);
                let _ = mt.SetUINT64(&MF_MT_FRAME_RATE, pack_ratio(fps.max(1), 1));
                if transform.SetOutputType(0, &mt, 0).is_ok() {
                    break;
                }
            } else {
                break;
            }
        }

        // ── 5. ICodecAPI：产品的低延迟全家桶（逐字镜像）+ 本探针的变量 QvS ──
        let codec_api: Option<ICodecAPI> = transform.cast::<ICodecAPI>().ok();
        if let Some(api) = &codec_api {
            if let Ok(a2) = transform.cast::<IMFAttributes>() {
                let _ = a2.SetUINT32(&MF_LOW_LATENCY, 1);
            }
            set_u32(api, &CODECAPI_AVLowLatencyMode, 1);
            set_u32(api, &CODECAPI_AVEncCommonRateControlMode, 1); // CBR
            set_u32(api, &CODECAPI_AVEncCommonMeanBitRate, bitrate);
            set_u32(api, &CODECAPI_AVEncMPVGOPSize, fps.max(1));
            set_u32(api, &CODECAPI_AVEncVideoGradualIntraRefresh, fps.max(1));
            set_u32(api, &CODECAPI_AVEncMPVDefaultBPictureCount, 0);
            set_u32(api, &CODECAPI_AVEncVideoMaxNumRefFrame, 1);
            if let Some(v) = qvs {
                set_u32(api, &CODECAPI_AVEncCommonQualityVsSpeed, v);
            }
        }

        transform
            .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
            .map_err(|e| format!("BEGIN_STREAMING：{e}"))?;
        transform
            .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
            .map_err(|e| format!("START_OF_STREAM：{e}"))?;

        // ── 6. GPU NV12 纹理 + staging（上传不计入 enc 计时）──
        let (tex, staging) = create_nv12_textures(&device, w, h)?;
        let mut nv12 = alloc_nv12(w, h, content);

        let mut enc = Enc {
            transform: Some(transform.clone()),
            events: events.clone(),
            need_input: false,
            have_output: false,
            first_wait: true,
            w,
            h,
            fps,
            current_sample: None,
            t_need: 0.0,
            t_pin: 0.0,
            t_wait_out: 0.0,
            t_pout: 0.0,
        };

        // ── 7+8. 预热 3 帧 + 计时主循环（首帧带初始化，剔除）──
        let mut out_bytes = 0usize;
        let mut times: Vec<f64> = Vec::with_capacity(frames as usize);
        for i in 0..(frames + 3) as u64 {
            let timed = i >= 3;
            let sample = if cpu_mode {
                fill_nv12(&mut nv12, w, h, content, i);
                make_cpu_sample(&nv12, i, fps)?
            } else {
                fill_nv12(&mut nv12, w, h, content, i);
                upload_and_wrap(&ctx, &staging, &tex, &nv12, i, fps)?
            };
            enc.current_sample = Some(sample);
            let t0 = std::time::Instant::now();
            enc.submit_and_collect(&mut out_bytes)?;
            if timed {
                times.push(t0.elapsed().as_secs_f64() * 1000.0);
            }
        }

        // ── 9. 分段占比 ──
        let nf = frames as f64;
        println!(
            "    分段/帧：等NeedInput {:.2} + ProcessInput {:.2} + 等HaveOutput {:.2} + ProcessOutput {:.2}",
            enc.t_need / nf,
            enc.t_pin / nf,
            enc.t_wait_out / nf,
            enc.t_pout / nf
        );

        // ── 10. 收尾 ──
        if let Some(t) = enc.transform.as_ref() {
            let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
        }
        let _ = act.ShutdownObject();

        // 小样本时打印逐帧分布（验证「开流突刺 vs 稳态」口径）
        if frames <= 40 {
            let labeled: Vec<String> = times
                .iter()
                .enumerate()
                .map(|(i, t)| format!("f{}={:.1}", i + 3, t))
                .collect();
            println!("    逐帧：{}", labeled.join(" "));
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let n = times.len() as f64;
        let pick = |p: f64| times[((n * p) as usize).min(times.len() - 1)];
        Ok(Stats {
            mean: times.iter().sum::<f64>() / n,
            p50: pick(0.5),
            p95: pick(0.95),
            max: *times.last().unwrap(),
            kb_per_frame: out_bytes as f64 / frames as f64 / 1024.0,
        })
    }
}

// ─────────────────────────── async MFT 事件泵（镜像 mf.rs） ───────────────────────────

struct Enc {
    transform: Option<IMFTransform>,
    events: Option<IMFMediaEventGenerator>,
    need_input: bool,
    have_output: bool,
    first_wait: bool,
    w: u32,
    h: u32,
    fps: u32,
    /// 已包装好、等 NeedInput 后喂入的样本（upload 阶段先造好放这儿）。
    current_sample: Option<IMFSample>,
    /// 分段耗时累计（ms）：等 NeedInput / ProcessInput / 等 HaveOutput / ProcessOutput
    pub t_need: f64,
    pub t_pin: f64,
    pub t_wait_out: f64,
    pub t_pout: f64,
}

impl Enc {
    /// 喂一帧 + 收产出。低延迟模式一进一出（mf.rs:362 同款）。
    fn submit_and_collect(&mut self, out_bytes: &mut usize) -> Result<(), String> {
        unsafe {
            let wait_ms = if self.first_wait { 2000 } else { 300 };
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(wait_ms);
            if self.events.is_none() {
                return Err("同步 MFT 路径未实现（本机硬件 MFT 应为 async）".into());
            }
            let events = self.events.clone().unwrap();
            let a = std::time::Instant::now();
            while !self.need_input {
                self.pump_one(&events, deadline)?;
            }
            self.t_need += a.elapsed().as_secs_f64() * 1000.0;
            self.need_input = false;
            let sample = self.current_sample.take().ok_or("无待喂样本")?;
            let b = std::time::Instant::now();
            self.transform
                .as_ref()
                .ok_or("编码器已释放")?
                .ProcessInput(0, &sample, 0)
                .map_err(|e| format!("ProcessInput：{e}"))?;
            self.t_pin += b.elapsed().as_secs_f64() * 1000.0;
            let mut collected = 0usize;
            loop {
                let c = std::time::Instant::now();
                let pumped = self.pump_one(&events, deadline)?;
                if !self.have_output {
                    self.t_wait_out += c.elapsed().as_secs_f64() * 1000.0;
                } else {
                    self.t_wait_out += c.elapsed().as_secs_f64() * 1000.0;
                    self.have_output = false;
                    let d = std::time::Instant::now();
                    *out_bytes += self.drain_once()?;
                    self.t_pout += d.elapsed().as_secs_f64() * 1000.0;
                    collected += 1;
                }
                if collected >= 4 || (collected > 0 && !pumped) {
                    break;
                }
            }
            if collected == 0 {
                return Err("一帧未出（低延迟模式异常）".into());
            }
            self.first_wait = false;
            Ok(())
        }
    }

    fn pump_one(
        &mut self,
        events: &IMFMediaEventGenerator,
        deadline: std::time::Instant,
    ) -> Result<bool, String> {
        unsafe {
            match events.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                Ok(ev) => self.on_event(ev).map(|_| true),
                Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => {
                    if std::time::Instant::now() >= deadline {
                        return Err("等待编码器事件超时".into());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(1));
                    Ok(false)
                }
                Err(e) => Err(format!("事件泵：{e}")),
            }
        }
    }

    fn on_event(&mut self, ev: IMFMediaEvent) -> Result<(), String> {
        let t = unsafe { ev.GetType() }.unwrap_or(0);
        if t == MEError.0 as u32 {
            return Err("编码器错误事件".into());
        }
        if t == METransformNeedInput.0 as u32 {
            self.need_input = true;
        }
        if t == METransformHaveOutput.0 as u32 {
            self.have_output = true;
        }
        Ok(())
    }

    fn drain_once(&mut self) -> Result<usize, String> {
        unsafe {
            let od = MFT_OUTPUT_DATA_BUFFER {
                dwStreamID: 0,
                ..Default::default()
            };
            let mut status = 0u32;
            let mut outs = [od];
            let t = self.transform.as_ref().ok_or("编码器已释放")?;
            match t.ProcessOutput(0, &mut outs, &mut status) {
                Ok(()) => {}
                Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(0),
                Err(e) => return Err(format!("ProcessOutput：{e}")),
            }
            let mut n = 0usize;
            if let Some(sample) = outs[0].pSample.as_ref() {
                if let Ok(buf) = sample.ConvertToContiguousBuffer() {
                    n = buf.GetCurrentLength().unwrap_or(0) as usize;
                }
            }
            Ok(n)
        }
    }
}

// ─────────────────────────── GPU 纹理 / NV12 填充 ───────────────────────────

unsafe fn create_nv12_textures(
    device: &ID3D11Device,
    w: u32,
    h: u32,
) -> Result<(ID3D11Texture2D, ID3D11Texture2D), String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: 1,
        ArraySize: 1,
        Format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_NV12,
        SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET).0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut tex = None;
    device
        .CreateTexture2D(&desc, None, Some(&mut tex))
        .map_err(|e| format!("NV12 纹理：{e}"))?;
    let mut sdesc = desc;
    sdesc.Usage = D3D11_USAGE_STAGING;
    sdesc.BindFlags = 0;
    sdesc.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE.0 as u32;
    let mut staging = None;
    device
        .CreateTexture2D(&sdesc, None, Some(&mut staging))
        .map_err(|e| format!("staging：{e}"))?;
    Ok((tex.unwrap(), staging.unwrap()))
}

/// 填 staging 的 mapped 内存（逐行拷贝：NV12 两个 plane），上传 + CopyResource
/// 到 GPU 纹理后包装成 sample 返回（不计时；计时从调用方的 submit 开始）。
unsafe fn upload_and_wrap(
    ctx: &ID3D11DeviceContext,
    staging: &ID3D11Texture2D,
    tex: &ID3D11Texture2D,
    nv12: &[u8],
    idx: u64,
    fps: u32,
) -> Result<IMFSample, String> {
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    ctx.Map(staging, 0, D3D11_MAP_WRITE, 0, Some(&mut mapped))
        .map_err(|e| format!("Map：{e}"))?;
    let pitch = mapped.RowPitch as usize;
    let mut tdesc = Default::default();
    tex.GetDesc(&mut tdesc);
    let h = tdesc.Height as usize;
    let w = tdesc.Width as usize;
    let y_size = pitch * h;
    let base = mapped.pData as *mut u8;
    // Y plane
    for row in 0..h {
        let src = &nv12[row * w..row * w + w];
        let dst = std::slice::from_raw_parts_mut(base.add(row * pitch), w);
        dst.copy_from_slice(src);
    }
    // UV plane（Y 之后，行距同 pitch，每行 w/2 个 UV 对）
    let uv_rows = h / 2;
    for row in 0..uv_rows {
        let src_off = w * h + row * (w / 2) * 2;
        let src = &nv12[src_off..src_off + (w / 2) * 2];
        let dst = std::slice::from_raw_parts_mut(
            base.add(y_size + row * pitch),
            (w / 2) * 2,
        );
        dst.copy_from_slice(src);
    }
    ctx.Unmap(staging, 0);
    ctx.CopyResource(tex, staging);
    // 包装成 sample（mft_pick.rs::make_dxgi_sample 同款）
    let iid = <ID3D11Texture2D as Interface>::IID;
    let buf = MFCreateDXGISurfaceBuffer(&iid, tex, 0, false).map_err(|e| format!("surface buf：{e}"))?;
    let sample = MFCreateSample().map_err(|e| format!("sample：{e}"))?;
    sample.AddBuffer(&buf).map_err(|e| format!("AddBuffer：{e}"))?;
    let time = (idx * 10_000_000u64) / fps.max(1) as u64;
    sample.SetSampleTime(time as i64).map_err(|e| format!("time：{e}"))?;
    sample
        .SetSampleDuration((10_000_000u64 / fps.max(1) as u64) as i64)
        .map_err(|e| format!("dur：{e}"))?;
    Ok(sample)
}

/// screen：大片平坦灰底 + 移动矩形 + 渐变（近似 UI，编码器友好）；
/// noise：伪随机逐像素（高熵上界）。
fn alloc_nv12(w: u32, h: u32, content: &str) -> Vec<u8> {
    vec![128u8; (w * h + w * h / 2) as usize]
}

fn fill_nv12(buf: &mut [u8], w: u32, h: u32, content: &str, idx: u64) {
    let w = w as usize;
    let h = h as usize;
    if content == "noise" {
        let seed = idx.wrapping_mul(2654435761);
        for y in 0..h {
            for x in 0..w {
                buf[y * w + x] = (x.wrapping_mul(7).wrapping_add(y.wrapping_mul(13).wrapping_add(seed as usize)) % 256) as u8;
            }
        }
        for i in 0..w * h / 4 {
            buf[w * h + i * 2] = (i.wrapping_mul(31).wrapping_add(seed as usize) % 256) as u8;
            buf[w * h + i * 2 + 1] = (i.wrapping_mul(17).wrapping_add(seed as usize) % 256) as u8;
        }
    } else {
        // screen：灰底 + 移动亮块 + 顶部渐变条（每帧位移 → 有运动量）
        for y in 0..h {
            let base = (100 + (y / 16) * 6).min(160) as u8;
            for x in 0..w {
                buf[y * w + x] = base;
            }
        }
        let bx = (idx as usize * 17) % (w - 400).max(1);
        let by = (idx as usize * 11) % (h - 300).max(1);
        for y in by..by + 300 {
            for x in bx..bx + 400 {
                buf[y * w + x] = 235;
            }
        }
        // UV：灰色偏移 + 亮块区域染成蓝色块（有 UV 运动量）
        let uv = &mut buf[w * h..];
        for r in 0..h / 2 {
            for c in 0..w / 2 {
                uv[r * w + c * 2] = 128; // U
                uv[r * w + c * 2 + 1] = 128; // V
            }
        }
        let ubx = bx / 2;
        let uby = by / 2;
        for r in uby..uby + 150 {
            for c in ubx..ubx + 200 {
                uv[r * w + c * 2] = 240; // U→蓝
                uv[r * w + c * 2 + 1] = 110;
            }
        }
    }
}

/// CPU 内存 NV12 样本（mft_pick.rs::make_sample 同款）。
unsafe fn make_cpu_sample(nv12: &[u8], idx: u64, fps: u32) -> Result<IMFSample, String> {
    let len = nv12.len();
    let buf = MFCreateMemoryBuffer(len as u32).map_err(|e| format!("mem buf：{e}"))?;
    {
        let mut data: *mut u8 = std::ptr::null_mut();
        let mut max = 0u32;
        let mut cur = 0u32;
        buf.Lock(&mut data, Some(&mut max), Some(&mut cur))
            .map_err(|e| format!("Lock：{e}"))?;
        if !data.is_null() {
            std::ptr::copy_nonoverlapping(nv12.as_ptr(), data, len);
        }
        buf.SetCurrentLength(len as u32).map_err(|e| format!("len：{e}"))?;
        buf.Unlock().map_err(|e| format!("Unlock：{e}"))?;
    }
    let sample = MFCreateSample().map_err(|e| format!("sample：{e}"))?;
    sample.AddBuffer(&buf).map_err(|e| format!("AddBuffer：{e}"))?;
    let time = (idx * 10_000_000u64) / fps.max(1) as u64;
    sample.SetSampleTime(time as i64).map_err(|e| format!("time：{e}"))?;
    sample
        .SetSampleDuration((10_000_000u64 / fps.max(1) as u64) as i64)
        .map_err(|e| format!("dur：{e}"))?;
    Ok(sample)
}

// ─────────────────────────── 类型协商 / ICodecAPI 工具 ───────────────────────────

unsafe fn pick_output_type(
    t: &IMFTransform,
    w: u32,
    h: u32,
    fps: u32,
    bitrate: u32,
) -> Result<IMFMediaType, String> {
    let mut base = None;
    for i in 0..16u32 {
        let Ok(mt) = t.GetOutputAvailableType(0, i) else {
            break;
        };
        if mt.GetGUID(&MF_MT_SUBTYPE).map(|g| g == MFVideoFormat_H264).unwrap_or(false) {
            base = Some(mt);
            break;
        }
    }
    let mt = base.ok_or("无 H264 输出类型")?;
    mt.SetUINT64(&MF_MT_FRAME_SIZE, pack_u32x2(w, h))
        .map_err(|e| format!("frame_size：{e}"))?;
    let _ = mt.SetUINT64(&MF_MT_FRAME_RATE, pack_ratio(fps.max(1), 1));
    let _ = mt.SetUINT32(&MF_MT_AVG_BITRATE, bitrate);
    let _ = mt.SetUINT32(&MF_MT_INTERLACE_MODE, 2);
    Ok(mt)
}

unsafe fn create_video_type(
    subtype: &windows::core::GUID,
    w: u32,
    h: u32,
    fps: u32,
) -> Result<IMFMediaType, String> {
    let t = MFCreateMediaType().map_err(|e| format!("media type：{e}"))?;
    t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| format!("major：{e}"))?;
    t.SetGUID(&MF_MT_SUBTYPE, subtype).map_err(|e| format!("subtype：{e}"))?;
    t.SetUINT32(&MF_MT_INTERLACE_MODE, 2).map_err(|e| format!("interlace：{e}"))?;
    t.SetUINT64(&MF_MT_FRAME_SIZE, pack_u32x2(w, h)).map_err(|e| format!("size：{e}"))?;
    t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_u32x2(1, 1)).map_err(|e| format!("par：{e}"))?;
    t.SetUINT64(&MF_MT_FRAME_RATE, pack_ratio(fps.max(1), 1)).map_err(|e| format!("rate：{e}"))?;
    Ok(t)
}

fn pack_u32x2(a: u32, b: u32) -> u64 {
    ((a as u64) << 32) | b as u64
}

fn pack_ratio(n: u32, d: u32) -> u64 {
    pack_u32x2(n, d)
}

unsafe fn set_u32(api: &ICodecAPI, key: &windows::core::GUID, value: u32) {
    let v = windows::core::VARIANT::from(value);
    if let Err(e) = api.SetValue(key, &v) {
        println!("    （CODECAPI {key:?}={value} 不支持：{e}）");
    }
}

fn friendly_name(act: &IMFActivate) -> String {
    unsafe {
        let mut buf = [0u16; 256];
        let mut len = 0u32;
        act.GetString(&MFT_FRIENDLY_NAME_Attribute, &mut buf, Some(&mut len))
            .map(|_| {
                String::from_utf16_lossy(&buf[..(len as usize).min(buf.len()).saturating_sub(1)])
            })
            .unwrap_or_else(|_| "(无名)".into())
    }
}
