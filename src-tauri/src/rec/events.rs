//! 录屏 sidecar 元数据轨道（四期 1.3 方案 C 双轨之一）——`.events.json`。
//!
//! 与 mp4 同名同目录（`屏幕录制_x.mp4` → `屏幕录制_x.events.json`），时间基 =
//! **视频时间轴 ms**（提交帧数驱动，不含首帧等待与暂停段——暂停期间的事件被
//! 会话丢弃）。坐标 = **画布系**（裁剪后、缩放前），头部带 region（桌面绝对）
//! 与编码尺寸，五期渲染器可自行映射/缩放。
//!
//! 隐私：普通字符键 / OEM 标点 / IME 不记录（见 hooks.rs `classify_key`）；
//! 本文件由会话收尾一次性写出（内存缓冲，无逐事件 IO）。
//!
//! 裁剪联动：`remap_events` 把源 sidecar 重映射进 `[in, out)` 播放区间，
//! 供 `rec_trim` 产物同名 sidecar 使用——事件跟着剪走，不掉不出。

use serde::Serialize;
use std::io::Write as _;
use std::path::Path;

use super::event_types::RecEvent;

#[derive(Serialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarEvent {
    Click {
        t: u64,
        x: i32,
        y: i32,
        button: &'static str,
    },
    Key {
        t: u64,
        combo: String,
    },
    Mark {
        t: u64,
    },
}

#[derive(Serialize, Debug)]
struct Region {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

#[derive(Serialize, Debug)]
struct SidecarDoc<'a> {
    version: u32,
    /// 视频时间轴时长（= rec-done 的 durationMs 口径）。
    duration_ms: u64,
    /// 录制区域（桌面绝对物理像素）。
    region: Region,
    /// 编码产物尺寸（缩放后）与帧率——画布系坐标 × (w/region.w) 即视频系。
    video: VideoInfo,
    /// 隐私与坐标口径说明（人读）。
    note: &'a str,
    events: &'a [SidecarEvent],
}

#[derive(Serialize, Debug)]
struct VideoInfo {
    w: u32,
    h: u32,
    fps: u32,
}

const NOTE: &str = "t = 视频时间轴 ms（暂停段不在内）；x/y = 画布系物理像素（裁剪后、缩放前，乘 video.w/region.w 得视频坐标）；普通字符键与 OEM 标点按隐私策略不记录";

/// 会话期事件累积器。`enabled=false` 时 `record` 是 no-op（不占内存）。
pub struct SidecarRecorder {
    enabled: bool,
    events: Vec<SidecarEvent>,
    truncated: bool,
}

impl SidecarRecorder {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            events: Vec::new(),
            truncated: false,
        }
    }

    pub fn active(&self) -> bool {
        self.enabled
    }

    /// 记录一条（t = 视频时间轴 ms）。事件坐标在会话主循环换算成画布系后传入。
    pub fn record(&mut self, ev: &RecEvent, canvas_xy: Option<(i32, i32)>, t_ms: u64) {
        if !self.enabled {
            return;
        }
        if self.events.len() >= 100_000 {
            self.truncated = true;
            return;
        }
        match ev {
            RecEvent::Click { button, .. } => {
                let Some((x, y)) = canvas_xy else { return };
                self.events.push(SidecarEvent::Click {
                    t: t_ms,
                    x,
                    y,
                    button: button.as_str(),
                });
            }
            RecEvent::Key { combo } => {
                self.events.push(SidecarEvent::Key {
                    t: t_ms,
                    combo: combo.clone(),
                });
            }
            RecEvent::Mark => {
                self.events.push(SidecarEvent::Mark { t: t_ms });
            }
        }
    }

    pub fn warning(&self) -> Option<&'static str> {
        self.truncated
            .then_some("事件轨达到 100000 条上限，已保存此前事件，后续未保存")
    }
    pub fn truncated(&self) -> bool {
        self.truncated
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    /// 收尾写出（同名 `.events.json`）。开着就写（无事件也是合法空轨道——
    /// 「同名必有」的确定性比省 200 字节重要）。失败返回 Err 由调用方附注。
    pub fn write(
        &self,
        mp4_path: &Path,
        duration_ms: u64,
        region: (i32, i32, u32, u32),
        video: (u32, u32, u32),
    ) -> Result<(), String> {
        if !self.enabled {
            return Ok(());
        }
        let doc = SidecarDoc {
            version: 1,
            duration_ms,
            region: Region {
                x: region.0,
                y: region.1,
                w: region.2,
                h: region.3,
            },
            video: VideoInfo {
                w: video.0,
                h: video.1,
                fps: video.2,
            },
            note: NOTE,
            events: &self.events,
        };
        let path = sidecar_path(mp4_path);
        let json = serde_json::to_vec_pretty(&doc).map_err(|e| format!("sidecar 序列化：{e}"))?;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("创建 {}：{e}", path.display()))?;
        f.write_all(&json)
            .and_then(|_| f.flush())
            .map_err(|e| format!("写 {}：{e}", path.display()))
    }
}

/// `x.mp4` → `x.events.json`。
pub fn sidecar_path(mp4_path: &Path) -> std::path::PathBuf {
    mp4_path.with_extension("events.json")
}

/// 裁剪重映射（纯函数）：保留 `t ∈ [in_ms, out_ms)` 的事件并平移到 0 基，
/// durationMs 改指选段时长。原 JSON 缺字段/坏结构 → None（调用方静默跳过，
/// 不为 sidecar 卡裁剪主流程）。
pub fn remap_events(raw: &serde_json::Value, in_ms: u64, out_ms: u64) -> Option<serde_json::Value> {
    if out_ms <= in_ms {
        return None;
    }
    let events = raw
        .get("events")
        .filter(|v| v.is_array())?
        .as_array()?
        .clone();
    let kept: Vec<serde_json::Value> = events
        .into_iter()
        .filter_map(|mut e| {
            let t = e.get("t")?.as_u64()?;
            if t < in_ms || t >= out_ms {
                return None;
            }
            if let Some(obj) = e.as_object_mut() {
                obj.insert("t".into(), serde_json::json!(t - in_ms));
            }
            Some(e)
        })
        .collect();
    let mut doc = raw.clone();
    let obj = doc.as_object_mut()?;
    obj.insert("durationMs".into(), serde_json::json!(out_ms - in_ms));
    obj.insert("events".into(), serde_json::json!(kept));
    Some(doc)
}

/// 裁剪产物的 sidecar：源存在才重映射写出；源不存在/坏结构静默跳过
/// （sidecar 是附属品，绝不影响裁剪主流程）。
pub fn write_sidecar_for_trim(src_mp4: &Path, dst_mp4: &Path, in_ms: u64, out_ms: u64) {
    let src = sidecar_path(src_mp4);
    let Ok(raw) = std::fs::read(&src) else { return };
    let Ok(doc) = serde_json::from_slice::<serde_json::Value>(&raw) else {
        log::warn!(
            "[Rec] 裁剪：源 sidecar 不是合法 JSON，跳过重映射（{}）",
            src.display()
        );
        return;
    };
    let Some(remapped) = remap_events(&doc, in_ms, out_ms) else {
        return;
    };
    let dst = sidecar_path(dst_mp4);
    match serde_json::to_vec_pretty(&remapped) {
        Ok(bytes) => {
            if let Err(e) = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&dst)
                .and_then(|mut file| file.write_all(&bytes).and_then(|_| file.flush()))
            {
                log::warn!("[Rec] 裁剪 sidecar 写入失败（{}）：{e}", dst.display());
            }
        }
        Err(e) => log::warn!("[Rec] 裁剪 sidecar 序列化失败：{e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rec::event_types::MouseBtn;

    fn doc(events: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "version": 1, "durationMs": 990, "events": events })
    }

    #[test]
    fn 记录器_关闭即noop_开启记三类() {
        let mut off = SidecarRecorder::new(false);
        off.record(&RecEvent::Mark, None, 5);
        assert_eq!(off.len(), 0);
        assert!(!off.active());

        let mut on = SidecarRecorder::new(true);
        on.record(
            &RecEvent::Click {
                x: 9,
                y: 9,
                button: MouseBtn::Left,
            },
            Some((3, 4)),
            10,
        );
        on.record(
            &RecEvent::Key {
                combo: "Ctrl+C".into(),
            },
            None,
            20,
        );
        on.record(&RecEvent::Mark, None, 30);
        assert_eq!(on.len(), 3);
    }

    #[test]
    fn bounded_events_and_existing_sidecar_are_preserved() {
        let mut recorder = SidecarRecorder::new(true);
        for time in 0..100_001 {
            recorder.record(&RecEvent::Mark, None, time);
        }
        assert_eq!(recorder.len(), 100_000);
        assert!(recorder.truncated());
        let folder = std::env::temp_dir().join(format!(
            "pp-sidecar-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&folder).unwrap();
        let path = folder.join("clip.mp4");
        let sidecar = sidecar_path(&path);
        std::fs::write(&sidecar, b"existing").unwrap();
        assert!(recorder
            .write(&path, 10, (0, 0, 10, 10), (10, 10, 30))
            .is_err());
        assert_eq!(std::fs::read(&sidecar).unwrap(), b"existing");
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn 重映射_过滤平移与时长() {
        let d = doc(serde_json::json!([
            { "t": 50, "type": "click", "x": 1, "y": 2, "button": "left" },
            { "t": 330, "type": "key", "combo": "Enter" },
            { "t": 700, "type": "mark" },
            { "t": 990, "type": "mark" } // 恰好出点：排除
        ]));
        let out = remap_events(&d, 100, 990).unwrap();
        assert_eq!(out["durationMs"], 890);
        let evs = out["events"].as_array().unwrap();
        // t=50 的点击在入点前被排除；t=990 恰在出点上被排除
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0]["t"], 230, "key 330→230");
        assert_eq!(evs[0]["combo"], "Enter");
        assert_eq!(evs[1]["t"], 600, "mark 700→600");
    }

    #[test]
    fn trim_rejects_invalid_ranges_and_preserves_unsigned_timestamps() {
        let time = i64::MAX as u64 + 10;
        let input = doc(serde_json::json!([{ "t": time, "type": "mark" }]));
        assert!(remap_events(&input, 10, 9).is_none());
        assert!(remap_events(&input, 10, 10).is_none());
        let result = remap_events(&input, time - 5, u64::MAX).unwrap();
        assert_eq!(result["events"][0]["t"], 5);
        assert_eq!(result["durationMs"], u64::MAX - (time - 5));
    }

    #[test]
    fn trim_preserves_existing_destination_sidecar() {
        let folder = std::env::temp_dir().join(format!(
            "pp-trim-sidecar-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&folder).unwrap();
        let source = folder.join("source.mp4");
        let target = folder.join("target.mp4");
        std::fs::write(
            sidecar_path(&source),
            serde_json::to_vec(&doc(serde_json::json!([{ "t": 20, "type": "mark" }]))).unwrap(),
        )
        .unwrap();
        std::fs::write(sidecar_path(&target), b"existing").unwrap();
        write_sidecar_for_trim(&source, &target, 0, 100);
        assert_eq!(std::fs::read(sidecar_path(&target)).unwrap(), b"existing");
        std::fs::remove_file(sidecar_path(&target)).unwrap();
        write_sidecar_for_trim(&source, &target, 0, 100);
        let result: serde_json::Value =
            serde_json::from_slice(&std::fs::read(sidecar_path(&target)).unwrap()).unwrap();
        assert_eq!(result["events"][0]["t"], 20);
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn 重映射_坏结构返回None() {
        assert!(remap_events(&serde_json::json!({ "events": "x" }), 0, 100).is_none());
        assert!(remap_events(&serde_json::json!({}), 0, 100).is_none());
        // 缺 t 的单条事件按「跳过」处理（宽容），不整体失败
        let out = remap_events(&doc(serde_json::json!([{ "type": "mark" }])), 0, 100).unwrap();
        assert_eq!(out["events"].as_array().unwrap().len(), 0);
    }
}
