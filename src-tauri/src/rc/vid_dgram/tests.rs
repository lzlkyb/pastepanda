//! `vid_dgram.rs` 的单元测试（从原文件尾部的 mod tests 原样平移）。

use super::*;

fn dgrams(seq: u32, data: &[u8], key: bool) -> Vec<Vec<u8>> {
    frame_dgrams(seq, data, key, 1_758_000_000_000, 3, 5, 1920, 1080, false)
}

/// 喂一批片，返回期间交付的全部帧。
fn feed_all(r: &mut VidReassembler, dgs: &[Vec<u8>]) -> Vec<ReasmFrame> {
    let mut got = Vec::new();
    for dg in dgs {
        got.extend(r.feed(dg));
    }
    got
}

#[test]
fn 分片重组往返_数据一致() {
    // 2.5KB：2 整片 + 1 短尾片，覆盖尾片长度逻辑
    let data: Vec<u8> = (0..2500u32).map(|i| (i % 251) as u8).collect();
    let dgs = dgrams(7, &data, true);
    assert_eq!(dgs.len(), 3 + 1, "3 数据片 + 1 奇偶片");
    let mut r = VidReassembler::new();
    let got = feed_all(&mut r, &dgs);
    assert_eq!(got.len(), 1, "全部片到达应交付一帧");
    let f = &got[0];
    assert!(f.key);
    assert_eq!(f.data, data);
    assert_eq!((f.width, f.height), (1920, 1080));
    assert_eq!(f.cap_ms, 3);
    assert_eq!(f.enc_ms, 5);
}

#[test]
fn 奇偶片恢复组内丢一片() {
    let data: Vec<u8> = (0..3500u32).map(|i| (i % 253) as u8).collect();
    let dgs = dgrams(1, &data, true);
    let mut r = VidReassembler::new();
    // 丢掉第 0 片（第 0 组），奇偶片应在到齐后把它补回来
    let mut got = Vec::new();
    for (i, dg) in dgs.iter().enumerate() {
        if i == 0 {
            continue;
        }
        got.extend(r.feed(dg));
    }
    assert_eq!(got.len(), 1, "丢 1 片应由奇偶片恢复并交付");
    assert_eq!(got[0].data, data, "FEC 恢复后的帧必须与原始一致");
}

#[test]
fn 组内丢两片整帧报废_corrupt等关键帧() {
    let data: Vec<u8> = (0..3500u32).map(|i| (i % 253) as u8).collect();
    let mut r = VidReassembler::new();
    // 先交付一个关键帧建立基准
    assert_eq!(feed_all(&mut r, &dgrams(0, &data, true)).len(), 1);
    // P 帧（seq 1）丢 2 片 → 注定不完整；其后 P 帧（seq 2）在宽限期内缓存不交付
    let p1 = dgrams(1, &data, false);
    for (i, dg) in p1.iter().enumerate() {
        if i != 0 && i != 1 {
            assert!(r.feed(dg).is_empty());
        }
    }
    for dg in &dgrams(2, &data, false) {
        assert!(
            r.feed(dg).is_empty(),
            "引用链断掉后的 P 帧必须被拦截（花屏防线）"
        );
    }
    // 宽限还没过：P2 是被缓存的，没被丢——洞（seq 1）此刻还在等
    // 关键帧（seq 3）到达：恢复交付
    let mut got = feed_all(&mut r, &dgrams(3, &data, true));
    assert_eq!(got.len(), 1);
    assert!(got[0].key, "关键帧必须能重新起链");
    // 其后 P 帧正常交付
    got = feed_all(&mut r, &dgrams(4, &data, false));
    assert_eq!(got.len(), 1);
}

#[test]
fn 乱序到达不交付_到齐才按序出() {
    let data: Vec<u8> = (0..1200u32).map(|i| (i % 97) as u8).collect();
    let dgs = dgrams(9, &data, true);
    assert_eq!(dgs.len(), 3, "2 数据片 + 1 奇偶片");
    let mut r = VidReassembler::new();
    // 先给奇偶片 + 第 0 片：不应交付
    assert!(r.feed(&dgs[2]).is_empty());
    assert!(r.feed(&dgs[0]).is_empty());
    // 第 1 片到：交付
    let got = r.feed(&dgs[1]);
    assert_eq!(got.len(), 1, "到齐即交付");
    assert_eq!(got[0].data, data);
}

#[test]
fn 跨帧乱序_宽限期内缓存_洞补上级联续播() {
    // 审查 D1/D2 的核心场景：seq1 慢了、seq2 先到。宽限期内必须缓存 seq2
    // 等 seq1，而不是跳帧把整个 GOP 炸掉。
    let data: Vec<u8> = vec![7u8; 1500];
    let mut r = VidReassembler::new();
    assert_eq!(feed_all(&mut r, &dgrams(0, &data, true)).len(), 1);
    // seq2 先到：出洞 → 进宽限，缓存
    assert!(feed_all(&mut r, &dgrams(2, &data, false)).is_empty());
    // seq1 后到：交付 1，并级联补交付 2
    let got = feed_all(&mut r, &dgrams(1, &data, false));
    assert_eq!(got.len(), 2, "洞补上后应按序交付 seq1、seq2");
    assert!(!got[0].key && !got[1].key);
    // 无损伤发生（乱序 ≠ 丢包，不该喊 request_key）
    assert!(!r.take_damaged());
    // seq3 正常续播
    assert_eq!(feed_all(&mut r, &dgrams(3, &data, false)).len(), 1);
}

#[test]
fn 宽限过期才跳帧_置damage信号_锚定后恢复() {
    let data: Vec<u8> = vec![7u8; 1500];
    let mut r = VidReassembler::new();
    assert_eq!(feed_all(&mut r, &dgrams(0, &data, true)).len(), 1);
    // seq1 只到一片（其余真丢了）
    let p1 = dgrams(1, &data, false);
    assert!(r.feed(&p1[0]).is_empty());
    // 宽限期内 seq2 先到：缓存，不跳帧
    assert!(feed_all(&mut r, &dgrams(2, &data, false)).is_empty());
    assert!(!r.take_damaged(), "宽限期内不算丢包");
    // 过了宽限期 seq3 才到：判定引用链断裂，跳帧 + damage 信号
    std::thread::sleep(std::time::Duration::from_millis(HOLE_GRACE_MS + 20));
    assert!(feed_all(&mut r, &dgrams(3, &data, false)).is_empty());
    assert!(r.take_damaged(), "跳帧必须置 damage（调用方发 request_key）");
    assert!(!r.take_damaged(), "damage 信号一次性");
    // 走流的关键帧锚定 → 恢复交付
    assert_eq!(feed_all(&mut r, &dgrams(5, &data, true)).len(), 1);
    assert_eq!(feed_all(&mut r, &dgrams(6, &data, false)).len(), 1);
}

#[test]
fn 流关键帧锚定后补交付已缓冲帧() {
    // 审查 D2：走流的关键帧被拥塞延迟，数据报 P 帧先到——过去这些帧
    // 会被级联丢弃；现在缓存到锚定后按序补交付。
    let data: Vec<u8> = vec![9u8; 1500];
    let mut r = VidReassembler::new();
    // 首帧不是关键帧：缓存（无基准不交付；锚由可靠流保证必达，不喊话）
    assert!(feed_all(&mut r, &dgrams(1, &data, false)).is_empty());
    // 走流的关键帧（seq 0）到达 → 锚定 → seq1 按序补交付
    let got = r.reset_after_stream_key(0);
    assert_eq!(got.len(), 1, "锚定后缓冲完整的 seq1 应立即补交付");
    assert!(!got[0].key);
    // 其后流关键帧再锚，数据报 P 帧正常续
    assert!(r.reset_after_stream_key(2).is_empty());
    assert_eq!(feed_all(&mut r, &dgrams(3, &data, false)).len(), 1);
}

#[test]
fn corrupt期间到达的帧缓存到锚定() {
    let data: Vec<u8> = vec![3u8; 1500];
    let mut r = VidReassembler::new();
    assert_eq!(feed_all(&mut r, &dgrams(0, &data, true)).len(), 1);
    // seq1 一片都不来（真丢）；宽限过期后 seq2 跳帧判 corrupt
    std::thread::sleep(std::time::Duration::from_millis(HOLE_GRACE_MS + 20));
    assert!(feed_all(&mut r, &dgrams(2, &data, false)).is_empty());
    // corrupt 期间 seq3 到：缓存（旧实现直接丢弃），不交付
    assert!(feed_all(&mut r, &dgrams(3, &data, false)).is_empty());
    // 锚定 seq4 后：seq3 已被跳帧 retain 作废（seq3 > 锚? 否——seq3 < 4 被清），
    // 游标到 5
    let got = r.reset_after_stream_key(4);
    assert!(got.is_empty(), "跳帧前作废的滞留帧不补交付");
    assert_eq!(feed_all(&mut r, &dgrams(5, &data, false)).len(), 1);
}

#[test]
fn 脏包_载荷超上限被拒() {
    let data: Vec<u8> = vec![1u8; 1500];
    let mut r = VidReassembler::new();
    let mut dg = dgrams(0, &data, true)[0].clone();
    dg.push(0xFF); // 1001B 载荷 > FRAG
    assert!(r.feed(&dg).is_empty());
    // 正常片不受影响
    assert_eq!(feed_all(&mut r, &dgrams(0, &data, true)).len(), 1);
}

/// 手工拼一个数据报（造畸形包用）。字段布局见 `HEADER` 的注释。
fn build_dg(
    seq: u32,
    flags: u8,
    frag_idx: u16,
    frag_count: u16,
    frame_len: u32,
    payload: &[u8],
) -> Vec<u8> {
    let mut dg = Vec::new();
    dg.push(DGRAM_TAG);
    dg.extend_from_slice(&seq.to_le_bytes());
    dg.push(flags);
    dg.extend_from_slice(&frag_idx.to_le_bytes());
    dg.extend_from_slice(&frag_count.to_le_bytes());
    dg.extend_from_slice(&frame_len.to_le_bytes());
    dg.extend_from_slice(&0i64.to_le_bytes()); // at_ms
    dg.extend_from_slice(&0u16.to_le_bytes()); // cap_ms
    dg.extend_from_slice(&0u16.to_le_bytes()); // enc_ms
    dg.extend_from_slice(&1920u32.to_le_bytes());
    dg.extend_from_slice(&1080u32.to_le_bytes());
    dg.extend_from_slice(payload);
    dg
}

/// 🔴 审查 2026-09-22 D2/D3：置 `FLAG_PARITY` 却用**数据槽** frag_idx 的畸形包
/// 必须被拒，且**不得**触发 `parity_slot - frag_count` 下溢。
///
/// 修复前：同一个包既会把奇偶数据写进数据槽（`complete()` 误判完整），
/// 又会走进 `try_recover` 让 usize 下溢 —— debug 构建直接 panic 掉接收任务。
#[test]
fn 畸形奇偶片_槽位不自洽必须被拒且不下溢() {
    let data: Vec<u8> = (0..2500u32).map(|i| (i % 251) as u8).collect();
    let mut r = VidReassembler::new();
    assert_eq!(feed_all(&mut r, &dgrams(0, &data, true)).len(), 1);
    // frag_count = 3（数据槽 0..3、奇偶槽 3..4），却谎称 frag_idx = 0 是奇偶片
    let bad = build_dg(1, FLAG_PARITY, 0, 3, 2500, &[0xAA; 100]);
    assert!(r.feed(&bad).is_empty(), "槽位不自洽的包必须被丢弃（且不得 panic）");
    // 反向不自洽：frag_idx 落在奇偶槽却**没**置 PARITY 位
    let bad2 = build_dg(1, 0, 3, 3, 2500, &[0xBB; 100]);
    assert!(r.feed(&bad2).is_empty(), "奇偶槽却没标 PARITY：同样不自洽");
    // 正常包不受影响：合法分片仍能走完并交付
    assert_eq!(feed_all(&mut r, &dgrams(3, &data, true)).len(), 1);
}

/// 🔴 审查 2026-09-22 D4：畸形 `frag_count` 不得放大分配（`MAX_FRAG_COUNT` 上界）。
#[test]
fn 脏包_分片数超上界被拒() {
    let data: Vec<u8> = vec![1u8; 1500];
    let mut r = VidReassembler::new();
    assert_eq!(feed_all(&mut r, &dgrams(0, &data, true)).len(), 1);
    // 修复前：`frag_count = u16::MAX` 会分配 ~81919 个槽（≈2MB/帧）
    let bad = build_dg(1, 0, 0, u16::MAX, 8 << 20, &[0xCC; 100]);
    assert!(r.feed(&bad).is_empty(), "frag_count 超上界必须被拒");
    // frag_count = 0 同样非法（会让 total 退化成 0，slot 校验失去意义）
    let zero = build_dg(1, 0, 0, 0, 0, &[]);
    assert!(r.feed(&zero).is_empty(), "frag_count = 0 必须被拒");
    // 正常帧不受影响
    assert_eq!(feed_all(&mut r, &dgrams(1, &data, true)).len(), 1);
}

/// 🔴 再审计 P3-4（2026-09-25）：分片槽必须**按需**存储——收到 1 片只存 1 片，
/// 不得按声明的 `frag_count + groups` 预分配/放大。原先是 `Vec<Option<Vec<u8>>>`
/// 预分配：34B 畸形头声明 frag_count=16384 即得 ~490KB 空槽，乘 MAP_MAX=96
/// 放大到 ~47MB；一个只声明高位槽位的单片就能撑出全部空槽。
#[test]
fn 脏包_声明大帧_单片到达_存储不放大() {
    // frag_count 取 MAX_FRAG_COUNT 满配、frame_len 恰好 ≤ frag_count*FRAG 且
    // ≤ MAX_REASM_BYTES——三重判定（frame_len_ok）全过的最大畸形声明。
    let fc = MAX_FRAG_COUNT;
    let total = (fc + fc.div_ceil(GROUP as u16)) as usize;
    let bad = build_dg(
        7,
        FLAG_PARITY,
        (total - 1) as u16, // 合法奇偶槽位（自洽判定也过）
        fc,
        (fc as usize * FRAG) as u32,
        &[0xEE; 100],
    );
    let mut r = VidReassembler::new();
    assert!(r.feed(&bad).is_empty(), "孤片不完整，不得交付");
    assert_eq!(
        r.map.get(&7).map(|f| f.frags.len()),
        Some(1),
        "收到 1 片只应存 1 片，存储量不得随声明的 frag_count 放大"
    );
    // 交付语义不受影响：走流的关键帧锚定后，真正到齐的帧照常补交付
    //（首片非关键帧 → await_first_key 拦交付，锚定只能来自可靠流，与既有
    // `流关键帧锚定后补交付已缓冲帧` 测试同一条路径）
    let data: Vec<u8> = (0..2500u32).map(|i| (i % 251) as u8).collect();
    assert!(feed_all(&mut r, &dgrams(9, &data, false)).is_empty(), "锚定前 P 帧不交付");
    let got = r.reset_after_stream_key(8);
    assert_eq!(got.len(), 1, "锚定后缓冲完整的 seq9 应立即补交付");
    assert!(r.map.get(&7).is_none(), "锚定保留应清掉滞留的脏帧");
}

/// 🔴 P0-1：`frame_len` 纯函数边界——0 / u32::MAX / 超过 frag_count*FRAG 全拒。
#[test]
fn frame_len_ok_三条边界全拒() {
    assert!(!frame_len_ok(0, 1), "frame_len=0 必须拒");
    assert!(!frame_len_ok(u32::MAX, 1), "u32::MAX 必须拒（远程 OOM）");
    assert!(
        !frame_len_ok(16_384, 1),
        "超过 frag_count*FRAG（1*1000）必须拒"
    );
    assert!(
        !frame_len_ok((MAX_REASM_BYTES as u32) + 1, MAX_FRAG_COUNT),
        "超过 MAX_REASM_BYTES 必须拒"
    );
    // 合法边界：min(MAX_REASM_BYTES, frag_count*FRAG)
    assert!(frame_len_ok(1, 1));
    assert!(frame_len_ok(FRAG as u32, 1));
    assert!(
        frame_len_ok((MAX_FRAG_COUNT as usize * FRAG) as u32, MAX_FRAG_COUNT),
        "frag_count 满配时的物理最大帧长应放行"
    );
}

/// 🔴 P0-1：畸形 `frame_len` 不得被接受进重组器（不分配、不推进状态）。
#[test]
fn 脏包_frame_len超限被拒且不进重组器() {
    let data: Vec<u8> = vec![1u8; 1500];
    let mut r = VidReassembler::new();
    assert_eq!(feed_all(&mut r, &dgrams(0, &data, true)).len(), 1);

    // ① frame_len = 0
    let z = build_dg(1, FLAG_KEY, 0, 1, 0, &[0xAA; 10]);
    assert!(r.feed(&z).is_empty(), "frame_len=0 必须被拒");
    // ② frame_len = u32::MAX：修复前 drain_ready 会 with_capacity(4GiB)
    let huge = build_dg(1, FLAG_KEY, 0, 2, u32::MAX, &[0xBB; 10]);
    assert!(r.feed(&huge).is_empty(), "frame_len=u32::MAX 必须被拒");
    // ③ 超过 frag_count*FRAG（1 片装不下 5000B）
    let over = build_dg(1, FLAG_KEY, 0, 1, 5_000, &[0xCC; 10]);
    assert!(r.feed(&over).is_empty(), "超过 frag_count*FRAG 必须被拒");

    assert!(
        r.map.is_empty(),
        "脏包不得占住重组槽位（不分配、不推进状态）"
    );
    // 正常帧不受影响
    assert_eq!(feed_all(&mut r, &dgrams(2, &data, true)).len(), 1);
}

#[test]
fn 脏包_拼出字节数与帧长不符_拦交付并置damage() {
    let data: Vec<u8> = (0..2500u32).map(|i| (i % 251) as u8).collect();
    let mut r = VidReassembler::new();
    let dgs = dgrams(0, &data, true);
    // 第 0 片短了 1 字节：拼出 2499 ≠ 2500
    let mut short = dgs[0].clone();
    short.pop();
    r.feed(&short);
    let got = feed_all(&mut r, &dgs[1..]);
    assert!(got.is_empty(), "字节数不符的脏帧不得交付");
    assert!(r.take_damaged(), "脏帧 = 引用链不可信，必须置 damage");
}

#[test]
fn 重复与过时片被忽略() {
    let data: Vec<u8> = vec![1u8; 500];
    let dgs = dgrams(5, &data, true);
    let mut r = VidReassembler::new();
    assert_eq!(feed_all(&mut r, &dgs).len(), 1);
    // 整帧已交付；重放同一批片（seq 5 < next 6）必须全部忽略
    assert!(feed_all(&mut r, &dgs).is_empty(), "过时帧不得二次交付");
}

/// 🔴 发送端回绕跳过保留值 0（「旧对端无序号」）——接收端锚定判据是
/// `key && sq > 0`，发出 0 等于让该关键帧失去锚定资格。
#[test]
fn take_seq_回绕跳过0() {
    let mut s = VidDgramSender { next_seq: u32::MAX };
    assert_eq!(s.take_seq(), u32::MAX);
    assert_eq!(s.take_seq(), 1, "回绕跳过 0，落到 1");
}
