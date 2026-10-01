//! `file_transfer.rs` 的单元测试（原样平移）。

use super::*;

#[test]
fn 完成态必须字节数一致() {
    let (st, err) = TxOutcome::Done.finish(100, 100);
    assert_eq!(st, TaskState::Done);
    assert!(err.is_none());
    // 短文件不得假 Done（P1-5）
    let (st, err) = TxOutcome::Done.finish(50, 100);
    assert_eq!(st, TaskState::Failed);
    assert!(err.unwrap().contains("不一致"));
}

#[test]
fn rename绝不覆盖已有文件() {
    let dir = std::env::temp_dir().join(format!("pp-rename-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let part = dir.join("a.bin.pppart");
    let dest = dir.join("a.bin");
    std::fs::write(&part, b"new").unwrap();
    std::fs::write(&dest, b"old").unwrap();
    let r = rename_no_overwrite(&part, &dest);
    assert!(r.is_err(), "目标存在时不得覆盖");
    assert_eq!(std::fs::read(&dest).unwrap(), b"old", "旧文件必须原样");
    assert!(part.exists(), "part 应保留，便于换名重试");
    // 目标空闲时成功，且 part 消失
    let dest2 = dir.join("b.bin");
    std::fs::write(&part, b"new").unwrap();
    rename_no_overwrite(&part, &dest2).unwrap();
    assert_eq!(std::fs::read(&dest2).unwrap(), b"new");
    assert!(!part.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn 收尾冲突时递增换名() {
    let dir = std::env::temp_dir().join(format!("pp-final-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let part = dir.join("报告.zip.pppart");
    std::fs::write(&part, b"payload").unwrap();
    std::fs::write(dir.join("报告.zip"), b"existing").unwrap();
    let name = finalize_recv_name(&part, &dir, "报告.zip").unwrap();
    assert_ne!(name, "报告.zip", "冲突时必须换名");
    assert_eq!(std::fs::read(dir.join("报告.zip")).unwrap(), b"existing");
    assert_eq!(std::fs::read(dir.join(&name)).unwrap(), b"payload");
    assert!(!part.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

/// Android 接收目录的包名段写死在 Rust 里（`EXTERNAL_STORAGE` 环境变量拿不到
/// 包名），必须与 tauri.conf.json 的 identifier 一致——分叉的表现是文件落进
/// 一个包名不存在的幽灵目录，手机文件管理器里永远找不到。
/// 本测试在桌面跑：跨平台配置的另一半永远没人编译就没人验（P1 文档坑 6 的教训）。
#[test]
fn android_app_id_与_tauri配置一致() {
    let conf = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"))
        .expect("tauri.conf.json 必须在 crate 根");
    let ident = conf
        .split("\"identifier\"")
        .nth(1)
        .and_then(|rest| rest.split('"').nth(1))
        .expect("tauri.conf.json 里要有 identifier");
    assert_eq!(ANDROID_APP_ID, ident, "Android 包名段必须跟 tauri.conf.json 走");
}
