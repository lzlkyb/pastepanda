//! 分桶摘要（W2）—— 让分叉能被发现、并只重发分叉的那一小块。
//!
//! # 要解的问题
//!
//! 反熵完全靠单调游标：两边内容若因任何原因分叉而游标都已推过，
//! **没有任何机制能发现「我们不一致」**。现有设计能保证「正常路径收敛」，
//! 不能保证「异常之后收敛」。
//!
//! # 做法
//!
//! 按 id 首字符分 16 个桶，每个桶报一个对 `(id, updated_ms)` 的折叠值。
//! 只把**不一致的桶**重新对账，而不是整库退回 0（那是方案 a，一次分叉就全量重传）。
//!
//! # 🔴 两边必须算出**同一个**分叉集
//!
//! 分叉集是两份摘要的纯函数（[`diverged`]），所以只要**两边都拿到了对方的摘要**，
//! 就不需要再商量一次（也就不用多一个“请求重发”帧）。
//!
//! 反过来，若只有一边拿到对方摘要，修复就是**单向**的，而单向修复不收敛：
//! A 把桶 k 全发给 B，B 按后写胜并入；但若 B 那边有更新的版本，A 学不到，
//! 下一轮依旧分叉。所以摘要交换要么两边都做、要么两边都不做，不能一边做。
//!
//! # 为何不用密码学哈希
//!
//! 对端已经是 ed25519 认过的（身份从连接来，见 `session` 模块说明）；
//! 而就算一个已配对的对端故意报假摘要，得到的也只是「多重发一些桶」——
//! 既不会丢数据也不会泄密。为一个只用来对比相等性的值拉 sha2 不值得。

/// 桶数。拍板值，改它就是改协议（两边桶数不同时看 [`diverged`] 的处理）。
pub const BUCKETS: u32 = 16;

/// 一条笔记 id 落在哪个桶。
///
/// ❗ 用**首字符码点取模**，不用「首个十六进制字符」：uuid v4 的第一位确实是
/// hex，但 `note_create_keeping_id` 允许 vault 导入把**任意 id** 带进来
/// （frontmatter 里的 `pastepanda_id`），所以不能假设。取模对任何字符都成立。
pub fn bucket_of(id: &str) -> u32 {
    id.chars().next().map(|c| c as u32).unwrap_or(0) % BUCKETS
}

/// SQL 侧的分桶表达式。`col` = id 列名（`notes.id` / `note_tombstones.note_id`）。
///
/// # 🔴 它必须与 [`bucket_of`] 逐字等价
///
/// 两处算得不一样的后果不是报错：摘要按一种口径分桶、重发按另一种口径筛，
/// 于是分叉的桶永远补不齐，而每个心跳会话都重发一遍——**静默且永不收敛**。
/// 所以两个定义写在一起，并有一条拿真行对比两边结果的测试。
///
/// `unicode()` 是 SQLite 核心函数（自 3.8.3），返回首字符的码点。
pub fn bucket_sql(col: &str) -> String {
    format!("(unicode(substr({}, 1, 1)) % {})", col, BUCKETS)
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn fold_bytes(mut h: u64, bytes: &[u8]) -> u64 {
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

/// 一个空桶的初值。
pub fn empty_bucket() -> u64 {
    FNV_OFFSET
}

/// 把一条 `(id, updated_ms)` 折进桶。
///
/// ❗ FNV **不可交换**，所以谁先折进去结果不同。调用方必须按固定顺序
/// （`ORDER BY id`）递进，否则两台机器内容完全一样也会算出不同的摘要。
pub fn absorb(h: u64, id: &str, updated_ms: i64) -> u64 {
    let h = fold_bytes(h, id.as_bytes());
    // 分隔符：不加的话 ("ab", 1) 与 ("a", 0xb1) 这类拼接歧义会变成碰撞。
    let h = fold_bytes(h, b"\x1f");
    fold_bytes(h, &updated_ms.to_le_bytes())
}

/// 哪些桶两边不一样。结果升序、无重。
///
/// ❗ 长度对不上时（未来改了 [`BUCKETS`]）**当全部分叉**，而不是比短的那个：
/// 按短的比会把尾部桶隐形跳过，那是静默的不收敛。全量重对账只是浪费一次。
pub fn diverged(mine: &[u64], theirs: &[u64]) -> Vec<u32> {
    if mine.len() != theirs.len() {
        return (0..mine.len().max(theirs.len()) as u32).collect();
    }
    mine.iter()
        .zip(theirs.iter())
        .enumerate()
        .filter(|(_, (a, b))| a != b)
        .map(|(i, _)| i as u32)
        .collect()
}
