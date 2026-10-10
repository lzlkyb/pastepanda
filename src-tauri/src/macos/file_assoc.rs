//! Markdown default handler with rollback. Only a user's settings action mutates Launch Services.
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Mutex};
use tauri::Manager;
static CHANGING: Mutex<()> = Mutex::new(());
#[derive(Debug, Deserialize)]
struct Snapshot {
    bundle_id: String,
    current: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Previous {
    owner: String,
    handler: String,
}
trait Backend {
    fn snapshot(&self) -> Result<Snapshot, String>;
    fn set(&self, identifier: &str) -> Result<(), String>;
}
struct Native;
extern "C" {
    fn pp_mac_md_snapshot(bytes: *mut *mut u8, length: *mut usize) -> i32;
    fn pp_mac_md_set(bytes: *const u8, length: usize) -> i32;
    fn pp_mac_free(bytes: *mut std::ffi::c_void);
}
impl Backend for Native {
    fn snapshot(&self) -> Result<Snapshot, String> {
        let (mut bytes, mut length) = (std::ptr::null_mut(), 0);
        let code = unsafe { pp_mac_md_snapshot(&mut bytes, &mut length) };
        struct Owned(*mut u8);
        impl Drop for Owned {
            fn drop(&mut self) {
                if !self.0.is_null() {
                    unsafe { pp_mac_free(self.0.cast()) }
                }
            }
        }
        let owned = Owned(bytes);
        if code != 0 || owned.0.is_null() || length == 0 || length > 8192 {
            return Err("文件关联需要从完整的 Mac 应用包运行".into());
        }
        serde_json::from_slice(unsafe { std::slice::from_raw_parts(owned.0, length) })
            .map_err(|e| format!("无法读取默认打开方式：{e}"))
    }
    fn set(&self, identifier: &str) -> Result<(), String> {
        if identifier.is_empty() || identifier.len() > 512 {
            return Err("默认应用标识无效".into());
        }
        let code = unsafe { pp_mac_md_set(identifier.as_ptr(), identifier.len()) };
        match code {
            0 => Ok(()),
            6 => Err("之前的默认应用已不可用，请在 Finder「显示简介 → 打开方式」中选择应用".into()),
            _ => Err(format!(
                "系统未确认默认打开方式（{code}），请在 Finder「显示简介 → 打开方式」中确认"
            )),
        }
    }
}
fn is_owner(snapshot: &Snapshot) -> bool {
    snapshot
        .current
        .as_ref()
        .is_some_and(|current| current.eq_ignore_ascii_case(&snapshot.bundle_id))
}
fn apply(backend: &impl Backend, path: &Path, enable: bool) -> Result<String, String> {
    let snapshot = backend.snapshot()?;
    if enable {
        if is_owner(&snapshot) {
            return Ok("已是 .md 默认打开方式".into());
        }
        let previous = snapshot
            .current
            .filter(|value| !value.is_empty())
            .ok_or("尚未检测到可恢复的默认应用，请先在 Finder「显示简介 → 打开方式」选择应用")?;
        let saved = Previous {
            owner: snapshot.bundle_id,
            handler: previous,
        };
        // Persist rollback before asking the system to change anything. A failed set retains it.
        let bytes = serde_json::to_vec(&saved).map_err(|e| e.to_string())?;
        write_rollback(path, &bytes).map_err(|e| format!("无法保存原默认打开方式：{e}"))?;
        backend.set(&saved.owner)?;
        Ok("已设为 .md 默认打开方式，双击 Markdown 文件可打开编辑器".into())
    } else {
        if !is_owner(&snapshot) {
            return Ok("当前默认打开方式已由系统或其它应用管理，未更改".into());
        }
        let bytes = std::fs::read(path)
            .map_err(|_| "没有原默认应用记录，请在 Finder「显示简介 → 打开方式」选择其它应用")?;
        let saved: Previous =
            serde_json::from_slice(&bytes).map_err(|_| "原默认应用记录损坏，未更改系统设置")?;
        if !saved.owner.eq_ignore_ascii_case(&snapshot.bundle_id)
            || saved.handler.eq_ignore_ascii_case(&snapshot.bundle_id)
            || saved.handler.is_empty()
        {
            return Err("原默认应用记录不匹配，未更改系统设置".into());
        }
        backend.set(&saved.handler)?;
        // Keep the small rollback record; a later successful enable refreshes it.
        Ok("已恢复开启前的 .md 默认打开方式".into())
    }
}
fn write_rollback(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = path.with_extension(format!("{}-{unique}.part", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = file
        .write_all(bytes)
        .and_then(|_| file.sync_all())
        .and_then(|_| std::fs::rename(&temporary, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}
pub fn status() -> String {
    match Native.snapshot() {
        Ok(snapshot) if is_owner(&snapshot) => "default",
        Ok(_) => "available",
        Err(_) => "unsupported",
    }
    .into()
}
pub fn set(app: &tauri::AppHandle, enable: bool) -> Result<String, String> {
    let _guard = CHANGING.lock().unwrap_or_else(|p| p.into_inner());
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    apply(&Native, &directory.join("md-default-handler.json"), enable)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    struct Fake {
        current: RefCell<String>,
        fail: bool,
    }
    impl Backend for Fake {
        fn snapshot(&self) -> Result<Snapshot, String> {
            Ok(Snapshot {
                bundle_id: "com.pastepanda.app".into(),
                current: Some(self.current.borrow().clone()),
            })
        }
        fn set(&self, id: &str) -> Result<(), String> {
            if self.fail {
                Err("declined".into())
            } else {
                *self.current.borrow_mut() = id.into();
                Ok(())
            }
        }
    }
    fn folder() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "pp-assoc-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn default_toggle_restores_previous_and_respects_external_changes() {
        let folder = folder();
        let path = folder.join("previous.json");
        let fake = Fake {
            current: RefCell::new("com.apple.TextEdit".into()),
            fail: false,
        };
        apply(&fake, &path, true).unwrap();
        assert_eq!(&*fake.current.borrow(), "com.pastepanda.app");
        apply(&fake, &path, false).unwrap();
        assert_eq!(&*fake.current.borrow(), "com.apple.TextEdit");
        apply(&fake, &path, true).unwrap();
        *fake.current.borrow_mut() = "com.other.editor".into();
        apply(&fake, &path, false).unwrap();
        assert_eq!(&*fake.current.borrow(), "com.other.editor");
        apply(&fake, &path, true).unwrap();
        apply(&fake, &path, false).unwrap();
        assert_eq!(&*fake.current.borrow(), "com.other.editor");
        std::fs::remove_dir_all(folder).unwrap();
    }
    #[test]
    fn failed_or_corrupted_rollback_never_replaces_a_handler() {
        let folder = folder();
        let path = folder.join("previous.json");
        let fake = Fake {
            current: RefCell::new("com.apple.TextEdit".into()),
            fail: true,
        };
        assert!(apply(&fake, &path, true).is_err());
        assert_eq!(&*fake.current.borrow(), "com.apple.TextEdit");
        assert!(path.is_file());
        let fake = Fake {
            current: RefCell::new("com.pastepanda.app".into()),
            fail: false,
        };
        std::fs::write(&path, b"broken").unwrap();
        assert!(apply(&fake, &path, false).is_err());
        assert_eq!(&*fake.current.borrow(), "com.pastepanda.app");
        std::fs::remove_dir_all(folder).unwrap();
    }
}
