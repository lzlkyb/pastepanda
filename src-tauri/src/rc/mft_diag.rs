//! 硬编 MFT「进程内激活失败」的诊断（2026-09-23 新建）。
//!
//! # 为什么有这个文件
//!
//! 真机被控推流**恒走 JPEG 兜底**（0.9fps、单圈 ~1100ms）。日志：
//!
//! ```text
//! [RC] 编码器「Intel QSV H.264」试编失败，尝试下一台
//! [RC] 编码器「NVIDIA H.264 Encoder MF」ActivateObject 失败：灾难性故障 (0x8000FFFF)
//! [RC-PERF] 编码器选型：候选 3 台 · 试编 3 台 · 跳过 3 台 · 共 839ms  选中「」
//! ```
//!
//! `0x8000FFFF` = `E_UNEXPECTED`。但**同机同驱动**的外部探针
//! `probe/rc-mft-type pick.exe --luid --probe-both` 稳定 ✓（NVENC 7ms/帧）。
//!
//! 已复现 **3/3**（20:19 / 21:22 / 21:26），形态逐字一致。探针侧逐一证伪：
//! COM apartment（`--sta`）、caps 前置（`--probe-both`）、LUID 排序、时间间隔、
//! 输入约束、盲取 `slice[0]`、试编复用实例。⇒ 差异 100% 在**主程序进程内**。
//!
//! # 三条判据（本模块把它们变成可 grep 的日志）
//!
//! 1. **线程身份 + 公寓类型** —— `CoGetApartmentType`（纯查询，不改状态）。
//!    跑选型的 `open_h264` 是同步函数、被 async 的 `try_hardware_path` 直接调，
//!    所以它在 **tokio worker 线程**上执行。若某条 worker 已被别的子系统
//!    （`screenshot.rs` 的 UIA 用 `COINIT_APARTMENTTHREADED`）初始化成 STA，
//!    则 `CoInitializeEx(MTA)` 返回 `RPC_E_CHANGED_MODE`、公寓**仍是 STA**，
//!    而 async 硬编 MFT 在 STA 上激活失败正是 `E_UNEXPECTED` 的教科书成因。
//! 2. **瞬态还是持久** —— `mft_pick::create_h264_mft` 里失败后原地重试一次。
//! 3. **线程局部还是进程全局** —— 另起一条**全新线程**重跑「枚举 + 激活」。
//!    新线程必然是干净的未初始化状态 ⇒ `CoInitializeEx(MTA)` 必得 `S_OK`，
//!    与当前线程的公寓状态无关。两边一对比即可定性：
//!    - 新线程 ✓ / 当前 ✗ ⇒ **线程公寓问题**（根治要从「编码绑专用 MTA 线程」下手）
//!    - 两边都 ✗         ⇒ **进程全局问题**（D3D11 设备 / MF 状态 / NVENC 会话）
//!
//! ⚠️ 本模块**只在已经失败的路径上**执行，成功路径零开销；
//! 唯一改变行为的地方是 `mft_pick` 的「失败后重试一次」（只在必败分支内）。
//! 日志前缀统一 `[RC-DIAG]`，`grep RC-DIAG` 一次拿全。

use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoGetApartmentType, APTTYPE, APTTYPEQUALIFIER};

use super::encode_h264::VideoCodec;

/// 请求 MTA 公寓，并**在被拒时留下证据**。
///
/// 🔴 这个函数的存在理由：项目里三处 `CoInitializeEx(MTA)` 过去都把返回值丢了
/// （`gpu.rs` 的 `let _ = ...`、`dxgi.rs` / `encode_h264/mf.rs` 的 `.is_ok()`）。
/// 若所在线程已被初始化成 STA，调用返回 `RPC_E_CHANGED_MODE`（`0x80010106`），
/// 公寓保持 STA，而代码照常往下跑 —— 随后激活 async 硬编 MFT 报
/// `E_UNEXPECTED`。这类失败在日志里**完全隐形**，是本次排查绕远路的主因之一。
///
/// 返回语义与原 `.is_ok()` **逐字等价**（`S_OK`/`S_FALSE` = true ⇒ 调用方持有
/// 引用、须在放下 COM 引用后配对 `CoUninitialize`），因此替换是**零行为改动**，
/// 只是多一条告警。
pub(super) fn ensure_mta_quiet(who: &str) -> bool {
    let hr = unsafe {
        windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        )
    };
    if hr.is_ok() {
        return true;
    }
    let (tid, apt, _) = thread_apartment();
    // ⚠️ 一条**完整**的格式串：不用 `\` 续行（行尾空格会被吃掉，日志粘连难读）
    log::warn!(
        "[RC-DIAG] {who} 请求 MTA 公寓被拒：{:#010X}（tid={tid} 当前公寓={apt}）；该线程上激活 async 硬编 MFT 会报 0x8000FFFF",
        hr.0 as u32
    );
    false
}

/// 当前线程的「线程 ID + COM 公寓类型」快照。**纯查询，不改 COM 状态**。
///
/// 返回 `(线程 ID, 公寓描述, HRESULT)`。线程没初始化过 COM 时 HRESULT 为
/// `CO_E_NOTINITIALIZED (0x800401F0)` —— 这本身就是一条有用的线索
/// （说明 `CoInitializeEx` 那一步压根没成功）。
pub(super) fn thread_apartment() -> (u32, String, i32) {
    let tid = unsafe { windows::Win32::System::Threading::GetCurrentThreadId() };
    let mut apt = APTTYPE(0);
    let mut qual = APTTYPEQUALIFIER(0);
    match unsafe { CoGetApartmentType(&mut apt, &mut qual) } {
        Ok(()) => (tid, format!("{}{}", apt_name(apt.0), qual_name(qual.0)), 0),
        Err(e) => {
            let code = e.code().0;
            (tid, format!("未初始化({:#010X})", code as u32), code)
        }
    }
}

/// `APTTYPE` 数值 → 名称。抽成纯函数，便于在无 COM 环境下单测。
pub(super) fn apt_name(v: i32) -> &'static str {
    match v {
        0 => "STA",
        1 => "MTA",
        2 => "NA",
        3 => "MainSTA",
        _ => "未知公寓",
    }
}

/// `APTTYPEQUALIFIER` 数值 → 注解。纯函数，可单测。
///
/// 只看 `APTTYPE` 会漏掉「隐式 MTA」这类细微状态，而它恰好是「线程其实没被
/// 显式初始化、COM 被别的调用顺手拉起来」的迹象。
pub(super) fn qual_name(v: i32) -> &'static str {
    match v {
        0 => "",
        1 => "(隐式MTA)",
        2 => "(NA on MTA)",
        3 => "(NA on STA)",
        4 => "(NA on 隐式MTA)",
        5 => "(NA on MainSTA)",
        6 => "(应用STA)",
        _ => "(其余)",
    }
}

/// 「枚举 + 逐台 `ActivateObject`」的轻量重测：**刻意不做试编**。
///
/// 试编要喂帧、走完整类型协商，三台合计 ~839ms —— 那是失败路上的大头，
/// 而这个诊断只回答一件事：**这台 MFT 在本线程上能不能被实例化**。
/// 那正是真机失败的那一步（NVIDIA 报 `0x8000FFFF`）。
///
/// `name_filter`：只测友好名含该子串的台（进程时间线采样时只要 NVIDIA 一台，
/// 免得每次采样都把 3 台全激活、白付配额与耗时）。`None` = 全测。
unsafe fn enumerate_activate(codec: VideoCodec, name_filter: Option<&str>) -> (usize, String) {
    let out_info = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: *codec.mf_subtype(),
    };
    let mut count = 0u32;
    let mut acts: *mut Option<IMFActivate> = std::ptr::null_mut();
    let _ = MFTEnumEx(
        MFT_CATEGORY_VIDEO_ENCODER,
        MFT_ENUM_FLAG_HARDWARE,
        None,
        Some(&out_info),
        &mut acts,
        &mut count,
    );
    if count == 0 || acts.is_null() {
        return (0, "枚举 0 台".into());
    }
    let slice = std::slice::from_raw_parts(acts, count as usize);
    let mut parts: Vec<String> = Vec::new();
    for a in slice.iter().flatten() {
        let name = super::mft_pick::friendly_name_of(a).unwrap_or_else(|| "(无名)".into());
        if let Some(f) = name_filter {
            if !name.contains(f) {
                continue;
            }
        }
        match a.ActivateObject::<IMFTransform>() {
            // `_t` 在 arm 结束即 drop（COM Release），无需显式释放
            Ok(_t) => parts.push(format!("{name} ✓")),
            Err(e) => parts.push(format!("{name} ✗{:#010X}", e.code().0 as u32)),
        }
    }
    let n = parts.len();
    windows::Win32::System::Com::CoTaskMemFree(Some(acts as _));
    (n, parts.join(" · "))
}

/// 跨线程对照**每进程只做一次**：一次失败会连带几百毫秒的重测成本，
/// 而熔断重试最密也在秒级，不该反复付。首次结果缓存复用。
static CROSS_THREAD: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// 在**全新线程**上重跑「枚举 + 激活」，作为进程内对照。
fn cross_thread_activate(codec: VideoCodec) -> String {
    let h = std::thread::Builder::new()
        .name("rc-mft-diag".into())
        .spawn(move || {
            // 新线程是干净的未初始化状态：这里应当拿到 `S_OK`（日志可见）
            let mta = ensure_mta_quiet("诊断线程");
            let (tid, apt, _) = thread_apartment();
            let (n, detail) = unsafe { enumerate_activate(codec, None) };
            format!(
                "tid={tid} 公寓={apt} MTA请求={} · 枚举 {n} 台 · {detail}",
                if mta { "接受" } else { "被拒" }
            )
        });
    match h {
        Ok(h) => h.join().unwrap_or_else(|_| "诊断线程 panic".into()),
        Err(e) => format!("诊断线程创建失败：{e}"),
    }
}

/// 选型全败时的现场取证。只由 `mft_pick::create_h264_mft` 的失败出口调用。
pub(super) fn dump_pick_failure(codec: VideoCodec) {
    let (tid, apt, _) = thread_apartment();
    log::warn!(
        "[RC-DIAG] 选型全败现场：pid={} tid={tid} 公寓={apt} codec={}",
        std::process::id(),
        codec.as_str()
    );
    // 当前线程原地重测：与刚才的失败逐台对比 ⇒ 顺带回答「瞬态 or 持久」
    let (n_here, here) = unsafe { enumerate_activate(codec, None) };
    log::warn!("[RC-DIAG]   当前线程重测：枚举 {n_here} 台 · {here}");
    // 干净线程重测：同进程内对照 ⇒ 回答「线程局部 or 进程全局」
    let cross = CROSS_THREAD.get_or_init(|| cross_thread_activate(codec));
    log::warn!("[RC-DIAG]   干净线程重测：{cross}");
    // 绕过 `IMFActivate` 的创建路径 ⇒ 区分「DLL 本身坏了」与「ActivateObject 装配路径坏了」
    let by_clsid = unsafe { create_by_clsid(codec, "NVIDIA") };
    log::warn!("[RC-DIAG]   {by_clsid}");
}

/// 进程时间线上的「NVENC 激活快照」。
///
/// # 为什么要在多个时间点采样
///
/// 「探针 ✓ / 主程序 ✗」的排查已经逐一排除掉 MFT 侧的全部因素：线程公寓
/// （实测 MTA 正常）、时序、caps 前置、枚举 flags（探针复刻同一份）、输入约束、
/// 盲取 `slice[0]`、LUID 排序，`MFStartup` 也是标准的 `MFSTARTUP_FULL`。
/// 差距只剩**进程内其它状态**——而进程里每一样都可能是凶手。
///
/// 于是把「能不能激活 NVENC」当成进程的一个**可观测变量**，沿启动时间线打点：
/// 坏在哪两个采样点之间，凶手就在那一段里完成初始化。这比继续猜子系统快得多。
pub fn probe_nvenc_snapshot(stage: &str) {
    // ⚠️ 必须在**独立线程**里采样，两条理由：
    // ① 本函数会被 `run()` 早期调用，那时是 tao 的**主线程**——tao 在建窗口前要
    //    调 `OleInitialize`(STA) 来支持拖放。若在主线程上 `CoInitializeEx(MTA)`，
    //    tao 会报 `RPC_E_CHANGED_MODE` 并 **panic 退出**（2026-09-23 实测
    //    `exit code: 101`，`tao/windows/window.rs:109`）。这条约束顺带记录了
    //    一个事实：**主线程是 STA**。
    // ② 顺带保证每次采样都在**干净的 MTA** 上，判据不受调用点所在线程影响。
    let stage = stage.to_string();
    if let Ok(h) = std::thread::Builder::new()
        .name("rc-nvenc-snap".into())
        .spawn(move || nvenc_snapshot_inner(&stage))
    {
        // 必须 join：采样点要落回时间线的正确位置，异步会把顺序打乱
        let _ = h.join();
    }
}

/// 采样主体。**只能在线程里调用**（理由见 `probe_nvenc_snapshot` 的 ①）。
fn nvenc_snapshot_inner(stage: &str) {
    ensure_mta_quiet("NVENC 快照");
    // MFTEnumEx 要求 MF 平台已启动；换个线程调用时不能假定别处已经启动过
    if let Err(e) = crate::rc::encode_h264::ensure_mf_startup() {
        log::warn!("[RC-DIAG] NVENC 快照[{stage}]：MFStartup 失败 {e}");
        return;
    }
    let (tid, apt, _) = thread_apartment();
    let dll = if nv_encoder_dll_loaded() {
        "已加载"
    } else {
        "未加载"
    };
    let (n, detail) = unsafe { enumerate_activate(VideoCodec::H264, Some("NVIDIA")) };
    log::warn!(
        "[RC-DIAG] NVENC 快照[{stage}]：tid={tid} 公寓={apt} nvEncDLL={dll} 命中 {n} 台 · {detail}"
    );
}

/// `nvEncMFTH264x.dll` 是否已在本进程内。用来把「DLL 还没进来」与
/// 「DLL 进来了但激活失败」分开——两者的处理方向完全不同。
fn nv_encoder_dll_loaded() -> bool {
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    unsafe { GetModuleHandleW(windows::core::w!("nvEncMFTH264x.dll")).is_ok() }
}

/// 绕过 `IMFActivate`，按 CLSID 直接 `CoCreateInstance` 创建目标 MFT。
///
/// `ActivateObject` 与 `CoCreateInstance` 是两条不同的创建路径：前者会为 MFT
/// 装配专属的 work queue / attributes（`MFT_ENUM_ADAPTER_LUID` 之类），后者是
/// 最朴素的 COM 类厂创建。两边结果不同，就能把失败点夹到很窄的范围内：
/// - 直创 ✓ / `ActivateObject` ✗ ⇒ 坏在 MF 的装配层，不是厂商 DLL
/// - 两者都 ✗                   ⇒ 坏在厂商 DLL 或更底层的驱动/进程状态
unsafe fn create_by_clsid(codec: VideoCodec, name_filter: &str) -> String {
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};

    let out_info = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: *codec.mf_subtype(),
    };
    let mut count = 0u32;
    let mut acts: *mut Option<IMFActivate> = std::ptr::null_mut();
    let _ = MFTEnumEx(
        MFT_CATEGORY_VIDEO_ENCODER,
        MFT_ENUM_FLAG_HARDWARE,
        None,
        Some(&out_info),
        &mut acts,
        &mut count,
    );
    if count == 0 || acts.is_null() {
        return "CLSID 直创：枚举 0 台，跳过".to_string();
    }
    let slice = std::slice::from_raw_parts(acts, count as usize);
    let mut out = String::from("CLSID 直创：未找到匹配 MFT");
    for a in slice.iter().flatten() {
        let name = super::mft_pick::friendly_name_of(a).unwrap_or_else(|| "(无名)".into());
        if !name.contains(name_filter) {
            continue;
        }
        out = match a.GetGUID(&MFT_TRANSFORM_CLSID_Attribute) {
            Err(e) => format!("CLSID 直创[{name}]：读 CLSID 失败 {:#010X}", e.code().0 as u32),
            Ok(clsid) => {
                let created: windows::core::Result<IMFTransform> =
                    CoCreateInstance(&clsid, None, CLSCTX_INPROC_SERVER);
                match created {
                    Ok(_t) => format!("CLSID 直创[{name}]：✓ 成功"),
                    Err(e) => format!("CLSID 直创[{name}]：✗{:#010X}", e.code().0 as u32),
                }
            }
        };
        break;
    }
    windows::Win32::System::Com::CoTaskMemFree(Some(acts as _));
    out
}

#[cfg(test)]
mod tests {
    use super::{apt_name, qual_name};

    /// 守卫：公寓类型的四个合法值必须各自映射到不同名称。写错不会崩，
    /// 只会让日志把 STA 说成 MTA —— 而这条日志正是定位全败根因的唯一线索。
    #[test]
    fn 公寓类型名称不得混淆() {
        assert_eq!(apt_name(0), "STA");
        assert_eq!(apt_name(1), "MTA");
        assert_eq!(apt_name(2), "NA");
        assert_eq!(apt_name(3), "MainSTA");
        // 未知值必须显式暴露，不能回落到某个合法名
        assert_eq!(apt_name(9), "未知公寓");
        assert_ne!(apt_name(0), apt_name(1), "STA 与 MTA 是本次排查的核心判据");
    }

    /// 守卫：`APTTYPEQUALIFIER_NONE`(0) 必须得到空串，否则日志会出现
    /// 「MTA(其余)」这类噪声，干扰 grep。
    #[test]
    fn 公寓限定符零值不得产生噪声() {
        assert_eq!(qual_name(0), "");
        assert_eq!(qual_name(1), "(隐式MTA)");
        assert!(qual_name(99).starts_with('('));
    }
}
