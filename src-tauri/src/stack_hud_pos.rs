//! 栈浮标的**纯定位逻辑** —— 零 Tauri 依赖，全部可单测。
//!
//! ## 两套锚点，一条兜底链
//!
//! 1. **锚定目标窗口**（首选，2026-09-16 方案 A）：HUD 出现在解析出的粘贴目标
//!    窗口**右上角内侧**（右缘 16px、标题栏下方 40px），再加用户拖拽保存的偏移，
//!    最后钳制进锚点窗口所在显示器的 workarea。用户在哪个窗口操作，浮标就贴在
//!    哪个窗口旁边 —— 这是"显示在你要粘贴的地方"的直译。
//! 2. **贴光标候选序列**（兜底）：锚点拿不到时（前台是桌面/自身窗口），退回
//!    原有的光标四象限候选。
//!
//! 坐标约定：全部**物理像素**（与 `tray_manager::get_monitor_work_area` 一致）。

/// 工作区矩形（物理像素）
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WorkArea {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 光标与 HUD 的间距
pub const CURSOR_GAP: f64 = 16.0;
/// 工作区边缘安全边距（仅用于兜底的两个候选）
pub const EDGE_MARGIN: f64 = 8.0;
/// 锚定窗口右缘 → HUD 右缘的间距
pub const ANCHOR_MARGIN_RIGHT: f64 = 16.0;
/// 锚定窗口顶缘 → HUD 顶缘的间距（避开标题栏/工具栏按钮区）
pub const ANCHOR_CLEAR_TITLEBAR: f64 = 40.0;
/// 聚焦输入框与 HUD 之间的间距（右上 / 右下翻转时共用）
pub const CONTROL_GAP: f64 = 8.0;

/// 矩形是否**完整**落在工作区内。不完整就不算落位 —— 半个 HUD 露在屏幕外
/// 比换个位置更糟。
pub fn fits(x: f64, y: f64, w: f64, h: f64, wa: WorkArea) -> bool {
    x >= wa.x && y >= wa.y && x + w <= wa.x + wa.w && y + h <= wa.y + wa.h
}

/// 把落位钳制回工作区（工作区比 HUD 还小时贴左上角）。
pub fn clamp(x: f64, y: f64, w: f64, h: f64, wa: WorkArea) -> (f64, f64) {
    let max_x = wa.x + wa.w - w;
    let max_y = wa.y + wa.h - h;
    let x = if max_x < wa.x { wa.x } else { x.max(wa.x).min(max_x) };
    let y = if max_y < wa.y { wa.y } else { y.max(wa.y).min(max_y) };
    (x, y)
}

/// 纯函数：给定光标与工作区，返回 HUD 左上角坐标（物理像素）。
///
/// ## 顺序 = 用户找得到的顺序，不是几何上最不碍事的顺序
///
/// `screenshot.rs` 那段注释是血泪换来的：长截图状态窗第一版**固定四角**，
/// 理由是「系统通知区，用户天然会往那看」，实测结果是用户在屏幕左上角操作、
/// 控制条却在对角线另一头 —— **「找不到、以为没反应」**。
/// 栈 HUD 固定右下角会重蹈覆辙：用户的粘贴现场在屏幕任意位置。
///
/// ## 为什么「右上」是首选而不是「右下」
///
/// 连续粘贴时内容**向下**排布（逐行填表、逐条贴单号），右下会盖住刚贴出来的东西；
/// 右上盖住的是已经填完的上文。
///
/// 代价要认：贴光标就必然盖住相邻几行。不要为了"不挡字"把 HUD 挪到不挡的地方 ——
/// 那就不是真实位置了。靠不透明度（0.92 白 / 0.94 深）+ 描边让被盖内容透出后不可辨。
pub fn pick_pos(cx: f64, cy: f64, w: f64, h: f64, wa: WorkArea) -> (f64, f64) {
    let candidates = [
        (cx + CURSOR_GAP, cy - CURSOR_GAP - h), // ① 右上（首选）
        (cx + CURSOR_GAP, cy + CURSOR_GAP),     // ② 右下
        (cx - CURSOR_GAP - w, cy - CURSOR_GAP - h), // ③ 左上
        (cx - CURSOR_GAP - w, cy + CURSOR_GAP), // ④ 左下
        (wa.x + wa.w - EDGE_MARGIN - w, wa.y + wa.h - EDGE_MARGIN - h), // ⑤ 工作区右下
        (wa.x + wa.w - EDGE_MARGIN - w, wa.y + EDGE_MARGIN), // ⑥ 工作区右上
    ];
    for (x, y) in candidates {
        if fits(x, y, w, h, wa) {
            return (x, y);
        }
    }
    // 全不满足（工作区比 HUD 还小）：钳制兜底候选
    clamp(candidates[4].0, candidates[4].1, w, h, wa)
}

/// 控件矩形是否值得当作锚点：太碎或几乎等于整窗都没意义。
///
/// 面积阈值与 `screenshot.rs::uia_control_at` 对齐（MIN_SIDE=20），
/// 但这里用宽高分别判定，并额外要求高度能放下至少一行文字（≥16）。
pub fn control_rect_plausible(w: f64, h: f64, win_w: f64, win_h: f64) -> bool {
    const MIN_W: f64 = 40.0;
    const MIN_H: f64 = 16.0;
    if w < MIN_W || h < MIN_H {
        return false;
    }
    let win_area = win_w * win_h;
    if win_area <= 0.0 {
        return false;
    }
    // 几乎占满整窗 → 不是「输入框」，是宿主/编辑器整面
    if w * h * 100.0 > win_area * 95.0 {
        return false;
    }
    true
}

/// 纯函数：锚定聚焦输入框的落位（物理像素）。
///
/// 默认贴在控件**右上方**（HUD 右缘与控件右缘对齐、底边在控件顶边上方 `CONTROL_GAP`）。
/// 控件太靠屏顶、上方放不下时翻到**右下方**，并由 `below` 告诉前端方向尾朝哪边。
///
/// `offset` 语义与 [`anchor_pos`] 一致：用户拖拽保存的绝对偏移。
/// 返回 `None` 表示控件矩形退化，调用方应退回窗口锚。
pub fn control_anchor_pos(
    control: (f64, f64, f64, f64),
    offset: (f64, f64),
    w: f64,
    h: f64,
    wa: WorkArea,
) -> Option<(f64, f64, bool)> {
    let (ix, iy, iw, ih) = control;
    if iw <= 0.0 || ih <= 0.0 {
        return None;
    }
    // 右对齐：HUD 右缘贴控件右缘（比窗口级右对齐更贴输入框）
    let x_default = ix + iw - w;
    let y_above = iy - CONTROL_GAP - h;
    let y_below = iy + ih + CONTROL_GAP;
    let above_fits = y_above >= wa.y;
    let y_default = if above_fits { y_above } else { y_below };
    let (cx, cy) = clamp(x_default + offset.0, y_default + offset.1, w, h, wa);
    Some((cx, cy, !above_fits))
}

/// 纯函数：锚定目标窗口的落位（物理像素）。
///
/// `anchor` 是目标窗口矩形 `(x, y, w, h)`；`offset` 是用户拖拽保存的**绝对偏移**
/// （用户拖动后，HUD 与默认落位的差值——他调的是"贴在窗口的哪个位置"，不是
/// "贴在屏幕的哪个位置"，所以窗口换了偏移仍然生效）。
///
/// 返回 `None` 表示锚点无效（窗口矩形退化），调用方应退回光标候选。
/// 返回值保证钳制在工作区内。
pub fn anchor_pos(
    anchor: Option<(f64, f64, f64, f64)>,
    offset: (f64, f64),
    w: f64,
    h: f64,
    wa: WorkArea,
) -> Option<(f64, f64)> {
    let (ax, ay, aw, ah) = anchor?;
    if aw <= 0.0 || ah <= 0.0 {
        return None;
    }
    let dx = ax + aw - ANCHOR_MARGIN_RIGHT - w;
    let dy = ay + ANCHOR_CLEAR_TITLEBAR;
    Some(clamp(dx + offset.0, dy + offset.1, w, h, wa))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wa() -> WorkArea {
        WorkArea {
            x: 0.0,
            y: 0.0,
            w: 1920.0,
            h: 1040.0, // 减去任务栏
        }
    }

    // ===== pick_pos（光标候选）既有 6 测 =====

    /// 光标在屏幕中央 → 首选右上
    #[test]
    fn test_pick_prefers_top_right() {
        let (x, y) = pick_pos(960.0, 520.0, 208.0, 48.0, wa());
        assert_eq!(x, 960.0 + CURSOR_GAP);
        assert_eq!(y, 520.0 - CURSOR_GAP - 48.0);
    }

    /// 光标贴右边缘 → ① 与 ② 的 x 都越界，横向翻到**左侧**的 ③
    /// （横向翻转、纵向仍在上方 —— 这才是"贴着屏幕右边打字"时的正确落位）
    #[test]
    fn test_pick_flips_to_left_near_right_edge() {
        let (x, y) = pick_pos(1900.0, 520.0, 208.0, 48.0, wa());
        assert_eq!(x, 1900.0 - CURSOR_GAP - 208.0);
        assert_eq!(y, 520.0 - CURSOR_GAP - 48.0);
    }

    /// 窄工作区里四个贴光标候选全越界 → 落到 ⑤ 工作区右下兜底
    #[test]
    fn test_pick_uses_workarea_corner_in_narrow_workarea() {
        let narrow = WorkArea {
            x: 0.0,
            y: 0.0,
            w: 300.0,
            h: 1040.0,
        };
        let (x, y) = pick_pos(150.0, 200.0, 208.0, 48.0, narrow);
        assert_eq!(x, 300.0 - EDGE_MARGIN - 208.0);
        assert_eq!(y, 1040.0 - EDGE_MARGIN - 48.0);
    }

    /// 光标在左上角 → ① 与 ③ 都被纵向/横向挤掉，落到 ② 右下
    #[test]
    fn test_pick_falls_back_to_bottom_right_at_origin() {
        let (x, y) = pick_pos(2.0, 2.0, 208.0, 48.0, wa());
        assert_eq!(x, 2.0 + CURSOR_GAP);
        assert_eq!(y, 2.0 + CURSOR_GAP);
    }

    /// 结果必须完整落在工作区内（除工作区比 HUD 还小的病态情形）
    #[test]
    fn test_result_always_inside_workarea() {
        let area = wa();
        for cx in [0.0, 300.0, 960.0, 1700.0, 1919.0] {
            for cy in [0.0, 200.0, 520.0, 900.0, 1039.0] {
                let (x, y) = pick_pos(cx, cy, 208.0, 48.0, area);
                assert!(
                    x >= area.x && y >= area.y && x + 208.0 <= area.x + area.w && y + 48.0 <= area.y + area.h,
                    "cursor=({},{}) 落位=({},{}) 越出工作区",
                    cx,
                    cy,
                    x,
                    y
                );
            }
        }
    }

    /// 工作区比 HUD 还小 → 钳制到工作区左上角，不能返回负数坐标
    #[test]
    fn test_clamps_when_workarea_smaller_than_hud() {
        let tiny = WorkArea {
            x: 100.0,
            y: 100.0,
            w: 120.0,
            h: 30.0,
        };
        let (x, y) = pick_pos(150.0, 110.0, 208.0, 48.0, tiny);
        assert_eq!((x, y), (100.0, 100.0));
    }

    // ===== anchor_pos（锚定窗口，方案 A）=====

    /// 窗口在屏幕中央 → HUD 贴窗口右上内侧（右 16 / 下 40），零偏移
    #[test]
    fn test_anchor_default_top_right_inside_window() {
        let anchor = Some((660.0, 300.0, 600.0, 400.0));
        let (x, y) = anchor_pos(anchor, (0.0, 0.0), 208.0, 48.0, wa()).unwrap();
        assert_eq!(x, 660.0 + 600.0 - 16.0 - 208.0);
        assert_eq!(y, 300.0 + 40.0);
    }

    /// 窗口贴屏幕右缘（最大化）→ 默认落位越出工作区右缘，必须被钳回
    #[test]
    fn test_anchor_clamps_when_window_touches_right_edge() {
        // 最大化窗口：右缘 = 工作区右缘 1920
        let anchor = Some((0.0, 0.0, 1920.0, 1040.0));
        let (x, _) = anchor_pos(anchor, (0.0, 0.0), 208.0, 48.0, wa()).unwrap();
        // 默认 x = 1920 - 16 - 208 = 1696，未越界；构造更小的屏验证钳制：
        let small = WorkArea { x: 0.0, y: 0.0, w: 300.0, h: 1040.0 };
        let anchor2 = Some((0.0, 0.0, 400.0, 1040.0));
        let (x2, _) = anchor_pos(anchor2, (0.0, 0.0), 208.0, 48.0, small).unwrap();
        assert_eq!(x2, 300.0 - 208.0, "必须钳到工作区右缘内侧");
        let _ = x;
    }

    /// 用户偏移生效：拖到哪，相对位置就记住哪
    #[test]
    fn test_anchor_applies_user_offset() {
        let anchor = Some((660.0, 300.0, 600.0, 400.0));
        let (x, y) = anchor_pos(anchor, (-100.0, 60.0), 208.0, 48.0, wa()).unwrap();
        assert_eq!(x, 660.0 + 600.0 - 16.0 - 208.0 - 100.0);
        assert_eq!(y, 300.0 + 40.0 + 60.0);
    }

    /// 偏移把 HUD 推出工作区 → 钳回，绝不出屏
    #[test]
    fn test_anchor_offset_clamped_into_workarea() {
        let anchor = Some((660.0, 300.0, 600.0, 400.0));
        // 偏移 +5000 → y 远超工作区底部
        let (_, y) = anchor_pos(anchor, (0.0, 5000.0), 208.0, 48.0, wa()).unwrap();
        assert_eq!(y, 1040.0 - 48.0);
        // 偏移 -5000 → x/y 超出上/左缘
        let (x2, y2) = anchor_pos(anchor, (-5000.0, -5000.0), 208.0, 48.0, wa()).unwrap();
        assert_eq!((x2, y2), (0.0, 0.0));
    }

    /// 多显示器：锚点窗口在第二屏（workarea 原点非零），落位随其 workarea
    #[test]
    fn test_anchor_respects_second_monitor_origin() {
        let second = WorkArea { x: 1920.0, y: 0.0, w: 1920.0, h: 1040.0 };
        let anchor = Some((2100.0, 200.0, 800.0, 500.0));
        let (x, y) = anchor_pos(anchor, (0.0, 0.0), 208.0, 48.0, second).unwrap();
        assert_eq!(x, 2100.0 + 800.0 - 16.0 - 208.0);
        assert_eq!(y, 200.0 + 40.0);
        // 偏移 -900：默认落位 2676 → 1776，越过第二屏左缘 1920 → 钳回 1920
        let (x2, _) = anchor_pos(anchor, (-900.0, 0.0), 208.0, 48.0, second).unwrap();
        assert_eq!(x2, 1920.0);
    }

    /// 窗口矩形退化（宽/高 ≤ 0）→ 返回 None，调用方退回光标候选
    #[test]
    fn test_anchor_none_on_degenerate_rect() {
        assert!(anchor_pos(None, (0.0, 0.0), 208.0, 48.0, wa()).is_none());
        assert!(anchor_pos(Some((10.0, 10.0, 0.0, 400.0)), (0.0, 0.0), 208.0, 48.0, wa()).is_none());
        assert!(anchor_pos(Some((10.0, 10.0, 400.0, -1.0)), (0.0, 0.0), 208.0, 48.0, wa()).is_none());
    }

    // ===== control_anchor_pos（锚定聚焦输入框）=====

    /// 屏中部输入框 → HUD 贴其右上方（右对齐、上方 8px），below=false
    #[test]
    fn test_control_default_above_right() {
        let control = (600.0, 400.0, 300.0, 34.0);
        let (x, y, below) =
            control_anchor_pos(control, (0.0, 0.0), 240.0, 65.0, wa()).unwrap();
        assert_eq!(x, 600.0 + 300.0 - 240.0);
        assert_eq!(y, 400.0 - CONTROL_GAP - 65.0);
        assert!(!below);
    }

    /// 输入框贴屏顶 → 上方放不下，翻到右下方，below=true
    #[test]
    fn test_control_flips_below_near_top() {
        let control = (600.0, 20.0, 300.0, 34.0);
        let (x, y, below) =
            control_anchor_pos(control, (0.0, 0.0), 240.0, 65.0, wa()).unwrap();
        assert_eq!(x, 600.0 + 300.0 - 240.0);
        assert_eq!(y, 20.0 + 34.0 + CONTROL_GAP);
        assert!(below);
    }

    /// 用户偏移仍生效，且结果钳在工作区内
    #[test]
    fn test_control_offset_and_clamp() {
        let control = (600.0, 400.0, 300.0, 34.0);
        let (x, y, _) = control_anchor_pos(control, (-50.0, 10.0), 240.0, 65.0, wa()).unwrap();
        assert_eq!(x, 600.0 + 300.0 - 240.0 - 50.0);
        assert_eq!(y, 400.0 - CONTROL_GAP - 65.0 + 10.0);
        let (_, y2, _) = control_anchor_pos(control, (0.0, 9000.0), 240.0, 65.0, wa()).unwrap();
        assert_eq!(y2, 1040.0 - 65.0);
    }

    /// 控件矩形退化 → None
    #[test]
    fn test_control_none_on_degenerate() {
        assert!(control_anchor_pos((0.0, 0.0, 0.0, 30.0), (0.0, 0.0), 240.0, 65.0, wa()).is_none());
        assert!(control_anchor_pos((0.0, 0.0, 100.0, 0.0), (0.0, 0.0), 240.0, 65.0, wa()).is_none());
    }

    /// 控件合理性：太小 / 几乎整窗都拒绝
    #[test]
    fn test_control_rect_plausible() {
        assert!(control_rect_plausible(300.0, 34.0, 1920.0, 1040.0));
        assert!(!control_rect_plausible(20.0, 34.0, 1920.0, 1040.0));
        assert!(!control_rect_plausible(300.0, 10.0, 1920.0, 1040.0));
        assert!(!control_rect_plausible(1900.0, 1000.0, 1920.0, 1040.0));
    }
}
