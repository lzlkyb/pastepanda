use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    pub id: String,
    pub path: String,
    pub name: String,
    pub source: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Rect {
    pub fn contains(self, x: f64, y: f64, pad: f64) -> bool {
        x >= self.x - pad
            && y >= self.y - pad
            && x <= self.x + self.width + pad
            && y <= self.y + self.height + pad
    }
    pub fn valid(self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|n| n.is_finite())
            && self.width > 0.0
            && self.height > 0.0
    }
}

/// 取下时保持原始物理像素尺寸；只调整落点，超屏图片由用户自行缩放。
pub fn actual_pin_rect(desired: Rect, width: u32, height: u32, work_area: Rect) -> Rect {
    let mut rect = Rect {
        width: width as f64,
        height: height as f64,
        ..desired
    };
    if work_area.valid() {
        rect.x = rect.x.clamp(
            work_area.x,
            (work_area.x + work_area.width - rect.width).max(work_area.x),
        );
        rect.y = rect.y.clamp(
            work_area.y,
            (work_area.y + work_area.height - rect.height).max(work_area.y),
        );
    }
    rect
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pin {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub point: Option<[f64; 2]>,
    pub hwnd: isize,
    pub generation: u64,
    pub path: String,
    pub rect: Rect,
}

pub fn should_commit_pin_move(origin: Option<(i32, i32)>, position: (i32, i32), held: bool) -> bool {
    // Leaving the native move loop can mean capture interruption, not mouse-up.
    !held && origin.is_some_and(|point| point != position)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub items: Vec<Photo>,
    pub enabled: bool,
    pub wind: bool,
    pub locked: bool,
    pub anchors: Option<serde_json::Value>,
    pub work_area: Rect,
    pub scale: f64,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            items: vec![],
            enabled: true,
            wind: true,
            locked: false,
            anchors: None,
            work_area: Rect::default(),
            scale: 1.0,
        }
    }
}
#[derive(Default)]
pub struct Model {
    pub snapshot: Snapshot,
    seen: VecDeque<String>,
    pub regions: Vec<Rect>,
    pub dragging: bool,
    pub suspended: bool,
    pub captures: usize,
    pub transfers: usize,
    pub pending_pin: Option<(Pin, bool)>,
}
impl Model {
    // 局部保存缺键代表“不修改”，不能把默认开启项静默关闭。
    pub fn configure(&mut self, value: &serde_json::Value) {
        if let Some(v) = value.get("clothesline").and_then(|v| v.as_bool()) {
            self.snapshot.enabled = v;
        }
        if let Some(v) = value.get("clothesline_wind").and_then(|v| v.as_bool()) {
            self.snapshot.wind = v;
        }
        if let Some(v) = value.get("clothesline_locked").and_then(|v| v.as_bool()) {
            self.snapshot.locked = v;
        }
        if let Some(v) = value.get("clothesline_anchors") {
            self.snapshot.anchors = valid_anchors(v).then(|| v.clone());
        }
    }
    pub fn collect(&mut self, photo: Photo, capture_key: String) -> bool {
        if !self.snapshot.enabled || self.seen.contains(&capture_key) {
            return false;
        }
        self.seen.push_back(capture_key);
        if self.seen.len() > 512 {
            self.seen.pop_front();
        }
        self.insert(photo, None);
        true
    }
    pub fn insert(&mut self, photo: Photo, slot: Option<usize>) {
        self.snapshot.items.retain(|i| i.id != photo.id);
        let index = slot
            .unwrap_or(self.snapshot.items.len())
            .min(self.snapshot.items.len());
        self.snapshot.items.insert(index, photo);
    }
    pub fn remove(&mut self, ids: &[String]) -> Vec<Photo> {
        let removed = self
            .snapshot
            .items
            .iter()
            .filter(|i| ids.contains(&i.id))
            .cloned()
            .collect();
        self.snapshot.items.retain(|i| !ids.contains(&i.id));
        removed
    }
    pub fn restore(&mut self, snapshot: Vec<Photo>) {
        let new = self.snapshot.items.clone();
        let mut restored: Vec<Photo> = snapshot
            .into_iter()
            .filter(|i| !new.iter().any(|n| n.id == i.id))
            .collect();
        restored.extend(new);
        self.snapshot.items = restored;
    }
    pub fn hit(&self, x: f64, y: f64, pad: f64, pressed_inside: bool) -> bool {
        !self.suspended
            && self.captures == 0
            && self.transfers == 0
            && self.snapshot.enabled
            // Drag IPC can arrive after the pointer leaves its original hit region.
            // Keep an existing press interactive until release; OLE/capture gates still win.
            && (pressed_inside || self.dragging || self.regions.iter().any(|r| r.contains(x, y, pad)))
    }
}
pub fn valid_anchors(value: &serde_json::Value) -> bool {
    ["left", "right"].iter().all(|side| {
        ["x", "y"].iter().all(|axis| {
            value
                .get(side)
                .and_then(|p| p.get(axis))
                .and_then(|n| n.as_f64())
                .is_some_and(|n| n.is_finite() && (0.0..=1.0).contains(&n))
        })
    }) && value["left"]["x"].as_f64() < value["right"]["x"].as_f64()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interrupted_pin_move_never_hangs_until_mouse_release() {
        assert!(!should_commit_pin_move(Some((10, 10)), (30, 40), true));
        assert!(should_commit_pin_move(Some((10, 10)), (30, 40), false));
        assert!(!should_commit_pin_move(Some((10, 10)), (10, 10), false));
        assert!(!should_commit_pin_move(None, (30, 40), false));
    }
    #[test]
    fn actual_size_ignores_thumbnail_and_only_adjusts_position() {
        let area = Rect {
            x: -1920.0,
            y: 80.0,
            width: 1920.0,
            height: 1000.0,
        };
        let thumb = Rect {
            x: -200.0,
            y: 900.0,
            width: 240.0,
            height: 180.0,
        };
        let pin = actual_pin_rect(thumb, 1200, 800, area);
        assert_eq!((pin.width, pin.height), (1200.0, 800.0));
        assert_eq!((pin.x, pin.y), (-1200.0, 280.0));
        let oversized = actual_pin_rect(thumb, 3000, 2000, area);
        assert_eq!((oversized.width, oversized.height), (3000.0, 2000.0));
        assert_eq!((oversized.x, oversized.y), (area.x, area.y));
    }
    fn photo(id: &str) -> Photo {
        Photo {
            id: id.into(),
            path: format!("{id}.png"),
            name: id.into(),
            source: "截图".into(),
            width: 200,
            height: 120,
        }
    }
    #[test]
    fn partial_config_preserves_defaults_and_explicit_false() {
        let mut m = Model::default();
        m.configure(&serde_json::json!({"ocr_select_mode":"smart"}));
        assert!(m.snapshot.enabled);
        m.configure(&serde_json::json!({"clothesline":false}));
        m.configure(&serde_json::json!({"theme":"ocean"}));
        assert!(!m.snapshot.enabled);
    }
    #[test]
    fn metadata_update_does_not_rehang_but_new_capture_can() {
        let mut m = Model::default();
        assert!(m.collect(photo("a"), "a:time1".into()));
        m.remove(&["a".into()]);
        assert!(!m.collect(photo("a"), "a:time1".into()));
        assert!(m.collect(photo("a"), "a:time2".into()));
    }
    #[test]
    fn clear_undo_preserves_new_images_without_duplicate() {
        let mut m = Model::default();
        m.insert(photo("a"), None);
        let old = m.remove(&["a".into()]);
        m.insert(photo("b"), None);
        m.restore(old.clone());
        m.restore(old);
        assert_eq!(
            m.snapshot
                .items
                .iter()
                .map(|i| i.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b"]
        );
    }
    #[test]
    fn click_through_excludes_blank_space_and_suspension() {
        let mut m = Model::default();
        m.regions.push(Rect {
            x: 10.0,
            y: 20.0,
            width: 100.0,
            height: 40.0,
        });
        assert!(m.hit(50.0, 30.0, 2.0, false));
        assert!(!m.hit(300.0, 300.0, 2.0, false));
        m.dragging = true;
        assert!(m.hit(300.0, 300.0, 2.0, false));
        m.transfers = 1;
        assert!(!m.hit(50.0, 30.0, 2.0, false));
        m.transfers = 0;
        m.suspended = true;
        assert!(!m.hit(50.0, 30.0, 2.0, false));
    }
    #[test]
    fn held_press_keeps_capture_before_drag_ipc_arrives_but_yields_to_native_transfer() {
        let mut m = Model::default();
        assert!(!m.hit(800.0, 600.0, 2.0, false));
        assert!(m.hit(800.0, 600.0, 2.0, true));
        m.transfers = 1;
        assert!(!m.hit(800.0, 600.0, 2.0, true));
        m.transfers = 0;
        m.suspended = true;
        assert!(!m.hit(800.0, 600.0, 2.0, true));
    }
    #[test]
    fn malformed_saved_position_falls_back_to_default() {
        let mut m = Model::default();
        m.configure(
            &serde_json::json!({"clothesline_anchors":{"left":{"x":0.5},"right":{"y":0.2}}}),
        );
        assert!(m.snapshot.anchors.is_none());
        assert!(!valid_anchors(
            &serde_json::json!({"left":{"x":0.8,"y":0.1},"right":{"x":0.2,"y":0.1}})
        ));
        assert!(valid_anchors(
            &serde_json::json!({"left":{"x":0.02,"y":0.1},"right":{"x":0.8,"y":0.1}})
        ));
    }
}
