//! 最近录制文件扫描——「最近录制」列表的数据源（rec_list_files 命令层）。
//!
//! 不入库：直接扫保存目录的 `屏幕录制_*.mp4` 按修改时间取最近 N 条。
//! MP4 时长从 `moov/mvhd` 盒解析（版本 0/1 都支持），解析不出就给 None，
//! 列表不因单文件坏掉而阻塞。删除必须走 `delete_rec_file`：路径校验
//! （父目录 = 保存目录 + 文件名白名单）防止把任意路径删掉。

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// 前缀白名单：只认本功能产出的文件名（quality::output_file_name 的产物）。
const NAME_PREFIX: &str = "屏幕录制_";
const NAME_SUFFIX: &str = ".mp4";

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecFileMeta {
    pub name: String,
    pub path: String,
    pub bytes: u64,
    /// 播放器口径的时长；解析失败为 None（列表照常显示）。
    pub duration_ms: Option<u64>,
}

/// 扫目录取最近 `limit` 条（非递归，修改时间倒序）。
pub fn scan_recent(dir: &Path, limit: usize) -> Vec<RecFileMeta> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut metas: Vec<(std::time::SystemTime, RecFileMeta)> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with(NAME_PREFIX) || !name.ends_with(NAME_SUFFIX) {
                return None;
            }
            let md = e.metadata().ok()?;
            if !md.is_file() {
                return None;
            }
            let modified = md.modified().ok()?;
            Some((
                modified,
                RecFileMeta {
                    path: e.path().display().to_string(),
                    name,
                    bytes: md.len(),
                    duration_ms: mp4_duration_ms(&e.path()),
                },
            ))
        })
        .collect();
    metas.sort_by(|a, b| b.0.cmp(&a.0));
    metas.truncate(limit);
    metas.into_iter().map(|(_, m)| m).collect()
}

/// 校验路径是保存目录内的录屏产物（打开 / 定位 / 删除共用；不执行删除）。
/// 🔴 命令是公网的，前端传回的路径必须过这道闸。
pub fn validate_rec_path(save_dir: &Path, path: &Path) -> Result<(), String> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "路径没有文件名".to_string())?;
    if !name.starts_with(NAME_PREFIX) || !name.ends_with(NAME_SUFFIX) {
        return Err("不是录屏产物".into());
    }
    let dir_canon = std::fs::canonicalize(save_dir).map_err(|e| format!("保存目录不可达：{e}"))?;
    let parent = path
        .parent()
        .map(std::fs::canonicalize)
        .transpose()
        .map_err(|e| format!("文件目录不可达：{e}"))?;
    if parent.as_deref() != Some(dir_canon.as_path()) {
        return Err("只能操作保存目录里的录制文件".into());
    }
    Ok(())
}

/// 删除一个录制文件（先过 `validate_rec_path` 的路径闸）。
pub fn delete_rec_file(save_dir: &Path, path: &Path) -> Result<(), String> {
    validate_rec_path(save_dir, path)?;
    std::fs::remove_file(path).map_err(|e| format!("删除失败：{e}"))
}

/// MP4 时长（ms）：顶层盒走到 `moov`，其子盒 `mvhd` 带 timescale/duration。
/// 泛型在 Read+Seek 上，单测直接喂内存字节。
fn mp4_duration_ms_impl<R: Read + Seek>(mut f: R) -> Option<u64> {
    let read_header = |f: &mut R| -> Option<(u64, [u8; 4])> {
        let mut head = [0u8; 8];
        f.read_exact(&mut head).ok()?;
        let size = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as u64;
        Some((size, [head[4], head[5], head[6], head[7]]))
    };
    // ── 顶层：找 moov（8 字节头步进；size=1 走 64 位 largesize；size=0 到文件尾）──
    loop {
        let (size, kind) = read_header(&mut f)?;
        let body = if size == 1 {
            let mut ext = [0u8; 8];
            f.read_exact(&mut ext).ok()?;
            u64::from_be_bytes(ext) - 16
        } else if size == 0 {
            return None; // 到文件尾都没 moov（未 Finalize 的半截文件）
        } else {
            size - 8
        };
        if &kind == b"moov" {
            // moov 整盒读进内存（通常几十 KB），在子盒里找 mvhd
            let mut buf = vec![0u8; body as usize];
            f.read_exact(&mut buf).ok()?;
            return mvhd_duration_ms(&buf);
        }
        f.seek(SeekFrom::Current(body as i64)).ok()?;
    }
}

/// 在 moov 内容里找 mvhd：版本 0 → timescale@12/duration@16（u32）；
/// 版本 1 → timescale@20/duration@24（u64）。
fn mvhd_duration_ms(moov: &[u8]) -> Option<u64> {
    let mut off = 0usize;
    while off + 8 <= moov.len() {
        let size = u32::from_be_bytes([
            moov[off],
            moov[off + 1],
            moov[off + 2],
            moov[off + 3],
        ]) as usize;
        let kind = &moov[off + 4..off + 8];
        if size < 8 || off + size > moov.len() {
            return None;
        }
        if kind == b"mvhd" {
            let v = *moov.get(off + 8)?; // version
            // 盒内布局：[size4][type4][ver+flags4][ctime][mtime][timescale4][duration]
            // v0：ctime/mtime 各 4 → timescale@20、duration@24（u32）
            // v1：ctime/mtime 各 8 → timescale@28、duration@32（u64）
            let (ts_pos, dur_pos, dur64) = if v == 1 { (28, 32, true) } else { (20, 24, false) };
            let be = |s: usize, e: usize| -> Option<u64> {
                let sl = moov.get(off + s..off + e)?;
                Some(sl.iter().fold(0u64, |a, b| (a << 8) | u64::from(*b)))
            };
            let timescale = be(ts_pos, ts_pos + 4)?;
            let duration = if dur64 { be(dur_pos, dur_pos + 8)? } else { be(dur_pos, dur_pos + 4)? };
            if timescale == 0 {
                return None;
            }
            return Some(duration * 1000 / timescale);
        }
        off += size;
    }
    None
}

pub fn mp4_duration_ms(path: &Path) -> Option<u64> {
    let f = std::fs::File::open(path).ok()?;
    mp4_duration_ms_impl(f)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 合成一张 [ftyp][mdat][moov[mvhd v0]] 布局的「文件」。
    fn fake_mp4(timescale: u32, duration: u32) -> Vec<u8> {
        let mut v = Vec::new();
        // ftyp（size=16 → 载荷 8 字节：brand4 + minor4）
        v.extend_from_slice(&16u32.to_be_bytes());
        v.extend_from_slice(b"ftyp");
        v.extend_from_slice(&[0u8; 8]);
        // mdat（内容随便）
        v.extend_from_slice(&24u32.to_be_bytes());
        v.extend_from_slice(b"mdat");
        v.extend_from_slice(&[0u8; 16]);
        // moov[mvhd v0：ver+flags(4) ctime(4) mtime(4) timescale(4) duration(4)]
        let mvhd_body: Vec<u8> = [
            &[0u8; 4][..],
            &[0u8; 4][..],
            &[0u8; 4][..],
            &timescale.to_be_bytes()[..],
            &duration.to_be_bytes()[..],
        ]
        .concat();
        let mvhd_size = (8 + mvhd_body.len()) as u32;
        let moov_size = (8 + mvhd_size) as u32;
        v.extend_from_slice(&moov_size.to_be_bytes());
        v.extend_from_slice(b"moov");
        v.extend_from_slice(&mvhd_size.to_be_bytes());
        v.extend_from_slice(b"mvhd");
        v.extend_from_slice(&mvhd_body);
        v
    }

    #[test]
    fn 时长解析_顶层moov内嵌mvhd() {
        let data = fake_mp4(1_000, 102_400);
        let d = mp4_duration_ms_impl(std::io::Cursor::new(data)).unwrap();
        assert_eq!(d, 102_400);
        // 非 1000 timescale：1/90000 的流口径
        let d = mp4_duration_ms_impl(std::io::Cursor::new(fake_mp4(90_000, 2_700_000))).unwrap();
        assert_eq!(d, 30_000);
    }

    #[test]
    fn 时长解析_无moov或坏盒返回None() {
        // 没有 moov（半截文件）
        let mut v = Vec::new();
        v.extend_from_slice(&16u32.to_be_bytes());
        v.extend_from_slice(b"ftyp");
        v.extend_from_slice(&[0u8; 4]);
        assert!(mp4_duration_ms_impl(std::io::Cursor::new(v)).is_none());
        // moov 里没有 mvhd
        let mut v = Vec::new();
        v.extend_from_slice(&20u32.to_be_bytes());
        v.extend_from_slice(b"moov");
        v.extend_from_slice(&12u32.to_be_bytes());
        v.extend_from_slice(b"xxxx");
        v.extend_from_slice(&[0u8; 4]);
        assert!(mp4_duration_ms_impl(std::io::Cursor::new(v)).is_none());
    }

    #[test]
    fn 删除校验_白名单与目录边界() {
        let tmp = std::env::temp_dir().join(format!("rec_scan_test_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let ok = tmp.join("屏幕录制_2026-10-05_201500.mp4");
        std::fs::write(&ok, b"x").unwrap();
        assert!(delete_rec_file(&tmp, &ok).is_ok());
        // 白名单外文件名
        let bad = tmp.join("别的文件.mp4");
        std::fs::write(&bad, b"x").unwrap();
        assert!(delete_rec_file(&tmp, &bad).is_err());
        let _ = std::fs::remove_file(&bad);
        // 目录边界：同名文件放在别处
        let other = tmp.parent().unwrap().join("屏幕录制_9999.mp4");
        std::fs::write(&other, b"x").unwrap();
        assert!(delete_rec_file(&tmp, &other).is_err());
        let _ = std::fs::remove_file(&other);
        let _ = std::fs::remove_dir(&tmp);
    }

    #[test]
    fn 扫描_只认前缀且按时间倒序() {
        let tmp = std::env::temp_dir().join(format!("rec_scan_list_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("屏幕录制_a.mp4"), b"x").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(tmp.join("屏幕录制_b.mp4"), b"yy").unwrap();
        std::fs::write(tmp.join("无关.mp4"), b"z").unwrap();
        let list = scan_recent(&tmp, 5);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "屏幕录制_b.mp4");
        assert!(list[0].bytes == 2);
        assert!(list.iter().all(|m| m.duration_ms.is_none())); // 假文件没 moov
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
