//! 视频帧线格式：JPEG/H264 写流、元数据帧、收流、FrameOutbox。

use super::*;

pub async fn write_jpeg(s: &mut iroh::endpoint::SendStream, jpeg: &[u8]) -> Result<(), String> {
    if jpeg.is_empty() || jpeg.len() > MAX_JPEG_BYTES || !is_jpeg_magic(jpeg) {
        return Err("非法 JPEG 帧".into());
    }
    write_raw(s, jpeg).await
}

/// 发送 JPEG 帧的采集时间戳（JSON 控制帧），随后应跟 JPEG 数据。
/// 与 `write_dirty_meta` 同一语法位：都是「下一帧 JPEG 的元数据」。
/// P0-2：cap/enc = 采集/编码耗时（ms），发起端 HUD 分段显示。
pub async fn write_vts_meta(
    s: &mut iroh::endpoint::SendStream,
    ts: i64,
    cap_ms: u16,
    enc_ms: u16,
) -> Result<(), String> {
    let b = serde_json::to_vec(
        &serde_json::json!({ "t": "vts", "ts": ts, "cap": cap_ms, "enc": enc_ms }),
    )
    .map_err(|e| e.to_string())?;
    write_raw(s, &b).await
}

/// 发送脏矩形元数据（JSON），随后应跟一块 JPEG。
pub async fn write_dirty_meta(
    s: &mut iroh::endpoint::SendStream,
    r: DirtyRect,
) -> Result<(), String> {
    let meta = serde_json::json!({
        "t": "vrect",
        "x": r.x,
        "y": r.y,
        "w": r.w,
        "h": r.h,
    });
    let b = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
    write_raw(s, &b).await
}

/// 发送 H.264/HEVC：先 JSON 元数据（带采集时间戳 ts），再 Annex-B 裸流。
///
/// 🔴 ts 必须传：前端据它算「画面链路延迟」（帧龄 = 展示时刻 - 采集时刻），
/// 丢了这个就只能拿发起端收包时刻充数，编码+网络那段延迟全被藏掉。
/// P0-2：cap/enc = 采集/编码耗时（ms），发起端 HUD 分段显示。
/// P2-1：sq = 帧序号（与数据报通道共用一把尺子）——走流的关键帧到达时，
/// 接收端按它重置数据报重组器，两条路才能无缝衔接。
/// Q3：hevc = true 时元数据带 `"c":"hevc"`——**逐帧**标注编码标准，前端据此
/// 选解码器；旧对端忽略未知字段（也解不了 HEVC，会走它自己的兜底）。
#[allow(clippy::too_many_arguments)]
pub async fn write_h264(
    s: &mut iroh::endpoint::SendStream,
    data: &[u8],
    key: bool,
    width: u32,
    height: u32,
    ts: i64,
    cap_ms: u16,
    enc_ms: u16,
    sq: u32,
    hevc: bool,
) -> Result<(), String> {
    if data.is_empty() {
        return Err("空 H.264 包".into());
    }
    let mut meta = serde_json::json!({
        "t": "h264",
        "key": key,
        "w": width,
        "h": height,
        "n": data.len(),
        "ts": ts,
        "cap": cap_ms,
        "enc": enc_ms,
        "sq": sq,
    });
    if hevc {
        meta["c"] = serde_json::Value::String("hevc".into());
    }
    let b = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
    // 4K 关键帧可达数 MB，写停滞超时放宽到 60s（R5.B）
    let stall = if key {
        std::time::Duration::from_secs(60)
    } else {
        std::time::Duration::from_secs(30)
    };
    write_raw_stall(s, &b, stall).await?;
    write_raw_stall(s, data, stall).await
}

async fn write_raw(s: &mut iroh::endpoint::SendStream, bytes: &[u8]) -> Result<(), String> {
    write_raw_stall(s, bytes, std::time::Duration::from_secs(30)).await
}

async fn write_raw_stall(
    s: &mut iroh::endpoint::SendStream,
    bytes: &[u8],
    stall: std::time::Duration,
) -> Result<(), String> {
    // 分块 + 停滞超时：对端不读时流控窗口填满，裸 write_all 会永远阻塞，
    // 进而长期持有调用方持有的 `send.lock()`，把 `end_session`（取锁）一起挂死。
    const CHUNK: usize = 64 * 1024;
    let len = (bytes.len() as u32).to_be_bytes();
    stalled_write(s, &len, "写帧长度", stall).await?;
    for part in bytes.chunks(CHUNK) {
        stalled_write(s, part, "写帧内容", stall).await?;
    }
    Ok(())
}

/// 给一次 write_all 包停滞超时（30s 内一个字节都没动 = 中断）。错误信息指出是停滞而非普通 IO。
async fn stalled_write(
    s: &mut iroh::endpoint::SendStream,
    b: &[u8],
    what: &str,
    stall: std::time::Duration,
) -> Result<(), String> {
    tokio::time::timeout(stall, s.write_all(b))
        .await
        .map_err(|_| {
            format!(
                "{what}：{:.0}s 内停滞（对端未读取，已中断推流）",
                stall.as_secs()
            )
        })?
        .map_err(|e| format!("{what}失败：{e}"))
}

pub enum Incoming {
    Jpeg(VideoFrame),
    Control(Vec<u8>),
    /// R4：H.264/HEVC（Q3）Annex-B 包 + 元数据（ts = 被控端采集时刻，epoch ms；
    /// cap/enc = 采集/编码耗时 ms，P0-2 分段用；sq = 帧序号，P2-1 与数据报
    /// 通道共用——旧对端不发，值为 0 时按「无序号」处理；codec = 编码标准，
    /// Q3 起随帧标注）。
    H264 {
        key: bool,
        width: u32,
        height: u32,
        data: Vec<u8>,
        ts: i64,
        cap_ms: u16,
        enc_ms: u16,
        sq: u32,
        codec: FrameCodec,
    },
}

pub async fn read_incoming(r: &mut iroh::endpoint::RecvStream) -> Result<Incoming, String> {
    let mut n = [0u8; 4];
    tokio::time::timeout(std::time::Duration::from_secs(30), r.read_exact(&mut n))
        .await
        .map_err(|_| "读帧超时".to_string())?
        .map_err(|e| format!("读帧长度失败：{e}"))?;
    let n = u32::from_be_bytes(n) as usize;
    if n == 0 || n > MAX_JPEG_BYTES {
        return Err(format!("帧长度不合法（{n}）"));
    }
    let mut buf = vec![0u8; n];
    tokio::time::timeout(std::time::Duration::from_secs(30), r.read_exact(&mut buf))
        .await
        .map_err(|_| "读帧内容超时".to_string())?
        .map_err(|e| format!("读帧内容失败：{e}"))?;

    if is_jpeg_magic(&buf) {
        Ok(Incoming::Jpeg(VideoFrame {
            width: 0,
            height: 0,
            jpeg: buf,
            at_ms: chrono::Utc::now().timestamp_millis(),
            full: true,
            rect: None,
            codec: FrameCodec::Jpeg,
            key: true,
            cap_ms: 0,
            enc_ms: 0,
        }))
    } else if is_json_magic(&buf) {
        // h264 元数据后还跟一包裸流
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf) {
            if v.get("t").and_then(|x| x.as_str()) == Some("h264") {
                let key = v.get("key").and_then(|x| x.as_bool()).unwrap_or(false);
                let width = v.get("w").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
                let height = v.get("h").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
                let n = v.get("n").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                let ts = v.get("ts").and_then(|x| x.as_i64()).unwrap_or(0);
                let cap_ms = v.get("cap").and_then(|x| x.as_u64()).unwrap_or(0) as u16;
                let enc_ms = v.get("enc").and_then(|x| x.as_u64()).unwrap_or(0) as u16;
                let sq = v.get("sq").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
                // Q3：编码标准随帧走（缺省 h264 = 旧对端）。前端按这个字段选解码器。
                let codec = match v.get("c").and_then(|x| x.as_str()) {
                    Some("hevc") => FrameCodec::Hevc,
                    _ => FrameCodec::H264,
                };
                if n == 0 || n > MAX_H264_BYTES {
                    return Err("h264 长度不合法".into());
                }
                let mut data = vec![0u8; n];
                tokio::time::timeout(std::time::Duration::from_secs(30), r.read_exact(&mut data))
                    .await
                    .map_err(|_| "读 h264 超时".to_string())?
                    .map_err(|e| format!("读 h264 失败：{e}"))?;
                return Ok(Incoming::H264 {
                    key,
                    width,
                    height,
                    data,
                    ts,
                    cap_ms,
                    enc_ms,
                    sq,
                    codec,
                });
            }
        }
        Ok(Incoming::Control(buf))
    } else {
        Err("无法识别的帧类型".into())
    }
}

/// 线程安全的最近帧槽（发起端）。
pub type FrameSlot = Mutex<Option<VideoFrame>>;

/// 发起端帧出站队列：前端按序批量取走。
///
/// 🔴 为什么不能沿用 `latest_frame` 槽的 latest-wins：
/// H.264 的 P 帧互相引用，丢一帧整条引用链就断了；JPEG 脏块帧丢一块画布就
/// 永久缺一块（直到下一个整帧）。所以帧必须**全序、不丢**地交给前端，
/// 槽位只留给旧命令 `rc_latest_frame` 兼容。
pub struct FrameOutbox {
    q: std::collections::VecDeque<VideoFrame>,
    /// 队列内帧字节总量（H.264 4K 关键帧单帧可达数 MB，光按条数卡
    /// 90 条 = 上百 MB；按字节再卡一道）。
    bytes: usize,
    /// true = 溢出时丢过 H.264 非 key 帧：引用链已断，后续 P 帧全部拦下，
    /// 直到下一个 key 帧（编码器 GOP ≤1s，最多冻结一秒）重新起链。
    corrupt: bool,
}

impl FrameOutbox {
    /// ≈3s@30fps。超限说明前端已经很久没来取（窗口隐藏 / 卡死），
    /// 继续攒只会让恢复后的第一帧延迟无限涨——丢帧断链好过无限延迟。
    pub const CAP: usize = 90;
    /// 字节上限 64MB（≈4K 关键帧 × 20 条）。到线就开始丢最旧的，
    /// 语义与条数溢出一致。
    pub const MAX_BYTES: usize = 64 * 1024 * 1024;

    pub fn new() -> Self {
        Self {
            q: std::collections::VecDeque::new(),
            bytes: 0,
            corrupt: false,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.q.is_empty()
    }

    pub fn push(&mut self, f: VideoFrame) {
        // 🔴 先弹旧再收新。断链判据看「逐出后的**新队头**」，不看被逐出的帧：
        // P 帧引用的是它的前一帧——被逐出的是谁无所谓，要紧的是活下来的新队头
        // 还有没有解码基准。曾判被逐出的帧：逐出 key 帧时新队头恰是引用它的
        // P 帧，引用链已断却不置 corrupt，花屏帧直发前端（2026-09-19 审查 P2）。
        while self.q.len() >= Self::CAP || (self.bytes >= Self::MAX_BYTES && !self.q.is_empty()) {
            match self.q.pop_front() {
                Some(d) => {
                    self.bytes -= d.jpeg.len();
                    if let Some(head) = self.q.front() {
                        if head.codec == FrameCodec::H264 && !head.key {
                            self.corrupt = true;
                        }
                    }
                }
                None => break,
            }
        }
        if self.corrupt {
            if f.codec == FrameCodec::H264 && !f.key {
                // 引用链已断的 P 帧解出来只能是花屏，拦下别发给前端
                return;
            }
            self.corrupt = false;
        }
        self.bytes += f.jpeg.len();
        self.q.push_back(f);
    }

    pub fn drain(&mut self) -> Vec<VideoFrame> {
        self.bytes = 0;
        self.q.drain(..).collect()
    }

    pub fn clear(&mut self) {
        self.q.clear();
        self.bytes = 0;
        self.corrupt = false;
    }
}

impl Default for FrameOutbox {
    fn default() -> Self {
        Self::new()
    }
}
