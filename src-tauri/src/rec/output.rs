//! A destination is published only after all bytes have been written successfully.
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

pub struct PendingOutput {
    temporary: PathBuf,
    destination: PathBuf,
    replace: bool,
    committed: bool,
}

impl PendingOutput {
    #[cfg(target_os = "macos")] // 仅 mac 裁剪链路（rec_trim）在用
    pub fn temporary_path(&self) -> &Path { &self.temporary }
    /// No final filename is visible while an export is incomplete.
    pub fn new(destination: &Path, replace: bool) -> Result<(Self, File), String> {
        if !replace && destination.exists() { return Err("产物文件已存在，请重新保存".into()); }
        let temporary = destination.with_file_name(format!(
            ".{}.{}.{}.part",
            destination.file_name().unwrap_or_default().to_string_lossy(),
            std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        let pending = Self { temporary, destination: destination.into(), replace, committed: false };
        let file = OpenOptions::new().write(true).create_new(true).open(&pending.temporary)
            .map_err(|e| format!("创建临时产物失败：{e}"))?;
        Ok((pending, file))
    }

    pub fn commit(mut self) -> Result<(), String> {
        if self.replace {
            std::fs::rename(&self.temporary, &self.destination)
                .map_err(|e| format!("发布产物失败：{e}"))?;
        } else {
            // MoveFileW fails if another producer has claimed this name.
            #[cfg(windows)]
            unsafe {
                windows::Win32::Storage::FileSystem::MoveFileW(
                    &windows::core::HSTRING::from(self.temporary.as_os_str()),
                    &windows::core::HSTRING::from(self.destination.as_os_str()),
                ).map_err(|e| format!("发布新产物失败：{e}"))?;
            }
            #[cfg(not(windows))]
            {
                std::fs::hard_link(&self.temporary, &self.destination)
                    .map_err(|e| format!("发布新产物失败：{e}"))?;
                let _ = std::fs::remove_file(&self.temporary);
            }
        }
        self.committed = true;
        Ok(())
    }
}

impl Drop for PendingOutput {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.temporary);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn failed_replacement_preserves_previous_output_and_cleans_temporary() {
        let dir = std::env::temp_dir().join(format!("rec_output_{}_{}", std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        let dst = dir.join("saved.gif");
        std::fs::write(&dst, b"previous").unwrap();
        {
            let (_pending, mut file) = PendingOutput::new(&dst, true).unwrap();
            file.write_all(b"partial").unwrap();
        }
        assert_eq!(std::fs::read(&dst).unwrap(), b"previous");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        assert!(PendingOutput::new(&dst, false).is_err());
        let (pending, mut file) = PendingOutput::new(&dst, true).unwrap();
        file.write_all(b"complete").unwrap();
        file.sync_all().unwrap();
        drop(file);
        pending.commit().unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"complete");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
