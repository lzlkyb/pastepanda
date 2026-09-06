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

/// 把文本**原子地覆盖**写到 `final_path`（临时文件 → fsync → rename 替换）。
///
/// 🔴 **不能用上面的 `finish_rename`。** 那个是给内容寻址文件（文件名 = 内容哈希）
/// 用的，它把「目标已存在」当成成功并**丢掉自己的 tmp**。而配置文件的目标几乎总是已存在的，
/// 拿那个函数来写配置 = 每次都静静地不写、还报成功。
///
/// fsync 不能省：写完就 rename 而不落盘的话，断电后可能拿到一个名字对、内容是空的文件——
/// 对配置文件而言这比写失败更糟（失败至少旧文件还在）。
///
/// Windows 上 `std::fs::rename` 走的是 `MoveFileEx + MOVEFILE_REPLACE_EXISTING`，
/// 同卷内可以盖写已存在的目标。
pub fn write_replace(final_path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = final_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录 {} 失败：{}", parent.display(), e))?;
    }
    let tmp = unique_tmp_path(final_path);
    // 单独开作用域：要先 fsync 再关句柄，然后才能 rename（Windows 下句柄没关就 rename 会报拒绝访问）
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)
            .map_err(|e| format!("创建临时文件失败：{}", e))?;
        f.write_all(content.as_bytes())
            .and_then(|_| f.sync_all())
            .map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                format!("写临时文件失败：{}", e)
            })?;
    }
    std::fs::rename(&tmp, final_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("替换 {} 失败：{}", final_path.display(), e)
    })
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

    #[test]
    fn write_replace真的盖写已存在的文件() {
        // 🔴 这正是 `finish_rename` 做不到的那件事：它会把「目标已存在」当成成功并不写。
        // 配置文件的目标几乎总是已存在的，没这条断言就会静静地退化成「永远不生效」。
        let dir = std::env::temp_dir().join(format!("pp_wr_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("conf.json");
        std::fs::write(&target, b"old").unwrap();
        write_replace(&target, "new").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_replace会先把父目录建出来() {
        // WorkBuddy 的 `~/.workbuddy/` 在未启用过时可能根本不存在
        let dir = std::env::temp_dir().join(format!("pp_wr2_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let target = dir.join("sub").join("mcp.json");
        write_replace(&target, "{}").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
