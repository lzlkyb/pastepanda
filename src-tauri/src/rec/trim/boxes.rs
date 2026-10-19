//! trim 的字节级盒子工具：解析侧（`parse.rs`）与重组侧（`rewrite.rs`）共用。
//!
//! 只支持 32 位尺寸的盒子（MF 产物如此）；数量上限见 `trim.rs` 的
//! `MAX_BOX_COUNT`。这里所有读操作都不 panic——越界一律返回 `Err`。

use super::MAX_BOX_COUNT;

// ── 盒子遍历（纯内存，操作 moov 载荷）───────────────────────────────────

#[derive(Clone, Copy, Debug)]
pub(super) struct BoxRef<'a> {
    pub(super) name: [u8; 4],
    pub(super) payload: &'a [u8],
}

/// 遍历一段「容器载荷」里的兄弟盒子。只支持 32 位尺寸（MF 产物如此）；
/// size==1（64 位 largesize）在 moov 内部出现即报错——不硬解不猜。
pub(super) fn iter_boxes(buf: &[u8]) -> Result<Vec<BoxRef<'_>>, String> {
    let mut out = Vec::new();
    let mut off = 0usize;
    while off < buf.len() {
        if out.len()>=MAX_BOX_COUNT {return Err("媒体盒子数量超过安全上限".into());}
        if buf.len() - off < 8 {
            return Err(format!("盒子头越界（@{off}，余 {} 字节）", buf.len() - off));
        }
        let size = u32be(buf, off) as usize;
        let mut name = [0u8; 4];
        name.copy_from_slice(&buf[off + 4..off + 8]);
        if size == 1 {
            return Err(format!("盒子 {name:?} 用 64 位 largesize（moov 内部不支持）"));
        }
        if size < 8 {
            return Err(format!("盒子 {name:?} 尺寸非法（{size}）"));
        }
        let end = off + size;
        if end > buf.len() {
            return Err(format!("盒子 {name:?} 越出父容器（{end} > {}）", buf.len()));
        }
        out.push(BoxRef { name, payload: &buf[off + 8..end] });
        off = end;
    }
    Ok(out)
}

pub(super) fn u32be(b: &[u8], off: usize) -> u32 {
    u32::from_be_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}
pub(super) fn u64be(b: &[u8], off: usize) -> u64 {
    u64::from_be_bytes([b[off], b[off + 1], b[off + 2], b[off + 3], b[off + 4], b[off + 5], b[off + 6], b[off + 7]])
}
pub(super) fn push_u32(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_be_bytes());
}
/// 仅对抗样本测试（hostile_co64）使用；生产路径一律走 `push_u64_at`。
#[cfg(test)]
pub(super) fn push_u64(v: &mut Vec<u8>, x: u64) {
    v.extend_from_slice(&x.to_be_bytes());
}
pub(super) fn wrap_box(name: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(payload.len() + 8);
    push_u32(&mut v, payload.len() as u32 + 8);
    v.extend_from_slice(name);
    v.extend_from_slice(payload);
    v
}
pub(super) fn push_u32_at(v: &mut [u8], off: usize, x: u32) {
    v[off..off + 4].copy_from_slice(&x.to_be_bytes());
}
pub(super) fn push_u64_at(v: &mut [u8], off: usize, x: u64) {
    v[off..off + 8].copy_from_slice(&x.to_be_bytes());
}

pub(super) fn io_err(e: std::io::Error) -> String {
    format!("IO：{e}")
}
