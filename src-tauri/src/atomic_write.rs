//! 「内容寻址文件」的原子落盘：唯一临时名 + rename + 并发容忍。
//!
//! 为何单独建模块：`<hash>.<ext>.tmp` 这个写法在 3 处各写了一份
//! （`screenshot::save_screenshot_image`、`commands::images` 的图片落盘、
//! `clipboard_monitor` 的剪贴板图片落盘），三份都把**内容 md5 当成了临时文件名**
//! —— 等于假设「同样的内容永远不会被同时保存两次」，而没有任何东西在保证这件事：
//!   · 截图：用户没画标注时，预 OCR 存的选区原图与「完成」合成的结果图像素完全一致；
//!   · 剪贴板：它自己的注释就写着「双 timer 触发」。
//! 两边一重叠，先完成的 rename 把 tmp 拿走，后一个 rename 就拿到
//! os error 2「系统找不到指定的文件」—— 用户看到的是「完成」直接失败。
//!
//! 收在这里而不是三处各修一遍：第四处写出来时不会又踩一次（规则 11.1）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// 为内容寻址的目标文件生成**唯一**临时文件名（进程内序号 + pid，跨进程也不撞）。
pub fn unique_tmp_path(final_path: &Path) -> PathBuf {
    let ext = final_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("bin");
    final_path.with_extension(format!(
        "{}.{}.{}.tmp",
        ext,
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ))
}

/// tmp → 目标的收尾：容忍「并发者已经把同内容的文件落好了」。
///
/// 路径是内容寻址的（文件名 = 内容哈希），所以目标文件已经存在就等于成功 ——
/// 直接丢掉自己的 tmp，不要报错。失败时返回底层错误文本，由调用方自己拼提示。
pub fn finish_rename(tmp_path: &Path, final_path: &Path) -> Result<(), String> {
    if final_path.exists() {
        let _ = std::fs::remove_file(tmp_path);
        return Ok(());
    }
    if let Err(e) = std::fs::rename(tmp_path, final_path) {
        let _ = std::fs::remove_file(tmp_path);
        // 再确认一次：并发者刚好在这个空隙里落好了文件的话，本次也算成功
        if !final_path.exists() {
            return Err(e.to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmp_path_is_unique_per_call() {
        let target = Path::new("C:\\tmp\\abc123.png");
        let a = unique_tmp_path(target);
        let b = unique_tmp_path(target);
        assert_ne!(a, b, "同一目标的两次调用必须拿到不同的 tmp——这正是 os error 2 的根因");
        assert!(a.to_string_lossy().ends_with(".tmp"));
        assert!(a.to_string_lossy().contains("abc123.png."));
    }

    #[test]
    fn finish_rename_treats_existing_target_as_success() {
        let dir = std::env::temp_dir().join(format!("pp_aw_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("same.png");
        std::fs::write(&target, b"content").unwrap();
        let tmp = unique_tmp_path(&target);
        std::fs::write(&tmp, b"content").unwrap();
        // 目标已存在（并发者先落好了）→ 不报错，且丢掉自己的 tmp
        assert!(finish_rename(&tmp, &target).is_ok());
        assert!(!tmp.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
