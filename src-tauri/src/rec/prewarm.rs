//! 录屏编码器**预热**（乙案，2026-10-11）。
//!
//! 症状：倒计时「321」走到 1 会卡一下才进录制，而且那个「1」被录进成品开头。
//! 根因不在前端：`rec_start` 里同步付掉「开硬件编码器」——本机实测 ≈2.8s（MF 三台
//! 候选全败的选型 997ms + FFmpeg 符号加载 + 开 nvenc），这段时间选区窗还画着倒计时，
//! 而 DXGI 抓的是**合成后的桌面**，于是每一帧都带着那个数字。
//!
//! 做法：选区窗进倒计时的那一刻，在独立线程上把这一场要用的编码器打开并存进单槽；
//! 3 秒空档正好盖住启动开销，归零时 `rec_start` → `run_record` 直接取用。
//!
//! 🔴 键（[`EncKey`]）必须由 [`enc_key`] 单点换算：预热侧与正式侧各算一遍就会算出
//! 两个键，预热永不命中（规则 11.1）。键不命中是**性能**故障不是正确性故障——
//! 正式路径照旧自行打开，最多慢回原来的 2.8s。
//!
//! 跨线程持有：`H264SessionEncoder` 在 `rc/encode_h264/session.rs` 里已有
//! `unsafe impl Send`（前提是全进程 MTA + 串行访问，本模块两个条件都满足：预热线程
//! 用 `COINIT_MULTITHREADED`，结果交给会话前只有它一个人在动）。
//!
//! 资源边界：最多多占一条线程 + 一个空闲编码会话，TTL 到点或取走即释放（不越过
//! 倒计时结束后的 6 秒）。

use std::sync::mpsc::channel;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::rc::encode_h264::{ensure_mf_startup, H264SessionEncoder, VideoCodec};

use super::quality::{self, RecQuality};
use super::sink::sink_params;

/// 预热结果的最长有效期：倒计时 3s + 会话装配与首帧抓取。超了就当没预热过
/// （宁可白丢一次预热，也不把一个来路不明的编码会话塞给本场）。
const TTL: Duration = Duration::from_secs(6);

/// 打开一个录制编码器所需的全部参数 = 预热槽的身份。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncKey {
    pub codec: VideoCodec,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
}

/// 键的唯一换算出口：与 `run_record` 第 2 步 + 第 3 步的入参完全同源
/// （钳位 → `sink_params` → `quality.codec()`）。
///
/// `canvas` = (虚拟屏原点 x/y, 画布宽高)。预热只能读 `GetSystemMetrics`（没有 DXGI
/// 会话），正式路径读的是 DXGI 复制画布尺寸——两者不一致时（罕见）键自然不命中，
/// 正式路径自行打开，不会拿错尺寸的编码器。
pub fn enc_key(
    quality: RecQuality,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    canvas: (i32, i32, u32, u32),
) -> EncKey {
    let (ox, oy, cw, ch) = canvas;
    let (_, _, rw, rh) = quality::clamp_rect(x - ox, y - oy, w, h, cw, ch);
    let sp = sink_params(quality, rw, rh);
    EncKey {
        codec: quality.codec(),
        width: sp.width,
        height: sp.height,
        fps: sp.fps,
        bitrate: sp.bitrate,
    }
}

/// 交出去之前的一次判定（纯函数，单测钉的就是它）：键相同且没过 TTL。
fn reusable(stored_key: EncKey, made_at: Instant, want: EncKey, now: Instant) -> bool {
    stored_key == want && now.duration_since(made_at) <= TTL
}

struct Stored {
    gen: u64,
    key: EncKey,
    enc: H264SessionEncoder,
    made_at: Instant,
    /// 持有端在预热线程上：它一 drop，线程就知道「结果被取走/丢弃了」，可以配平 COM 后退出。
    _keep: std::sync::mpsc::Sender<()>,
}

enum Slot {
    Empty,
    /// 预热在途（带代际号：新请求会把它作废，在途线程完成时发现代际不符就地丢弃）
    Warming { gen: u64 },
    Ready(Stored),
}

static SLOT: Mutex<Slot> = Mutex::new(Slot::Empty);
static CHANGE: Condvar = Condvar::new();
static GEN: AtomicU64 = AtomicU64::new(0);

fn slot() -> MutexGuard<'static, Slot> {
    SLOT.lock().unwrap_or_else(|p| p.into_inner())
}

/// 发起预热（同键重复请求 = 重开；旧结果当场丢弃）。参数由命令层校验过。
pub fn request(key: EncKey) {
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    // 腾槽：旧编码器在这里 Drop（与远控抢同一块 nvenc 的窗口越短越好）
    *slot() = Slot::Warming { gen };
    if std::thread::Builder::new()
        .name("rec-prewarm".into())
        .spawn(move || warm(key, gen))
        .is_err()
    {
        *slot() = Slot::Empty; // 线程没起来：槽必须还回去，否则 take 白等到超时
        log::warn!("[Rec] 预热线程起不来，开录走原路");
    }
}

/// 取用预热好的编码器。`wait_max` = 预热仍在途时最多等多久（到点自行打开，不等第二份）。
pub fn take(key: EncKey, wait_max: Duration, cancelled: &std::sync::atomic::AtomicBool) -> Option<H264SessionEncoder> {
    let started=Instant::now();
    let mut guard=slot();
    loop {
        if cancelled.load(Ordering::SeqCst) {return None;}
        if matches!(&*guard,Slot::Ready(_)) {return drain_ready(&mut guard,key);}
        if !matches!(&*guard,Slot::Warming{..}) {return None;}
        let remaining=wait_max.saturating_sub(started.elapsed());
        if remaining.is_zero() {return None;}
        let (next,_)=CHANGE.wait_timeout(guard,remaining.min(Duration::from_millis(100))).unwrap_or_else(|p|p.into_inner());
        guard=next;
    }
}

/// Ready 槽的一次「取出 / 丢弃」。总是先把槽腾空，再决定交出去还是就地销毁。
fn drain_ready(guard: &mut Slot, want: EncKey) -> Option<H264SessionEncoder> {
    let taken = std::mem::replace(guard, Slot::Empty);
    let Slot::Ready(stored) = taken else {
        *guard = taken; // 对手刚取走 / 已作废：原样放回
        return None;
    };
    if !reusable(stored.key, stored.made_at, want, Instant::now()) {
        log::warn!(
            "[Rec] 预热槽不可复用（本场 {:?}，槽里 {:?}），自行打开",
            want,
            stored.key
        );
        return None;
    }
    log::info!("[Rec] 复用预热编码器（{}ms 前打开）", stored.made_at.elapsed().as_millis());
    Some(stored.enc)
    // stored 余下的字段（含 _keep）在此析构 → 预热线程断链退出
}

/// 预热线程主体：开编码器 → 存槽 → 守着结果期间不解 COM → 被取走/过期后配平退出。
fn warm(key: EncKey, gen: u64) {
    warm_with_open(key, gen, || match ensure_mf_startup() {
        Err(e) => {
            log::warn!("[Rec] 预热失败（{e}），开录走原路");
            None
        }
        Ok(()) => {
            let enc = H264SessionEncoder::try_open_for_file(
                key.codec, key.width, key.height, key.fps, key.bitrate,
            );
            if enc.available() {
                Some(enc)
            } else {
                log::warn!("[Rec] 预热：没有可用硬件编码器（开录时会给出同样的结论）");
                None
            }
        }
    });
}

fn warm_with_open(key:EncKey, gen:u64, open:impl FnOnce()->Option<H264SessionEncoder>) {
    let com_owned = unsafe {
        windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        )
        .is_ok()
    };
    let uninit = || unsafe { windows::Win32::System::Com::CoUninitialize() };
    let t = Instant::now();
    let opened = open();
    let Some(enc) = opened else {
        let mut guard=slot();
        if matches!(&*guard,Slot::Warming{gen:g} if *g==gen) {*guard=Slot::Empty;}
        drop(guard);
        CHANGE.notify_all();
        if com_owned {
            uninit();
        }
        return;
    };
    let (keep, hold) = channel::<()>();
    let mut guard = slot();
    // 只有「仍是我这一代在途」才写入：期间被新预热替换过，这个对象没人要
    let mine = matches!(&*guard, Slot::Warming { gen: g } if *g == gen);
    if !mine {
        drop(guard);
        log::warn!("[Rec] 预热完成但本场已作废（{}ms），丢弃", t.elapsed().as_millis());
        drop(enc);
        if com_owned {
            uninit();
        }
        return;
    }
    *guard = Slot::Ready(Stored { gen, key, enc, made_at: Instant::now(), _keep: keep });
    drop(guard);
    CHANGE.notify_all();
    log::info!("[Rec] 编码器预热完成（{}ms）", t.elapsed().as_millis());
    // 编码器还住在槽里 = 本线程的 COM 还不能解：等断链（被取走/替换）或 TTL 到点
    if matches!(
        hold.recv_timeout(TTL),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout)
    ) {
        let mut guard = slot();
        if matches!(&*guard, Slot::Ready(s) if s.gen == gen) {
            *guard = Slot::Empty;
        }
    }
    if com_owned {
        uninit();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CANVAS: (i32, i32, u32, u32) = (0, 0, 1920, 1080);

    // 预热的失效方式是「键不命中」，而且完全静默：以下用例钉的是
    // 「键 = 打开编码器的五个入参」这条映射，不是某个具体数字。

    #[test]
    fn enc_key_is_the_same_five_args_as_session_open() {
        let a = enc_key(RecQuality::High, 0, 0, 1920, 1080, CANVAS);
        let b = enc_key(RecQuality::High, 0, 0, 1920, 1080, CANVAS);
        assert_eq!(a, b, "同参数两次换算必须给出同一个键");
        let sp = sink_params(RecQuality::High, 1920, 1080);
        assert_eq!(
            (a.codec, a.width, a.height, a.fps, a.bitrate),
            (
                RecQuality::High.codec(),
                sp.width,
                sp.height,
                sp.fps,
                sp.bitrate
            ),
            "键的五个字段就是 try_open_for_file 的五个入参"
        );
    }

    #[test]
    fn enc_key_changes_with_quality_and_region() {
        let big = (0, 0, 2560u32, 1440u32);
        let high = enc_key(RecQuality::High, 0, 0, 2560, 1440, big);
        assert_eq!((high.width, high.height), (2560, 1440), "高清档不缩尺寸");
        assert_ne!(
            high,
            enc_key(RecQuality::Standard, 0, 0, 2560, 1440, big),
            "标准档缩到 1080p，绝不能同键"
        );
        assert_ne!(
            high,
            enc_key(RecQuality::Smooth, 0, 0, 2560, 1440, big),
            "流畅档缩到 720p，绝不能同键"
        );
        assert_ne!(
            high,
            enc_key(RecQuality::Original, 0, 0, 2560, 1440, big),
            "原画档换 codec + fps + 码率，绝不能同键"
        );
        assert_ne!(high, enc_key(RecQuality::High, 0, 0, 800, 600, big), "换区域必换键");
    }

    #[test]
    fn enc_key_is_param_based_not_brand_based() {
        // 1080p 源上「高清」与「标准」算出的编码参数完全相同 ⇒ 同键 ⇒ 预热可以跨档复用。
        // 这不是漏洞：键的定义就是 try_open_for_file 的五个入参，同入参即同一台编码器。
        // 若哪天档位差异落到入参上（比如按档调 VBR 峰值），这条会变红——那时才需要新维度。
        let high = enc_key(RecQuality::High, 0, 0, 1920, 1080, CANVAS);
        assert_eq!(high, enc_key(RecQuality::Standard, 0, 0, 1920, 1080, CANVAS));
    }

    #[test]
    fn enc_key_uses_clamped_region_like_run_record() {
        // 越界选区：正式路径按 clamp_rect 的结果打开。预热若拿原始尺寸就会算出另一个键。
        assert_eq!(
            enc_key(RecQuality::High, 0, 0, 4000, 4000, CANVAS),
            enc_key(RecQuality::High, 0, 0, 1920, 1080, CANVAS)
        );
        // 多屏：x/y 是绝对物理坐标，键按画布内相对坐标算
        assert_eq!(
            enc_key(RecQuality::High, 2000, 100, 800, 600, (1920, 0, 1920, 1080)),
            enc_key(RecQuality::High, 80, 100, 800, 600, CANVAS)
        );
    }

    #[test]
    fn reusable_needs_same_key_and_fresh_age() {
        let key = enc_key(RecQuality::High, 0, 0, 1920, 1080, CANVAS);
        let other = enc_key(RecQuality::Original, 0, 0, 1920, 1080, CANVAS);
        let now = Instant::now();
        assert!(reusable(key, now, key, now), "同键 + 刚打开 → 复用");
        assert!(
            !reusable(other, now, key, now),
            "键不同 → 绝不复用（宁可白预热，也不能拿错尺寸的编码器）"
        );
        assert!(
            !reusable(key, now - TTL - Duration::from_millis(1), key, now),
            "超过 TTL → 丢弃"
        );
        assert!(reusable(key, now - TTL + Duration::from_millis(1), key, now));
    }

    #[test]
    fn failed_warm_releases_its_own_generation_immediately() {
        let key=enc_key(RecQuality::High,0,0,1920,1080,CANVAS);
        *slot()=Slot::Warming{gen:90001};
        warm_with_open(key,90001,||None);
        assert!(matches!(*slot(),Slot::Empty),"failed prewarm must not make start wait four seconds");
    }
}
