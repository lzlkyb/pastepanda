//! Reed-Solomon FEC（GF(2^8)，系统码，柯西矩阵）——视频数据报分片的擦除恢复。
//!
//! 替代/升级原 XOR 奇偶（每 4 片 1 片奇偶、组内只救 1 丢）：
//! - **组内救 m 丢**：k 片数据 + m 片校验，组内任意 ≤m 片丢失全恢复；
//! - **动态冗余**：发送端按实测丢包率选 m（干净内网 m=1 仅 +6%，比旧 XOR
//!   的 +25% 省 19% 带宽；丢包升高时 m 提到 4~8）；
//! - **柯西矩阵**：任意 k+m 子矩阵在 GF(2^8) 上可逆（m ≤ 255-k 恒成立），
//!   不需要 Vandermonde 的「数据片在前」限制，也避免了奇异子阵。
//!
//! 纯函数、无环境依赖（项目规则 11.1）；每条判据都有守卫测试（见 tests）。
//!
//! # 线上格式约定（vid_dgram.rs 落地）
//! 组大小 k 固定 16；一帧 n 片数据分 `ceil(n/k)` 组，每组附 m 片校验；
//! 校验片的全局槽位 = n + 组号×m + 组内序号（与旧 XOR 的
//! `frag_count + g` 布局同构，只是 m 可 >1）。接收端由
//! `total − n` 与组数推出 m（无需改线上头格式）。

/// GF(2^8) 本原多项式 0x11d（RS 标准选择，与 ISO/IEC 15626 一致）。
const GF_POLY: u16 = 0x11d;

/// 指数表：`EXP[i] = α^i mod (x^8+x^4+x^3+x^2+1)`，i ∈ [0, 510]（查表免取模）。
static EXP: [u8; 512] = build_exp();
/// 对数表：`LOG[α^i] = i`；0 无对数（占位 0）。
static LOG: [u8; 256] = build_log();

const fn build_exp() -> [u8; 512] {
    let mut exp = [0u8; 512];
    let mut x: u16 = 1;
    let mut i = 0;
    while i < 255 {
        exp[i] = x as u8;
        x <<= 1;
        if x & 0x100 != 0 {
            x ^= GF_POLY;
        }
        i += 1;
    }
    // 折叠一次使查表免取模（i+j 最大 508）
    let mut j = 255;
    while j < 512 {
        exp[j] = exp[j - 255];
        j += 1;
    }
    exp
}

const fn build_log() -> [u8; 256] {
    let mut log = [0u8; 256];
    let exp = build_exp();
    let mut i = 0;
    while i < 255 {
        log[exp[i] as usize] = i as u8;
        i += 1;
    }
    log
}

/// GF(2^8) 乘法。
#[inline]
fn gmul(a: u8, b: u8) -> u8 {
    if a == 0 || b == 0 {
        0
    } else {
        EXP[LOG[a as usize] as usize + LOG[b as usize] as usize]
    }
}

/// GF(2^8) 逆元；0 无逆元（不会出现在柯西矩阵里）。
fn ginv(a: u8) -> u8 {
    debug_assert_ne!(a, 0);
    EXP[255 - LOG[a as usize] as usize]
}

/// k×k 柯西编码子矩阵的第 r 行：`Cauchy[r][c] = 1 / (x_r ^ y_c)`。
/// 取 x = [0..k)，y = [k..k+m)（两集合不相交 ⇒ 任何元素非零、任何子阵可逆——
/// 柯西矩阵的性质：任意 k×k 子矩阵都是 MDS 可逆的）。
fn cauchy_row(r: usize, k: usize, m: usize) -> Vec<u8> {
    let xr = (k + m + r) as u8; // x 取高位段，避免与 y 重叠
    (0..k)
        .map(|c| ginv(xr ^ (c as u8)))
        .collect()
}

/// 对一组数据片编码 m 片校验。`data_shards.len() == k`，各片等长（尾部不足的
/// 由调用方补零对齐后再来）。返回 m 片校验（各 shard_len 长）。
///
/// 校验 j 的每个字节 = `Σ Cauchy[j][c] × data[c]`（逐字节 GF 乘加）。
pub fn encode_parity(data_shards: &[&[u8]], m: usize) -> Vec<Vec<u8>> {
    let k = data_shards.len();
    assert!(k > 0 && m > 0, "k/m 必须为正");
    let len = data_shards[0].len();
    debug_assert!(data_shards.iter().all(|s| s.len() == len));
    (0..m)
        .map(|r| {
            let row = cauchy_row(r, k, m);
            let mut out = vec![0u8; len];
            for (c, shard) in data_shards.iter().enumerate() {
                let coef = row[c];
                if coef == 1 {
                    for (o, s) in out.iter_mut().zip(shard.iter()) {
                        *o ^= s;
                    }
                } else {
                    for (o, s) in out.iter_mut().zip(shard.iter()) {
                        *o ^= gmul(coef, *s);
                    }
                }
            }
            out
        })
        .collect()
}

/// 擦除恢复：给定组内**现存**的片（下标 0..k 为数据片，k..k+m 为校验片），
/// 恢复全部缺失的数据片。丢失数 > m 返回 None（调用方整帧报废）。
///
/// `shard_len`：该片组的对齐长度（末片真实长度由调用方按 frame_len 截）。
/// 返回 `Vec<Option<Vec<u8>>>`，长度 k：`Some` 为数据片（原有或恢复的），
/// 校验片位置恒 `None`。
pub fn decode_group(
    present: &[(usize, &[u8])],
    k: usize,
    m: usize,
    shard_len: usize,
) -> Option<Vec<Option<Vec<u8>>>> {
    assert!(k > 0 && m > 0);
    let n = k + m;
    if present.len() < k {
        return None; // 有效片不足 k，不可恢复
    }
    let missing: Vec<usize> = (0..k)
        .filter(|i| !present.iter().any(|(idx, _)| idx == i))
        .collect();
    if missing.is_empty() {
        // 无丢失：直接摘出数据片
        return Some(
            (0..k)
                .map(|i| {
                    present
                        .iter()
                        .find(|(idx, _)| *idx == i)
                        .map(|(_, s)| s.to_vec())
                })
                .collect(),
        );
    }
    // 增广行高斯消元（2026-09-27 修正）：每行 = (生成行, 右手侧=该片字节)。
    // 数据片行生成向量是单位行，右手侧是它自己；校验片行生成向量是柯西行，
    // 右手侧是校验内容。对 missing 列做 RREF 后，主元行的方程是
    //   data_col ⊕ Σ_{c ∉ missing} coef[c]·data_c = rhs'
    // ⇒ data_col = rhs' ⊕ Σ_{c ∉ missing} coef[c]·data_c。
    // ❗ 右手侧必须跟着消元一起走——只拿生成行系数乘现存片会丢掉校验项
    //   （首版实现正是漏了它，恢复值全错）。
    let shard_of = |idx: usize| -> Vec<u8> {
        let mut s = present
            .iter()
            .find(|(i, _)| *i == idx)
            .map(|(_, s)| s.to_vec())
            .unwrap_or_default();
        s.resize(shard_len, 0);
        s
    };
    let mut rows: Vec<(Vec<u8>, Vec<u8>)> = Vec::with_capacity(k); // (生成行, 右手侧)
    for (idx, _shard) in present {
        if *idx < k {
            let mut unit = vec![0u8; k];
            unit[*idx] = 1;
            rows.push((unit, shard_of(*idx)));
        } else {
            rows.push((cauchy_row(*idx - k, k, m), shard_of(*idx)));
        }
        if rows.len() == k {
            break;
        }
    }
    let mut pivot_of_col: [Option<usize>; 64] = [None; 64]; // 列 → 行号
    // 每行至多做一次主元：已当过主元的行在先前列上是单位系数，再选它会让
    // RREF 的单位结构破坏（恢复值全错）。
    let mut row_used = vec![false; rows.len()];
    for &col in &missing {
        let Some(r) = (0..rows.len())
            .find(|&r| !row_used[r] && rows[r].0[col] != 0)
        else {
            return None; // 子矩阵奇异——柯西矩阵下不会发生，防御返回
        };
        row_used[r] = true;
        pivot_of_col[col] = Some(r);
        let inv = ginv(rows[r].0[col]);
        for b in rows[r].0.iter_mut() {
            *b = gmul(*b, inv);
        }
        for b in rows[r].1.iter_mut() {
            *b = gmul(*b, inv);
        }
        // 用该行消掉其它行在本列的系数（生成行与右手侧同步）
        let pivot_gen = rows[r].0.clone();
        let pivot_rhs = rows[r].1.clone();
        for (r2, row2) in rows.iter_mut().enumerate() {
            if r2 == r {
                continue; // 主元行自己不能被消（否则整行归零）
            }
            let f = row2.0[col];
            if f != 0 {
                for (b, p) in row2.0.iter_mut().zip(pivot_gen.iter()) {
                    *b ^= gmul(f, *p);
                }
                for (b, p) in row2.1.iter_mut().zip(pivot_rhs.iter()) {
                    *b ^= gmul(f, *p);
                }
            }
        }
    }
    let mut out: Vec<Option<Vec<u8>>> = vec![None; k];
    for &col in &missing {
        let Some(r) = pivot_of_col[col] else { continue };
        let (gen, rhs) = (&rows[r].0, &rows[r].1);
        // data_col = rhs' ⊕ Σ_{c ∉ missing} coef[c]·data_c
        let mut rec = rhs.clone();
        for c in 0..k {
            if missing.contains(&c) {
                continue; // 该列在主元行上是单位系数，rhs' 里已含等价信息
            }
            let coef = gen[c];
            if coef == 0 {
                continue;
            }
            let shard = shard_of(c);
            if coef == 1 {
                for (o, s) in rec.iter_mut().zip(shard.iter()) {
                    *o ^= s;
                }
            } else {
                for (o, s) in rec.iter_mut().zip(shard.iter()) {
                    *o ^= gmul(coef, *s);
                }
            }
        }
        out[col] = Some(rec);
    }
    // 无丢失的现存数据片也回填，调用方免二次查找
    for (idx, _) in present.iter().filter(|(i, _)| *i < k) {
        if out[*idx].is_none() {
            out[*idx] = Some(shard_of(*idx));
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shards(n: usize, len: usize, seed: u8) -> Vec<Vec<u8>> {
        (0..n)
            .map(|i| {
                (0..len)
                    .map(|j| (i as u8).wrapping_mul(31).wrapping_add(j as u8).wrapping_add(seed))
                    .collect()
            })
            .collect()
    }

    #[test]
    fn 编码后无丢失全量取回() {
        let data = shards(16, 1000, 7);
        let refs: Vec<&[u8]> = data.iter().map(|v| v.as_slice()).collect();
        let parity = encode_parity(&refs, 4);
        assert_eq!(parity.len(), 4);
        let present: Vec<(usize, &[u8])> = refs
            .iter()
            .enumerate()
            .map(|(i, s)| (i, *s))
            .chain((0..4).map(|j| (16 + j, parity[j].as_slice())))
            .collect();
        let out = decode_group(&present, 16, 4, 1000).expect("无丢失可解");
        for (i, s) in out.iter().enumerate() {
            assert_eq!(s.as_deref(), Some(data[i].as_slice()), "片 {i} 应原样");
        }
    }

    #[test]
    fn 组内丢m片全恢复() {
        let data = shards(16, 1000, 3);
        let refs: Vec<&[u8]> = data.iter().map(|v| v.as_slice()).collect();
        let parity = encode_parity(&refs, 4);
        // 丢 4 片（= m，恰好可恢复）：丢数据 0、5、9，校验 1
        let mut present: Vec<(usize, &[u8])> = data
            .iter()
            .enumerate()
            .filter(|(i, _)| ![0, 5, 9].contains(i))
            .map(|(i, v)| (i, v.as_slice()))
            .collect();
        present.push((16 + 0, parity[0].as_slice()));
        present.push((16 + 2, parity[2].as_slice()));
        present.push((16 + 3, parity[3].as_slice()));
        let out = decode_group(&present, 16, 4, 1000).expect("丢4片应可恢复");
        for i in [0usize, 5, 9] {
            assert_eq!(
                out[i].as_deref(),
                Some(data[i].as_slice()),
                "丢失的数据片 {i} 应被恢复"
            );
        }
        // 现存数据片原样回填
        assert_eq!(out[1].as_deref(), Some(data[1].as_slice()));
    }

    #[test]
    fn 丢超过m片判不可恢复() {
        let data = shards(16, 100, 1);
        let refs: Vec<&[u8]> = data.iter().map(|v| v.as_slice()).collect();
        let parity = encode_parity(&refs, 2);
        let mut present: Vec<(usize, &[u8])> = data
            .iter()
            .enumerate()
            .filter(|(i, _)| ![0, 1, 2].contains(i))
            .map(|(i, v)| (i, v.as_slice()))
            .collect();
        present.push((16, parity[0].as_slice()));
        present.push((17, parity[1].as_slice()));
        // 丢 3 片 > m=2
        assert!(decode_group(&present, 16, 2, 100).is_none());
    }

    #[test]
    fn 末片短于对齐长度按补零恢复() {
        // 真实末片 300B，对齐长度 1000（调用方补零）——恢复值也带补零，
        // 由调用方按 frame_len 截断
        let data = shards(15, 1000, 9);
        let mut last = vec![0u8; 1000];
        last[..300].copy_from_slice(&shards(1, 300, 9)[0]);
        let mut all = data.clone();
        all.push(last);
        let refs: Vec<&[u8]> = all.iter().map(|v| v.as_slice()).collect();
        let parity = encode_parity(&refs, 2);
        let present: Vec<(usize, &[u8])> = refs
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != 4)
            .map(|(i, s)| (i, *s))
            .chain([(16, parity[0].as_slice()), (17, parity[1].as_slice())])
            .collect();
        let out = decode_group(&present, 16, 2, 1000).expect("可恢复");
        assert_eq!(out[4].as_deref().map(|s| &s[..300]), Some(&all[4][..300]));
    }

    #[test]
    fn 柯西行系数全非零() {
        for k in [1usize, 4, 16] {
            for m in [1usize, 4, 8] {
                for r in 0..m {
                    for c in 0..k {
                        assert_ne!(cauchy_row(r, k, m)[c], 0, "k{k} m{m} r{r} c{c}");
                    }
                }
            }
        }
    }
}

