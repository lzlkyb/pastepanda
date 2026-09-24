//! JPEG 兜底路径的编码器：改用 Windows 自带的 **WIC**（`windowscodecs.dll`）。
//!
//! # 为什么换（2026-09-24 实测）
//!
//! 原实现走 `image` crate 的 `JpegEncoder` —— **纯 Rust、无 SIMD**。同一张
//! 2560x1440 高熵图（`probe/rc-encode` 探针，逐像素相同的输入）：
//!
//! | 编码器 | 耗时 | 上限 |
//! |---|---|---|
//! | `image` crate（原实现） | **196.78 ms/帧** | 5.1 fps |
//! | WIC（本模块） | **20.9 ms/帧** | 47.8 fps |
//! | libjpeg-turbo | 14.5 ms/帧 | 68.9 fps |
//!
//! 而真机「JPEG 兜底整圈 190ms/帧」与纯编码 196.78ms 几乎相等 ⇒ 瓶颈**几乎全是编码**，
//! 采集 + RGBA→RGB 转换 + 脏块检测占比很小。换成 WIC 即 9.4 倍，且：
//! 系统自带（**零新增体积**）、无第三方许可问题、只差一个 `windows` feature。
//!
//! ⚠️ 换编码器**不解决**「硬编激活恒失败 `0x8000FFFF`」——那是混合显卡拓扑问题，
//! 与编码器实现无关。本模块只治「兜底路径卡」这一件事。
//!
//! # 🔴 WIC 的 JPEG encoder 只认 `24bppBGR`，而且会静默改写你的请求
//!
//! `IWICBitmapFrameEncode::SetPixelFormat` 是 **in/out**：传进去你想要的，回写实际接受的。
//! 实测四种请求的回值全是 `24bppBGR`：
//!
//! ```text
//! 请求 24bppBGR → 实际 24bppBGR  ✓
//! 请求 24bppRGB → 实际 24bppBGR  ✗   ← 不报错
//! 请求 32bppBGRA / 32bppRGBA → 实际 24bppBGR  ✗
//! ```
//!
//! 若照 `24bppRGB` 组织数据（R 在前），WIC 会按 BGR 解释 ⇒ **整幅画面红蓝颠倒**，
//! 而编码成功、文件大小正常、日志无异常。所以本模块做两件事：
//! ① 调用后**校验回写值**，不是 BGR 就报错（防御未来系统行为变化）；
//! ② 自己完成 RGB→BGR 交换（实测 2560x1440 仅 **2.3ms**，不值得为省它引入
//!   `IWICFormatConverter` 那趟额外内部拷贝）。
//!
//! 通道正确性用「三色条 + 读回」验证过（左红/中绿/右蓝，产物逐区采样值符合）。

/// 把 RGB8 缓冲编成 JPEG 字节。`rgb` 长度须 ≥ `w * h * 3`（超出部分忽略）。
pub fn encode_jpeg(rgb: &[u8], w: u32, h: u32, quality: u8) -> Result<Vec<u8>, String> {
    #[cfg(target_os = "windows")]
    {
        win::encode_jpeg(rgb, w, h, quality)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (rgb, w, h, quality);
        Err("远程画面编码目前仅支持 Windows".into())
    }
}

#[cfg(target_os = "windows")]
mod win {
    use windows::core::{GUID, HSTRING, PWSTR, VARIANT};
    use windows::Win32::Foundation::{HGLOBAL, BOOL};
    use windows::Win32::Graphics::Imaging::*;
    // CreateStreamOnHGlobal 在 StructuredStorage 子模块，不在 Com 根上。
    use windows::Win32::System::Com::StructuredStorage::{
        CreateStreamOnHGlobal, IPropertyBag2, PROPBAG2,
    };
    use windows::Win32::System::Com::*;
    use windows::Win32::System::Variant::{VARENUM, VT_R4, VT_UI1};

    use super::super::mft_diag::ensure_mta_quiet;

    /// `ensure_mta_quiet` 返回 true 表示本线程由我们取得 COM 引用，收尾要配对释放。
    /// 与 `encode_h264` 同款做法：**成功与失败路径都要释放**，所以绑到 Drop 上。
    struct ComGuard(bool);
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }

    pub(super) fn encode_jpeg(rgb: &[u8], w: u32, h: u32, quality: u8) -> Result<Vec<u8>, String> {
        if w == 0 || h == 0 {
            return Err("空画面".into());
        }
        let need = (w as usize) * (h as usize) * 3;
        if rgb.len() < need {
            return Err(format!("像素缓冲不足：{} < {need}", rgb.len()));
        }

        // RGB → BGR。WIC 只认 BGR（见模块头注释），且实测这趟只要 ~2.3ms/2560宽帧。
        let mut bgr = rgb[..need].to_vec();
        for px in bgr.chunks_exact_mut(3) {
            px.swap(0, 2);
        }

        let guard = ComGuard(ensure_mta_quiet("wic-jpeg"));
        let out = unsafe { encode_bgr_inner(&bgr, w, h, quality) };
        drop(guard);
        out
    }

    /// 质量档：本项目用 1~100 的 `u8`（`profile.q_default` 等），WIC 要 0.0~1.0 f32。
    ///
    /// 🔴 属性必须写在 `CreateNewFrame` 给的那个 bag 上、且**赶在 `Initialize` 之前**；
    /// 写晚了会被**静默忽略**（判据：产物大小不随质量变）。
    unsafe fn set_quality(props: &IPropertyBag2, quality: u8) -> windows::core::Result<()> {
        let name = HSTRING::from("ImageQuality");
        let pb = PROPBAG2 {
            pstrName: PWSTR(name.as_ptr() as *mut u16),
            vt: VARENUM(VT_R4.0),
            ..Default::default()
        };
        let q = (quality as f32 / 100.0).clamp(0.0, 1.0);
        props.Write(1, &pb, &VARIANT::from(q))
    }

    /// 色度抽样：**必须显式设成 4:2:2**，否则画质会悄悄退化。
    ///
    /// WIC 的默认是 **4:2:0**（实测 SOF 采样因子 `Y=2x2`），而被替换掉的
    /// `image` crate JpegEncoder **写死 4:2:2**——`screenshot.rs` 里那句
    /// 「屏幕文字边缘发虚并带彩色镶边」的用户反馈，正是 4:2:2 都还嫌不够、
    /// 最终让截图路径改用 PNG 的原因。此处降级到 4:2:0 等于**拿画质换速度**，
    /// 而 WIC 提供了 `JpegYCrCbSubsampling` 属性可以精确指定。
    ///
    /// 实测（512x512，`probe/rc-encode --formats` 的【E】段）：420 = 72.4 KB /
    /// 422 = 91.2 KB / 444 = 121.0 KB，采样因子分别为 `Y=2x2 / 2x1 / 1x1`——
    /// 属性确实生效，不是被忽略。代价是 422 比 420 略慢（色度数据多一倍），
    /// 但相对原来的 196.78 ms 仍是数量级的改善，画质对齐优先。
    unsafe fn set_subsampling(props: &IPropertyBag2) -> windows::core::Result<()> {
        let name = HSTRING::from("JpegYCrCbSubsampling");
        let pb = PROPBAG2 {
            pstrName: PWSTR(name.as_ptr() as *mut u16),
            // 文档类型是 VT_UI1（1 字节枚举），不是 VT_I4。
            vt: VARENUM(VT_UI1.0),
            ..Default::default()
        };
        let v = WICJpegYCrCbSubsampling422.0 as u8;
        props.Write(1, &pb, &VARIANT::from(v))
    }

    unsafe fn encode_bgr_inner(
        bgr: &[u8],
        w: u32,
        h: u32,
        quality: u8,
    ) -> Result<Vec<u8>, String> {
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("创建 WIC factory 失败：{e}"))?;

        // 输出走 `CreateStreamOnHGlobal` 的内存 IStream。
        //
        // 🔴 刻意**不用** `IWICStream::InitializeFromMemory`：它的签名收 `&[u8]`（不可变
        // 切片，windows crate 的绑定如此），而 WIC 要往里写、我们还要读回来 —— 借不可变
        // 引用改内存 + 之后重读，是实打实的别名 UB。HGLOBAL 流没有这个问题。
        let stream: IStream = CreateStreamOnHGlobal(HGLOBAL::default(), BOOL(1))
            .map_err(|e| format!("创建内存流失败：{e}"))?;

        let encoder = factory
            .CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())
            .map_err(|e| format!("创建 JPEG 编码器失败：{e}"))?;
        encoder
            .Initialize(&stream, WICBitmapEncoderNoCache)
            .map_err(|e| format!("初始化编码器失败：{e}"))?;

        // ⚠️ CreateNewFrame 是 IWICBitmapEncoder 的方法，不在 factory 上。
        let mut frame_out: Option<IWICBitmapFrameEncode> = None;
        let mut props: Option<IPropertyBag2> = None;
        encoder
            .CreateNewFrame(&mut frame_out, &mut props)
            .map_err(|e| format!("创建编码帧失败：{e}"))?;
        let frame = frame_out.ok_or("CreateNewFrame 未返回帧")?;

        if let Some(p) = props.as_ref() {
            // 质量设不上不致命（退默认质量），但**不能静默**——记一条日志便于排查。
            if let Err(e) = set_quality(p, quality) {
                log::warn!("[RC] WIC 设置质量 {quality} 失败（改用默认）：{e}");
            }
            // 色度抽样反了就会静默降画质，所以失败要显式记（见 set_subsampling 注释）。
            if let Err(e) = set_subsampling(p) {
                log::warn!("[RC] WIC 设置 4:2:2 色度抽样失败（将退到默认 4:2:0，画质下降）：{e}");
            }
        }
        frame
            .Initialize(props.as_ref())
            .map_err(|e| format!("初始化编码帧失败：{e}"))?;
        frame.SetSize(w, h).map_err(|e| format!("设置帧尺寸失败：{e}"))?;

        // SetPixelFormat 的 in/out 语义：回写的是**实际接受**的格式，数据必须按它组织。
        let mut fmt = GUID_WICPixelFormat24bppBGR;
        frame
            .SetPixelFormat(&mut fmt)
            .map_err(|e| format!("设置像素格式失败：{e}"))?;
        if !guid_eq(&fmt, &GUID_WICPixelFormat24bppBGR) {
            // 真发生了就说明 WIC 行为变了，我们按 BGR 摆的数据会被误解成别的通道序
            //（典型后果：红蓝颠倒且不报错）。宁可编不出，也不静默出彩色错画面。
            return Err("WIC 未接受 24bppBGR，拒绝按未知格式写像素".into());
        }

        frame
            .WritePixels(h, w * 3, bgr)
            .map_err(|e| format!("写像素失败：{e}"))?;
        frame.Commit().map_err(|e| format!("提交帧失败：{e}"))?;
        encoder.Commit().map_err(|e| format!("提交编码器失败：{e}"))?;

        let mut stat = STATSTG::default();
        stream
            .Stat(&mut stat, STATFLAG_NONAME)
            .map_err(|e| format!("查询产出大小失败：{e}"))?;
        let len = stat.cbSize as usize;
        if len == 0 {
            return Err("WIC 编码产出为空".into());
        }
        stream
            .Seek(0, STREAM_SEEK_SET, None)
            .map_err(|e| format!("回绕内存流失败：{e}"))?;
        let mut out = vec![0u8; len];
        let mut read = 0u32;
        stream
            .Read(
                out.as_mut_ptr() as *mut core::ffi::c_void,
                len as u32,
                Some(&mut read),
            )
            // ⚠️ IStream::Read 返回的是裸 HRESULT（同接口的 Seek/Stat 返回 Result），
            // 不要照抄 sibling 的 `?` 写法。
            .ok()
            .map_err(|e| format!("读取产出失败：{e}"))?;
        out.truncate(read as usize);
        if out.len() != len {
            log::warn!("[RC] WIC 产出读取不完整：{} / {len}", out.len());
        }
        Ok(out)
    }

    fn guid_eq(a: &GUID, b: &GUID) -> bool {
        a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    /// 三色条：左红 / 中绿 / 右蓝（RGB 序，每像素 3 字节）。
    fn stripes_rgb(w: u32, h: u32) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 3) as usize);
        for _ in 0..h {
            for x in 0..w {
                let (r, g, b) = match x * 3 / w {
                    0 => (255u8, 0u8, 0u8),
                    1 => (0, 255, 0),
                    _ => (0, 0, 255),
                };
                v.extend_from_slice(&[r, g, b]);
            }
        }
        v
    }

    /// 🔴 这条钉的是「通道有没有被弄反」——最容易静默出错的一处。
    ///
    /// WIC 的 JPEG encoder **只接受 `24bppBGR`**，而 `SetPixelFormat` 会把
    /// `24bppRGB` 的请求**静默改写成** `24bppBGR`（不报错、不返回失败）。
    /// 若照 RGB 去组织数据，编码照样成功、文件大小正常，**只有画面红蓝颠倒**。
    /// 2026-09-24 用探针 + PIL 读回确认过这个行为（`probe/rc-encode --formats`）。
    #[test]
    fn 编码后红蓝不得颠倒() {
        let (w, h) = (96u32, 32u32);
        let jpg = encode_jpeg(&stripes_rgb(w, h), w, h, 90).expect("WIC 编码应成功");
        assert!(jpg.len() > 100, "产物只有 {} 字节，不像有效 JPEG", jpg.len());

        let img = image::load_from_memory_with_format(&jpg, image::ImageFormat::Jpeg)
            .expect("产物应能被解码")
            .to_rgb8();
        let px = |x: u32| *img.get_pixel(x, h / 2);
        let (l, m, r) = (px(w / 6), px(w / 2), px(w * 5 / 6));
        assert!(
            l[0] > 180 && l[1] < 80 && l[2] < 80,
            "左区应为红，实得 {l:?}（红蓝颠倒的典型症状就是这里变蓝）"
        );
        assert!(
            m[1] > 180 && m[0] < 80 && m[2] < 80,
            "中区应为绿，实得 {m:?}"
        );
        assert!(
            r[2] > 180 && r[0] < 80 && r[1] < 80,
            "右区应为蓝，实得 {r:?}"
        );
    }

    #[test]
    fn 空尺寸与缓冲不足要报错() {
        assert!(encode_jpeg(&[], 0, 16, 80).is_err(), "宽为 0");
        assert!(encode_jpeg(&[], 16, 0, 80).is_err(), "高为 0");
        assert!(
            encode_jpeg(&[0u8; 10], 4, 4, 80).is_err(),
            "4x4x3=48 字节，只给了 10"
        );
        // 多出来的尾巴应被忽略，而不是报错或串味
        assert!(
            encode_jpeg(&[128u8; 64], 4, 4, 80).is_ok(),
            "缓冲多出部分应被忽略"
        );
    }

    /// 质量参数写晚了会被 WIC **静默忽略**（不报错），产物大小是唯一的判据。
    #[test]
    fn 质量参数应真的影响产物大小() {
        let (w, h) = (128u32, 128u32);
        let mut noisy = Vec::with_capacity((w * h * 3) as usize);
        for i in 0..(w * h) {
            let v = ((i * 37) % 251) as u8;
            noisy.extend_from_slice(&[v, v.wrapping_add(97), v.wrapping_mul(3)]);
        }
        let low = encode_jpeg(&noisy, w, h, 30).expect("低质量编码");
        let high = encode_jpeg(&noisy, w, h, 95).expect("高质量编码");
        assert!(
            high.len() > low.len(),
            "质量 95 应比 30 大：{} vs {}",
            high.len(),
            low.len()
        );
    }

    /// 性能预览（默认忽略）：换 WIC 的实际收益，同时留一个回归锚点。
    ///
    /// 跑法（**要绝对值必须加 `--release`**，debug 会慢好几倍）：
    /// ```text
    /// cargo test --release --lib 性能预览 -- --ignored --nocapture
    /// ```
    ///
    /// 对照锚点（2026-09-24 `probe/rc-encode`，同一张 2560x1440 高熵图，release）：
    /// `image` crate 196.78 ms/帧 · WIC 编码 20.9 ms · 其中 RGB→BGR 约 2.3 ms。
    #[test]
    #[ignore = "性能预览，需要时手动跑"]
    fn 性能预览_2560宽整帧编码耗时() {
        let (w, h) = (2560u32, 1440u32);
        let mut noisy = Vec::with_capacity((w * h * 3) as usize);
        for i in 0..(w * h) {
            let v = ((i * 37) % 251) as u8;
            noisy.extend_from_slice(&[v, v.wrapping_add(97), v.wrapping_mul(3)]);
        }
        let _ = encode_jpeg(&noisy, w, h, 80); // 预热
        let mut times = Vec::new();
        for _ in 0..4 {
            let t0 = std::time::Instant::now();
            let out = encode_jpeg(&noisy, w, h, 80).expect("编码应成功");
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            println!("  WIC {ms:>7.2} ms  {:>7.1} KB", out.len() as f64 / 1024.0);
            times.push(ms);
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "  {w}x{h} q80 中位数 {:.2} ms/帧（含 RGB→BGR）· 对照 image crate 196.78 ms",
            times[times.len() / 2]
        );
    }

    /// 🔴 画质回归守卫：WIC 默认 **4:2:0**，本模块显式设成 **4:2:2**（与被替换掉的
    /// `image` crate 对齐）。直接解析产物的 SOF 采样因子，比「肉眼看文字边缘」可靠。
    ///
    /// 判据：Y 分量 `H×V` 采样因子 2x1 = 4:2:2；**(2,2) 就是 4:2:0，即画质被静默降级**。
    #[test]
    fn 色度抽样应为_4_2_2_而非默认的_4_2_0() {
        let (w, h) = (64u32, 64u32);
        let jpg = encode_jpeg(&stripes_rgb(w, h), w, h, 90).expect("编码应成功");

        let mut i = 2usize;
        let mut found = None;
        while i + 3 < jpg.len() {
            if jpg[i] != 0xFF {
                i += 1;
                continue;
            }
            let m = jpg[i + 1];
            if m == 0xDA {
                break; // 进了扫描数据，段头到此为止
            }
            if m == 0xD8 || m == 0x01 || (0xD0..=0xD7).contains(&m) {
                i += 2; // 无长度字段的标记
                continue;
            }
            let len = ((jpg[i + 2] as usize) << 8) | jpg[i + 3] as usize;
            if (0xC0..=0xC2).contains(&m) {
                // SOF 布局：len(2) precision(1) h(2) w(2) Nf(1) 然后每个分量 3 字节
                // ⇒ 第 1 个分量的采样因子在 i+11
                let hv = jpg[i + 11];
                found = Some((hv >> 4, hv & 0x0F));
                break;
            }
            i += 2 + len;
        }
        let (hh, vv) = found.expect("产物里应当有 SOF 段");
        assert_eq!(
            (hh, vv),
            (2, 1),
            "Y 采样因子应为 2x1（4:2:2）。(2,2) = 4:2:0，说明画质被静默降级了"
        );
    }
}
