//! P2-1 — 视频帧的 QUIC 不可靠数据报通道：分片 + 帧内 XOR 前向纠错 + 顺序重组。
//!
//! # 为什么必须迁出可靠流
//!
//! QUIC 可靠流是**有序**的：丢一个包，后面所有帧排队等重传（队头阻塞）。
//! 5% 丢包下每秒都有重传停顿，帧率档位再高也白搭——这正是 Moonlight 等用
//! UDP+FEC 而不用可靠传输的原因。本模块把 H.264 帧搬到 QUIC datagram：
//!
//! - **帧内 XOR FEC**：帧按 ≤1000B 分片，每 ≤4 片一组附 1 片奇偶（+25% 冗余），
//!   组内丢 1 片即恢复；丢 ≥2 片整帧报废。
//! - **严格顺序交付**：H.264 的 P 帧链使重排 = 花屏，所以按 seq 串行交付。
//! - **出洞先宽限、再放弃**（2026-09-19 审查 D1/D2）：非关键帧出洞不立刻跳帧——
//!   先给 50ms 宽限缓存乱序帧（跨通道重排 / 网络乱序窗口），洞补上就无缝续播；
//!   宽限过期才判 corrupt 跳帧。corrupt 期间到达的帧**继续缓存不丢弃**，
//!   走流的关键帧锚定后按序补交付——此前「corrupt 即弃 + 锚定只重置游标」
//!   会让一次丢包冻结 1~2 个 GOP。
//! - **丢帧必须喊话**：进入 corrupt 时置 damage 信号，调用方向被控端发
//!   request_key——丢的帧到不了前端，前端只在解码出错时才知道，这条信号
//!   是 ForceKeyFrame 自愈（1s GOP）提速到 RTT 级的唯一触发器。
//! - **模式过渡只发生在关键帧**：走流的关键帧到达时重置重组器（next = 该帧
//!   +1），其后已到的 P 帧仍是合法引用——过渡不破坏引用链。
//! - JPEG 不走这里：脏块帧没有链式依赖，丢一片只是那块区域旧一点，
//!   静态精修（300ms 后 q95 回补）会把它补回来。

#![cfg(target_os = "windows")]

use super::video::FrameCodec;

/// 数据报标记字节（误解包即弃）。
pub const DGRAM_TAG: u8 = 0xD1;
/// 单片承载上限（+34B 头 = 1034B，低于 QUIC datagram 的 ~1200B 安全线）。
pub const FRAG: usize = 1000;
/// FEC 组大小：每 ≤4 片 1 片奇偶。
const GROUP: usize = 4;
/// 头长度：tag1 + seq4 + flags1 + frag_idx2 + frag_count2 + frame_len4
/// + at8 + cap2 + enc2 + w4 + h4
pub const HEADER: usize = 34;
/// 重组器里不完整帧的存活时间：超过即弃（早就过时了）。
const REASM_TTL_MS: u64 = 400;
/// 出洞宽限期：非关键帧出洞后先等这么久（缓存乱序帧），洞补上就续播；
/// 过期才判 corrupt。50ms ≈ 120fps 下 6 帧的重排窗口，只影响「判死」延迟。
const HOLE_GRACE_MS: u64 = 50;
/// 缓冲中的帧数上限（含不完整帧）：恶意/异常对端不能把内存撑爆。
/// 🔴 再审计 P3-4（2026-09-25）：帧槽改为按需存储（见 [`FrameReasm::frags`]）
/// 之后，每帧内存**正比于实际收到的分片数**，不再有「按声明 frag_count 预分配」
/// 的放大面；MAP_MAX 仍兜住「帧数 × 每帧元数据 + 已收分片」的总量。
const MAP_MAX: usize = 96;
/// 单帧分片数上限。`frag_count` 取自**线上包**。P3-4 后内存不再随它放大，
/// 但仍要夹住：`total`（数据槽+奇偶槽）的算术、`try_recover` 的组定位、以及
/// 完整性逐片扫描的工作量上界，都随 frag_count 线性走。
/// 正常帧远低于此：8MB 单包上限 ÷ 1000B ≈ 8193，取 16384 留一倍余量。
const MAX_FRAG_COUNT: u16 = 16_384;
/// 重组时 `Vec::with_capacity(frame_len)` 的硬上限（P0-1）。
///
/// `frame_len` 是**线上 u32**，不夹住就能声明 0xFFFF_FFFF 让 `drain_ready`
/// 直接 `with_capacity(4GiB)` 远程 OOM。取 16MB：视频侧单帧上限
/// [`super::video::MAX_H264_BYTES`] 是 8MB，留一倍余量给 HEVC / 将来档位。
const MAX_REASM_BYTES: usize = 16 * 1024 * 1024;

/// 声明帧长是否合法。纯函数，**分配前**必须调用（P0-1）。
///
/// 三条一起判的原因：
/// 1. `frame_len == 0`：空帧声明没有意义，且会让完整性判据退化；
/// 2. `> MAX_REASM_BYTES`：挡住 `with_capacity` 被线上 u32 放大；
/// 3. `> frag_count * FRAG`：分片槽位的物理上界装不下声明长度 = 脏包
///    （即便前两条侥幸通过，`drain_ready` 也会因字节数不符报废整帧，
///    但那已经分配过一次了——必须在入口拦）。
fn frame_len_ok(frame_len: u32, frag_count: u16) -> bool {
    let fl = frame_len as usize;
    if frame_len == 0 || fl > MAX_REASM_BYTES {
        return false;
    }
    fl <= frag_count as usize * FRAG
}

/// flags 位。
const FLAG_KEY: u8 = 1;
const FLAG_PARITY: u8 = 2;
/// Q3：帧的编码标准（H.264 缺省；置位 = HEVC）。老字段宽度的 flags 位空着
/// 正好复用——头长度不变，旧接收端只是认不出这个位（也不会选 HEVC 档）。
const FLAG_HEVC: u8 = 4;

/// 发送端序号与状态。
///
/// 🔴 序号从 **1** 起（`new` 初始化，不用 `Default` 的 0）：线上的 `sq=0`
/// 被接收端定义为「旧对端的无序号帧」（`outbound.rs` 的锚定判据是
/// `key && sq > 0`）。曾从 0 起会让**会话第一个流关键帧（恰为 sq=0）被
/// 当作无序号跳过**，首 GOP 的数据报 P 帧全部滞留缓存，直到第二个 GOP
/// 的关键帧才锚定交付——每场会话首帧后冻结约 1s（2026-09-19 审查 P2）。
pub struct VidDgramSender {
    next_seq: u32,
}

/// 发送失败的两种语义——调用方处置不同：
/// - [`SendErr::Busy`]：一个分片都没发出去。关键帧可回退可靠流；
/// - [`SendErr::Dropped`]：已发出部分分片。整帧在接收端注定不完整，
///   **绝不能**再用流重发（接收端会收到两份同 seq 帧）——只能弃帧走自愈。
#[derive(Debug)]
pub enum SendErr {
    Busy,
    Dropped(String),
}

impl Default for VidDgramSender {
    fn default() -> Self {
        Self { next_seq: 1 }
    }
}

impl VidDgramSender {
    pub fn new() -> Self {
        Self::default()
    }

    /// 取走下一个帧序号。**每帧恰消耗一个**（无论最终走数据报还是可靠流）：
    /// 接收端的重组器按同一把尺子排序/重置，序号空转 = 接收端看到的洞 = 自愈。
    ///
    /// 🔴 回绕跳过 0：那是「旧对端无序号」的保留值，永不发出。
    pub fn take_seq(&mut self) -> u32 {
        let s = self.next_seq;
        self.next_seq = self.next_seq.wrapping_add(1);
        if self.next_seq == 0 {
            self.next_seq = 1;
        }
        s
    }

    /// 发一帧（分片 + FEC）。`at_ms` = 采集时刻，`cap`/`enc` = 采集/编码耗时（P0-2 分段），
    /// `w`/`h` = 编码分辨率（解码器配置兜底用），`hevc` = 编码标准（Q3，随帧标注）。
    #[allow(clippy::too_many_arguments)]
    pub fn send_frame(
        &mut self,
        conn: &iroh::endpoint::Connection,
        seq: u32,
        data: &[u8],
        key: bool,
        at_ms: i64,
        cap_ms: u16,
        enc_ms: u16,
        w: u32,
        h: u32,
        hevc: bool,
    ) -> Result<(), SendErr> {
        let dgs = frame_dgrams(seq, data, key, at_ms, cap_ms, enc_ms, w, h, hevc);
        let frag_count = data.len().div_ceil(FRAG).max(1) as u16;
        let n_groups = frag_count.div_ceil(GROUP as u16) as usize;
        let need = (frag_count as usize + n_groups) * (HEADER + FRAG);
        if conn.datagram_send_buffer_space() < need {
            return Err(SendErr::Busy);
        }
        for dg in &dgs {
            conn.send_datagram(dg.clone().into())
                .map_err(|e| SendErr::Dropped(format!("分片发送失败：{e}")))?;
        }
        Ok(())
    }
}

/// 把一帧拆成数据报（数据片 + 奇偶片）。纯函数——重组器测试用同一份逻辑。
#[allow(clippy::too_many_arguments)]
fn frame_dgrams(
    seq: u32,
    data: &[u8],
    key: bool,
    at_ms: i64,
    cap_ms: u16,
    enc_ms: u16,
    w: u32,
    h: u32,
    hevc: bool,
) -> Vec<Vec<u8>> {
    let frag_count = data.len().div_ceil(FRAG).max(1) as u16;
    let n_groups = frag_count.div_ceil(GROUP as u16) as usize;
    let flags = if key { FLAG_KEY } else { 0 } | if hevc { FLAG_HEVC } else { 0 };
    let build = |frag_idx: u16, flags: u8, payload: &[u8]| -> Vec<u8> {
        let mut dg = Vec::with_capacity(HEADER + payload.len());
        dg.push(DGRAM_TAG);
        dg.extend_from_slice(&seq.to_le_bytes());
        dg.push(flags);
        dg.extend_from_slice(&frag_idx.to_le_bytes());
        dg.extend_from_slice(&frag_count.to_le_bytes());
        dg.extend_from_slice(&(data.len() as u32).to_le_bytes());
        dg.extend_from_slice(&at_ms.to_le_bytes());
        dg.extend_from_slice(&cap_ms.to_le_bytes());
        dg.extend_from_slice(&enc_ms.to_le_bytes());
        dg.extend_from_slice(&w.to_le_bytes());
        dg.extend_from_slice(&h.to_le_bytes());
        dg.extend_from_slice(payload);
        dg
    };
    let mut out = Vec::with_capacity(frag_count as usize + n_groups);
    for i in 0..frag_count {
        let off = i as usize * FRAG;
        let end = (off + FRAG).min(data.len());
        out.push(build(i, flags, &data[off..end]));
    }
    // 奇偶分片：XOR 组内各片（补零对齐）
    for g in 0..n_groups {
        let start = g * GROUP;
        let end = (((start + GROUP) as u16).min(frag_count)) as usize;
        let plen = (start..end)
            .map(|i| (data.len() - i * FRAG).min(FRAG))
            .max()
            .unwrap_or(0);
        let mut parity = vec![0u8; plen];
        for i in start..end {
            let off = i * FRAG;
            let f = &data[off..(off + FRAG).min(data.len())];
            for (b, s) in parity.iter_mut().zip(f.iter()) {
                *b ^= s;
            }
        }
        out.push(build(frag_count + g as u16, flags | FLAG_PARITY, &parity));
    }
    out
}

/// 一帧重组完成。
pub struct ReasmFrame {
    pub key: bool,
    pub data: Vec<u8>,
    pub at_ms: i64,
    pub cap_ms: u16,
    pub enc_ms: u16,
    pub width: u32,
    pub height: u32,
    /// Q3：编码标准随帧走（H.264/HEVC），不做跨通道状态推断。
    pub codec: FrameCodec,
}

struct FrameReasm {
    key: bool,
    codec: FrameCodec,
    frag_count: u16,
    frame_len: u32,
    at_ms: i64,
    cap_ms: u16,
    enc_ms: u16,
    width: u32,
    height: u32,
    /// 🔴 再审计 P3-4（2026-09-25）：分片槽**按需存储**——键 = 槽位号（数据槽
    /// `0..frag_count`，奇偶槽 `[frag_count, total)`），收到一片才存一片。
    /// 原先是 `Vec<Option<Vec<u8>>>` 按声明 `frag_count + groups` 预分配：
    /// 34B 畸形头声明 frag_count=16384 即得 ~490KB 空槽，乘 MAP_MAX=96 放大到
    /// ~47MB。按需存储后内存正比于实际收到的分片数——攻击者必须真发字节
    /// 才能撑大内存。完整性与交付语义不变（见 `data_complete` / `drain_ready`）。
    frags: std::collections::HashMap<usize, Vec<u8>>,
    created: std::time::Instant,
}

impl FrameReasm {
    /// 数据槽 `[0, frag_count)` 是否全部就位（奇偶槽不计入完整性——它只是
    /// 恢复用的冗余，语义与旧 `frags[..frag_count].iter().all(is_some)` 等价）。
    fn data_complete(&self, frag_count: usize) -> bool {
        (0..frag_count).all(|i| self.frags.contains_key(&i))
    }
}

/// 接收端重组器：严格按 seq 交付（P 帧链不容重排）。
pub struct VidReassembler {
    map: std::collections::HashMap<u32, FrameReasm>,
    next_seq: u32,
    started: bool,
    /// 关键帧还一帧没见过（含流路径）：P 帧一律拦下（没有解码基准）。
    await_first_key: bool,
    /// 丢过非关键帧 → 引用链已断，拦下后续 P 帧直到下一个关键帧。
    corrupt: bool,
    /// 出洞时刻：宽限期内缓存乱序帧等洞补上，过期才跳帧（HOLE_GRACE_MS）。
    hole_since: Option<std::time::Instant>,
    /// 引用链刚从好变坏（corrupt 落下的那一拍）。调用方 take_damaged 后据此
    /// 向被控端发 request_key——见模块文档「丢帧必须喊话」。
    damaged: bool,
    last_gc: std::time::Instant,
}

impl Default for VidReassembler {
    fn default() -> Self {
        Self {
            map: std::collections::HashMap::new(),
            next_seq: 0,
            started: false,
            await_first_key: true,
            corrupt: false,
            hole_since: None,
            damaged: false,
            last_gc: std::time::Instant::now(),
        }
    }
}

pub enum ResetReason {
    /// 走可靠流的关键帧到了（seq 随 meta JSON 带过来）。
    StreamKey(u32),
}

impl VidReassembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// 走流的关键帧到达：以它为锚重置序号，然后**按序补交付已缓冲的完整帧**。
    /// 其后已到的数据报 P 帧仍然有效（引用的是这个关键帧之后的状态），不能误删。
    pub fn reset_after_stream_key(&mut self, seq: u32) -> Vec<ReasmFrame> {
        self.started = true;
        self.await_first_key = false;
        // 清掉序号严格小于锚的滞留帧（它们引用的是更早的状态）
        self.map.retain(|s, _| !seq_wrapped_lt(*s, seq));
        self.next_seq = seq.wrapping_add(1);
        self.corrupt = false;
        self.hole_since = None;
        self.drain_ready()
    }

    /// 取走「引用链刚断裂」信号（一次性）。调用方应向被控端发 request_key。
    pub fn take_damaged(&mut self) -> bool {
        std::mem::replace(&mut self.damaged, false)
    }

    fn group_count(frag_count: u16) -> u16 {
        frag_count.div_ceil(GROUP as u16)
    }

    /// 喂一个数据报。交付完成帧时返回它们——游标帧完成之外还会**级联**补交付
    /// 其后已缓冲完整的帧（严格顺序下可能一次多帧，见 drain_ready）。
    pub fn feed(&mut self, dg: &[u8]) -> Vec<ReasmFrame> {
        self.feed_inner(dg).unwrap_or_default()
    }

    fn feed_inner(&mut self, dg: &[u8]) -> Option<Vec<ReasmFrame>> {
        let mut out = Vec::new();
        if dg.len() < HEADER || dg[0] != DGRAM_TAG {
            return None;
        }
        let seq = u32::from_le_bytes(dg[1..5].try_into().ok()?);
        let flags = dg[5];
        let frag_idx = u16::from_le_bytes(dg[6..8].try_into().ok()?);
        let frag_count = u16::from_le_bytes(dg[8..10].try_into().ok()?);
        let frame_len = u32::from_le_bytes(dg[10..14].try_into().ok()?);
        let at_ms = i64::from_le_bytes(dg[14..22].try_into().ok()?);
        let cap_ms = u16::from_le_bytes(dg[22..24].try_into().ok()?);
        let enc_ms = u16::from_le_bytes(dg[24..26].try_into().ok()?);
        let width = u32::from_le_bytes(dg[26..30].try_into().ok()?);
        let height = u32::from_le_bytes(dg[30..34].try_into().ok()?);
        let payload = &dg[HEADER..];
        // M6 脏包防御：单片载荷不可能超过承载上限（正常分片 ≤1000B）
        if payload.len() > FRAG {
            return None;
        }
        // 🔴 脏包防御 ③（P0-1）：`frame_len` 夹上限。必须在**任何分配与
        // 状态推进之前**——`drain_ready` 会 `Vec::with_capacity(frame_len)`，
        // 线上 u32 不夹就是远程 OOM。与下面的 `MAX_FRAG_COUNT` 同一类问题。
        if !frame_len_ok(frame_len, frag_count) {
            return None;
        }
        let parity = flags & FLAG_PARITY != 0;
        let key = flags & FLAG_KEY != 0;
        let codec = if flags & FLAG_HEVC != 0 {
            FrameCodec::Hevc
        } else {
            FrameCodec::H264
        };
        self.gc();

        // 过时 / 重复帧
        if self.started && seq_wrapped_lt(seq, self.next_seq) {
            return None;
        }

        // P 帧在见到任何关键帧之前没有解码基准：**缓存不交付**（交付条件里有
        // await_first_key 门槛）。走流的关键帧被拥塞延迟时，先到的数据报 P 帧
        // 大多是锚之后合法的 P 帧——锚一到位就按序补交付，不再整段作废。
        // 锚由可靠流保证必达，这里不置 damage 信号。

        if !self.started {
            self.started = true;
            self.next_seq = seq;
            if key {
                self.await_first_key = false;
            } else {
                // 第一个见到的帧不是关键帧：没有解码基准，缓存但拦交付
                self.corrupt = true;
            }
        } else if seq != self.next_seq {
            // 出洞：seq > next_seq（过时已滤）。关键帧永远可以当新锚；
            // P 帧先给宽限期（缓存乱序帧等洞补上），过期才跳帧判 corrupt。
            if key {
                self.map.retain(|s, _| !seq_wrapped_lt(*s, seq));
                self.next_seq = seq;
                self.corrupt = false;
                self.hole_since = None;
            } else if !self.corrupt {
                let expired = match self.hole_since {
                    Some(t) => t.elapsed().as_millis() >= HOLE_GRACE_MS as u128,
                    None => {
                        self.hole_since = Some(std::time::Instant::now());
                        false
                    }
                };
                if expired {
                    // 引用链确实断了：跳到新帧，之前的滞留帧一并作废
                    self.map.retain(|s, _| !seq_wrapped_lt(*s, seq));
                    self.next_seq = seq;
                    self.corrupt = true;
                    self.damaged = true;
                    self.hole_since = None;
                }
            }
            // corrupt 期间 / 宽限期内到达的 P 帧：照常缓存（下面统一 insert），
            // 交付被拦——锚定关键帧到达后按序补交付。
        }

        // 🔴 脏包防御 ①：分片数上界。`frag_count` 取自**线上包**；P3-4 后分片槽
        // 按需存储、内存不再随它放大，但仍夹住 `total` 算术 / `try_recover` 组定位
        // / 完整性扫描的工作量上界（见 `MAX_FRAG_COUNT` 的注释）。
        if frag_count == 0 || frag_count > MAX_FRAG_COUNT {
            return None;
        }
        let slot = frag_idx as usize;
        let total = frag_count as usize + Self::group_count(frag_count) as usize;
        // 🔴 脏包防御 ②：`FLAG_PARITY` 必须与槽位**自洽**——奇偶片的 frag_idx
        // 只能落在 `[frag_count, total)`。此前不校验会让同一个畸形包两次得逞：
        //   ① 奇偶数据被写进**数据槽**（`frags[slot]`），`complete()` 因而把
        //      注定不完整的帧判成完整（引用链白断一次 + 多余的 request_key）；
        //   ② 同一条件走进 `try_recover`，`parity_slot - frag_count` 无符号下溢
        //      —— debug 构建直接 panic 掉接收任务（画面永久冻结且无提示）。
        if parity != (slot >= frag_count as usize) {
            return None;
        }
        if slot >= total {
            return None;
        }
        if self.map.len() >= MAP_MAX && !self.map.contains_key(&seq) {
            return None; // 缓冲上限：宁丢新帧不撑内存
        }
        let reasm = self.map.entry(seq).or_insert_with(|| FrameReasm {
            key,
            codec,
            frag_count,
            frame_len,
            at_ms,
            cap_ms,
            enc_ms,
            width,
            height,
            // 🔴 再审计 P3-4：空表起步、到一片存一片——不在分配路径上按声明的
            // frag_count 预留任何槽位（攻击面见 `FrameReasm::frags` 的注释）。
            frags: std::collections::HashMap::new(),
            created: std::time::Instant::now(),
        });
        if reasm.frag_count != frag_count || reasm.frame_len != frame_len || reasm.codec != codec {
            return None; // 同 seq 但元数据矛盾：丢弃脏包
        }
        // 🔴 再审计 P3-4：按需落位。`or_insert` 保住旧语义「先到先得」——同槽位
        // 重复/重排到达的分片不覆盖已存内容；每个槽位的存储代价由该片的线上
        // 字节（≥34B 头）支付，无放大。
        reasm.frags.entry(slot).or_insert_with(|| payload.to_vec());
        // reasm 的 map 借用到此为止；完整性检查走独立查询
        let complete = |map: &std::collections::HashMap<u32, FrameReasm>| -> bool {
            map.get(&seq)
                .map(|r| r.data_complete(frag_count as usize))
                .unwrap_or(false)
        };
        // 奇偶片到 → 尝试恢复组内缺失
        if !complete(&self.map) && parity {
            self.try_recover(seq, frag_count, slot);
        }
        // 交付条件：恰是游标帧、已完整、引用链有效（corrupt 中只放关键帧）、
        // 且已见过关键帧（await_first_key 期间的缓存留给锚定后补交付）
        if seq == self.next_seq
            && complete(&self.map)
            && !self.await_first_key
            && (!self.corrupt || key)
        {
            out.extend(self.drain_ready());
        }
        Some(out)
    }

    /// 从游标起级联交付所有已完整的缓冲帧（严格按 seq 序）。
    /// 每交一帧游标进一格、corrupt 解除——锚定后的补交付就走这里。
    fn drain_ready(&mut self) -> Vec<ReasmFrame> {
        let mut out = Vec::new();
        loop {
            // 🔴 再审计 P3-4：完整性判据经 `data_complete`（按需存储后的等价形式）
            let ready = match self.map.get(&self.next_seq) {
                Some(r) => r.data_complete(r.frag_count as usize),
                None => false,
            };
            if !ready {
                break;
            }
            let reasm = self.map.remove(&self.next_seq).expect("刚检查过存在");
            self.hole_since = None;
            self.corrupt = false;
            // 入口 `frame_len_ok` 已夹过；这里仍按声明长度分配——它等于
            // 各片真实长度之和的校验在下面，不符即报废。
            let mut data = Vec::with_capacity(reasm.frame_len as usize);
            for i in 0..reasm.frag_count as usize {
                data.extend_from_slice(reasm.frags.get(&i).map_or(&[][..], |v| v.as_slice()));
            }
            if data.len() != reasm.frame_len as usize {
                // M6：分片拼出的字节数与声明的帧长不符 = 脏帧。引用链从此不可信，
                // 拦到下一个关键帧（下一帧 feed 的洞处理 / 锚定负责恢复）。
                self.corrupt = true;
                self.damaged = true;
                self.next_seq = self.next_seq.wrapping_add(1);
                break;
            }
            self.next_seq = self.next_seq.wrapping_add(1);
            out.push(ReasmFrame {
                key: reasm.key,
                codec: reasm.codec,
                data,
                at_ms: reasm.at_ms,
                cap_ms: reasm.cap_ms,
                enc_ms: reasm.enc_ms,
                width: reasm.width,
                height: reasm.height,
            });
        }
        out
    }

    /// 用奇偶片恢复组内恰好缺 1 片的情况。
    fn try_recover(&mut self, seq: u32, frag_count: u16, parity_slot: usize) {
        let Some(reasm) = self.map.get_mut(&seq) else {
            return;
        };
        // 🔴 纵深防御：调用方（`feed_inner`）已校验过「置 PARITY 位的包其 frag_idx
        // 必落在 [frag_count, total)」，这里仍用 `checked_sub` —— **不依赖上游的
        // 不变量成立**。否则一旦上游判据被人改动或将来新增调用点，这里就是 usize
        // 下溢：debug 构建直接 panic（接收任务死、画面永久冻结），release 静默 wrap
        // ——两条路都不是我们要的。
        let Some(g) = parity_slot.checked_sub(frag_count as usize) else {
            return;
        };
        let start = g * GROUP;
        let end = (((start + GROUP) as u16).min(frag_count)) as usize;
        // 🔴 再审计 P3-4：`contains_key` 取代旧的 `is_none()`（按需存储的等价形式）
        let missing: Vec<usize> = (start..end).filter(|i| !reasm.frags.contains_key(i)).collect();
        if missing.len() != 1 {
            return;
        }
        let Some(parity) = reasm.frags.get(&parity_slot).cloned() else {
            return;
        };
        let mut rec = parity;
        for i in start..end {
            if i == missing[0] {
                continue;
            }
            if let Some(f) = reasm.frags.get(&i) {
                for (b, s) in rec.iter_mut().zip(f.iter()) {
                    *b ^= s;
                }
            }
        }
        // 恢复出的是补零对齐的内容；截到该片真实长度（按 frame_len 与片序推出）
        let mi = missing[0];
        let flen = (reasm.frame_len as usize)
            .saturating_sub(mi * FRAG)
            .min(FRAG);
        rec.truncate(flen);
        reasm.frags.insert(mi, rec);
    }

    fn gc(&mut self) {
        let now = std::time::Instant::now();
        if now
            .duration_since(self.last_gc)
            .as_millis()
            < (REASM_TTL_MS / 2) as u128
        {
            return;
        }
        self.last_gc = now;
        self.map
            .retain(|_, r| now.duration_since(r.created).as_millis() < REASM_TTL_MS as u128);
    }
}

/// seq 环绕感知的小于比较（简单取半环判断，会话内 seq 不至于跨半环）。
fn seq_wrapped_lt(a: u32, b: u32) -> bool {
    let d = a.wrapping_sub(b);
    d > u32::MAX / 2
}

#[cfg(test)]
mod tests;
