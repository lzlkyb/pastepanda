//! BGRA 色彩空间转换（RGBA 打包 / NV12 BT.709 limited）。
//!
//! 2026-09-22 从 `dxgi.rs` 平移（体量合规）：纯函数、不碰 DXGI/D3D 对象，
//! 与抓屏实现无耦合。调用方经 `dxgi::bgra_to_*` re-export 路径不变。

pub fn bgra_to_rgba(bgra: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bgra.len());
    for p in bgra.chunks_exact(4) {
        out.extend_from_slice(&[p[2], p[1], p[0], 255]);
    }
    out
}

// 与缩放一样在独立速度优化库中编译，避免 dev 标量循环占用整帧预算。
pub use pastepanda_rc_scale::{bgra_to_nv12, bgra_to_nv12_into};
