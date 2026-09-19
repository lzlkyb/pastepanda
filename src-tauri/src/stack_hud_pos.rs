//! 栈浮标的**纯定位逻辑** —— 零 Tauri 依赖，全部可单测。
//!
//! ## 三套锚点，两级兜底
//!
//! 1. **锚定聚焦输入框**（首选）：贴 UIA / caret 探测到的输入框**右上方**。
//! 2. **锚定目标窗口**（2026-09-16 方案 A）：贴解析出的粘贴目标窗口**右上角内侧**
//!    （右缘 16px、标题栏下方 40px）。用户在哪个窗口操作，浮标就贴在哪个窗口旁边 ——
//!    这是"显示在你要粘贴的地方"的直译。
//! 3. **锚定光标下的窗口**（2026-09-17 加入，兜底一）：前台是桌面 / 任务栏 / 自身
//!    进程窗口时（上面两级的前提 `capture_foreground_now()` 不成立），退一步贴
//!    **鼠标底下那个窗口**的右上角。比"贴光标"好在两点：位置钉在**不随鼠标移动**
//!    的矩形上，且不压在光标上挡住用户正在看的内容。
//! 4. **贴光标候选序列**（兜底二）：连光标下都没有可锚窗口（光标在桌面上）时，
//!    退回光标四象限候选。
//!
//! 1 / 2 / 3 三级的落位都先加用户拖拽保存的偏移，最后钳制进锚点所在显示器的 workarea。
//!
//! ## ❗ 3 / 4 是「一次性落位」，不参与跟随
//!
//! 见 [`should_follow`]：光标类锚点算出来的是"鼠标此刻在屏幕的哪儿"，不是"用户的
//! 操作现场在哪儿"。而这条定位链会被 450ms 跟随轮询反复调用 —— 一旦允许光标锚
//! 每 tick 重算，等价于**浮标实时跟随鼠标**：用户移动鼠标时浮标一直黏在旁边挡视线。
//! 所以光标锚只在锚点类型**发生变化**的那一次落位，之后钉住不动
//! （用户切回目标应用 → 锚点变窗口/控件 → 照常跟过去）。
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

// ===== 锚点类型 =====
//
// 由定位链在算出落位时写入（`stack_hud.rs::store_anchor_kind`），两个消费方：
// 1. `emit_state` 把它写进 `StackHudState.anchor_kind` → 前端决定是否画方向尾；
// 2. [`should_follow`] 用它决定这次落位算不算"该把浮标挪过去"。

/// 未知 / 尚未定位过（每次「显示浮标」都会清回这个值，让本次显示能重新落位一次）
pub const ANCHOR_NONE: u8 = 0;
/// 聚焦输入框
pub const ANCHOR_CONTROL: u8 = 1;
/// 目标窗口右上内侧
pub const ANCHOR_WINDOW: u8 = 2;
/// 光标四象限（最后兜底）
pub const ANCHOR_CURSOR: u8 = 3;
/// 光标下的窗口右上内侧
pub const ANCHOR_CURSOR_WINDOW: u8 = 4;

/// 光标类锚点（③ 光标下窗口 / ④ 贴光标）—— 坐标源自**鼠标位置**，
/// 而不是"用户正在操作哪个窗口"。
pub fn is_cursor_anchor(kind: u8) -> bool {
    kind == ANCHOR_CURSOR || kind == ANCHOR_CURSOR_WINDOW
}

/// 纯判据：这次算出的落位是否构成「该把浮标挪过去」的理由。
///
/// 唯一的否决情形：**前后两次都是光标类锚点**。
///
/// 理由见模块注释 —— 光标类锚点的坐标源自鼠标位置，而这条链会被 450ms 跟随轮询
/// 与每次状态推送反复调用。不加这道拦截，浮标就等于实时跟随鼠标：
/// 用户一移动鼠标它就挪，一直黏在光标旁边挡住正在看的内容（用户实测反馈）。
///
/// ❗ 两类光标锚之间也必须互相拦住（3 ↔ 4）。用户把鼠标在桌面与窗口之间来回移动时，
/// 锚点类型会在两者间反复切换 —— 放行的话浮标就跟着鼠标在两个位置之间来回跳。
///
/// 允许的其它组合：
/// - `prev = NONE` → 首次落位 / 用户显式重新开栈（`mark_shown` 清回 NONE），要落位；
/// - 光标锚 → 窗口/控件锚：用户切回了某个应用，这是真实的现场变化，要跟过去；
/// - 窗口/控件锚 → 光标锚：鼠标下的现场变了（上一轮根本没有窗口锚），落一次；
/// - 窗口/控件锚之间互相切：都是真实操作现场，照常跟随。
pub fn should_follow(prev_kind: u8, now_kind: u8) -> bool {
    !(is_cursor_anchor(now_kind) && is_cursor_anchor(prev_kind))
}

/// 纯判据：光标下的那个窗口能不能当锚点。
///
/// ## 与 `paste_target::is_valid_target` 刻意不同
///
/// 那个判据回答"这条内容能粘到哪儿"，所以**必须排除自身进程**（粘给自己没意义）。
/// 这里回答的是"浮标该显示在哪儿"，两件事不同：用户在主窗口里操作时，浮标贴主窗口
/// 右上角是符合事实的，没必要排除。
///
/// 只排除两类：
/// - `hwnd == excluded_hwnd`：HUD 自己。它会 `always_on_top` 地待在最上层，
///   命中自己就会"以当前位置为锚点重新落位"，形成位置回环。
/// - 外壳窗口（桌面 / 任务栏）：贴上去等于浮到屏幕角落，与"贴操作现场"的准则相反
///   （表复用 `paste_target::SHELL_TARGET_CLASSES`，两处语义在这里是一致的）。
pub fn can_anchor_at_cursor(hwnd: isize, excluded_hwnd: isize, class_name: &str) -> bool {
    if hwnd == 0 || hwnd == excluded_hwnd {
        return false;
    }
    !crate::paste_target::is_shell_target_class(class_name)
}

/// 矩形是否**完整**落在工作区内。不完整就不算落位 —— 半个 HUD 露在屏幕外
/// 比换个位置更糟。
pub fn fits(x: f64, y: f64, w: f64, h: f64, wa: WorkArea) -> bool {
    x >= wa.x && y >= wa.y && x + w <= wa.x + wa.w && y + h <= wa.y + wa.h
}

/// 把落位钳制回工作区（工作区比 HUD 还小时贴左上角）。
pub fn clamp(x: f64, y: f64, w: f64, h: f64, wa: WorkArea) -> (f64, f64) {
    let max_x = wa.x + wa.w - w;
    let max_y = wa.y + wa.h - h;
    let x = if max_x < wa.x {
        wa.x
    } else {
        x.max(wa.x).min(max_x)
    };
    let y = if max_y < wa.y {
        wa.y
    } else {
        y.max(wa.y).min(max_y)
    };
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
        (cx + CURSOR_GAP, cy - CURSOR_GAP - h),     // ① 右上（首选）
        (cx + CURSOR_GAP, cy + CURSOR_GAP),         // ② 右下
        (cx - CURSOR_GAP - w, cy - CURSOR_GAP - h), // ③ 左上
        (cx - CURSOR_GAP - w, cy + CURSOR_GAP),     // ④ 左下
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
                    x >= area.x
                        && y >= area.y
                        && x + 208.0 <= area.x + area.w
                        && y + 48.0 <= area.y + area.h,
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
        let small = WorkArea {
            x: 0.0,
            y: 0.0,
            w: 300.0,
            h: 1040.0,
        };
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
        let second = WorkArea {
            x: 1920.0,
            y: 0.0,
            w: 1920.0,
            h: 1040.0,
        };
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
        assert!(anchor_pos(
            Some((10.0, 10.0, 0.0, 400.0)),
            (0.0, 0.0),
            208.0,
            48.0,
            wa()
        )
        .is_none());
        assert!(anchor_pos(
            Some((10.0, 10.0, 400.0, -1.0)),
            (0.0, 0.0),
            208.0,
            48.0,
            wa()
        )
        .is_none());
    }

    // ===== control_anchor_pos（锚定聚焦输入框）=====

    /// 屏中部输入框 → HUD 贴其右上方（右对齐、上方 8px），below=false
    #[test]
    fn test_control_default_above_right() {
        let control = (600.0, 400.0, 300.0, 34.0);
        let (x, y, below) = control_anchor_pos(control, (0.0, 0.0), 240.0, 65.0, wa()).unwrap();
        assert_eq!(x, 600.0 + 300.0 - 240.0);
        assert_eq!(y, 400.0 - CONTROL_GAP - 65.0);
        assert!(!below);
    }

    /// 输入框贴屏顶 → 上方放不下，翻到右下方，below=true
    #[test]
    fn test_control_flips_below_near_top() {
        let control = (600.0, 20.0, 300.0, 34.0);
        let (x, y, below) = control_anchor_pos(control, (0.0, 0.0), 240.0, 65.0, wa()).unwrap();
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
        assert!(
            control_anchor_pos((0.0, 0.0, 100.0, 0.0), (0.0, 0.0), 240.0, 65.0, wa()).is_none()
        );
    }

    /// 控件合理性：太小 / 几乎整窗都拒绝
    #[test]
    fn test_control_rect_plausible() {
        assert!(control_rect_plausible(300.0, 34.0, 1920.0, 1040.0));
        assert!(!control_rect_plausible(20.0, 34.0, 1920.0, 1040.0));
        assert!(!control_rect_plausible(300.0, 10.0, 1920.0, 1040.0));
        assert!(!control_rect_plausible(1900.0, 1000.0, 1920.0, 1040.0));
    }

    // ===== should_follow（跟随白名单）=====

    /// ❗ 核心判据：光标类锚点之间一律不跟随（含 3 ↔ 4 互相切换）。
    /// 对应的用户场景：开栈后鼠标一移动浮标就跟着跑、挡住视线。
    #[test]
    fn test_cursor_anchors_never_follow_each_other() {
        for now in [ANCHOR_CURSOR, ANCHOR_CURSOR_WINDOW] {
            for prev in [ANCHOR_CURSOR, ANCHOR_CURSOR_WINDOW] {
                assert!(
                    !should_follow(prev, now),
                    "光标类锚点（{prev} → {now}）重复算出的落位只是在跟随鼠标，必须拒绝"
                );
            }
        }
    }

    /// 首次落位（类型未知）必须允许，否则光标兜底这条链永远用不上。
    /// 少了这条，一个「恒返回 false」的退化实现也能让上面那条测试通过。
    #[test]
    fn test_first_placement_allowed() {
        assert!(should_follow(ANCHOR_NONE, ANCHOR_CURSOR));
        assert!(should_follow(ANCHOR_NONE, ANCHOR_WINDOW));
        assert!(should_follow(ANCHOR_NONE, ANCHOR_CONTROL));
        assert!(should_follow(ANCHOR_NONE, ANCHOR_CURSOR_WINDOW));
    }

    /// 光标锚 → 真实锚点：用户切回了某个应用，是现场变化，必须跟过去。
    #[test]
    fn test_switching_from_cursor_to_real_anchor_follows() {
        assert!(should_follow(ANCHOR_CURSOR, ANCHOR_WINDOW));
        assert!(should_follow(ANCHOR_CURSOR, ANCHOR_CONTROL));
        assert!(should_follow(ANCHOR_CURSOR_WINDOW, ANCHOR_CONTROL));
        assert!(should_follow(ANCHOR_CURSOR_WINDOW, ANCHOR_WINDOW));
    }

    /// 真实锚点之间照常跟随（Tab 换输入框、切窗口都要动）；
    /// 真实锚点 → 光标锚也放行一次（鼠标下的现场变了才会算出这个）。
    #[test]
    fn test_real_anchors_always_follow() {
        assert!(should_follow(ANCHOR_CONTROL, ANCHOR_CONTROL));
        assert!(should_follow(ANCHOR_WINDOW, ANCHOR_WINDOW));
        assert!(should_follow(ANCHOR_WINDOW, ANCHOR_CONTROL));
        assert!(should_follow(ANCHOR_CONTROL, ANCHOR_WINDOW));
        assert!(should_follow(ANCHOR_WINDOW, ANCHOR_CURSOR_WINDOW));
        assert!(should_follow(ANCHOR_CONTROL, ANCHOR_CURSOR));
    }

    // ===== can_anchor_at_cursor（光标下窗口判据）=====

    /// 普通应用窗口可以当锚点 —— 且**不涉及进程归属**（与 is_valid_target 的差异）。
    #[test]
    fn test_cursor_window_accepts_normal_window() {
        assert!(can_anchor_at_cursor(1234, 9999, "Chrome_WidgetWin_1"));
        assert!(can_anchor_at_cursor(1234, 9999, "Notepad"));
    }

    /// HUD 自己不能当锚点：它 always_on_top 地待在最上层，
    /// 命中自己会「以当前位置为锚点重新落位」，形成位置回环。
    #[test]
    fn test_cursor_window_rejects_hud_itself() {
        assert!(!can_anchor_at_cursor(1234, 1234, "Chrome_WidgetWin_1"));
    }

    /// 空句柄（光标下没有窗口）不能当锚点。
    #[test]
    fn test_cursor_window_rejects_empty_hwnd() {
        assert!(!can_anchor_at_cursor(0, 1234, "Notepad"));
    }

    /// 桌面 / 任务栏必须拒绝 —— 贴上去等于浮到屏幕角落，与"贴操作现场"的准则相反。
    #[test]
    fn test_cursor_window_rejects_shell_windows() {
        for name in [
            "Progman",
            "WorkerW",
            "Shell_TrayWnd",
            "Shell_SecondaryTrayWnd",
        ] {
            assert!(
                !can_anchor_at_cursor(1234, 0, name),
                "外壳窗口 {} 不能当浮标锚点",
                name
            );
        }
    }

    /// 取不到类名（窗口正在销毁）时不额外拒绝 —— 与 `paste_target` 的取向一致：
    /// 误拒会白白退化到"贴光标"，而该拦的外壳窗口类名一定取得回来。
    #[test]
    fn test_cursor_window_tolerates_empty_class() {
        assert!(can_anchor_at_cursor(1234, 0, ""));
    }
}
