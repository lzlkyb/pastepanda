//! 岛的**停靠锚点**（方案 C1，设计稿 `design/待办灵动岛-停靠位置-设计稿.html`）。
//!
//! ## 它解决的问题
//!
//! 岛原本只有一个落位：主屏**水平居中 × 顶边**。那块 208×32 的胶囊常驻在最容易点到
//! 的地方（浏览器标签栏 / 应用标题栏），用户抱怨「附近要关的窗口我点不到」——
//! 居中档正压在标题栏中间，左右两档和底边三档才是让路。
//!
//! ## 六档 = 2 条边 × 3 个横向位置
//!
//! 边距只有 `EDGE_MARGIN` 一个数（左右档各留 16 逻辑px，贴 0 时圆帽会顶进屏幕圆角）。
//! 顶档 `y = wa.top` 恒定（顶边钉住、向下长），底档 `y = wa.bottom − h` **逐帧随 h 变**
//! （底边钉住、向上长）——这就是 `animate_window` 每步都要带 `h` 来问一次的原因。
//!
//! ## 为什么用 work_area 而不是整屏
//!
//! 底部三档若按整屏高度算，岛会压在任务栏上（任务栏在最上层，岛点不动也看不清）。
//! `work_area` 已经排掉任务栏 / Dock，顶档顺带也在任务栏在顶时落到它下面——
//! 两侧口径一致，比「顶边贴整屏、底边贴工作区」这种混搭好解释。
//!
//! ## 单位教训（从 `calc_top_center_for` 原样继承，别重复踩）
//!
//! 宽高常量是**逻辑**值（CSS px），而 `monitor.work_area()` 是**物理**像素。
//! 第一版把两者直接相减，125% 缩放下实测偏右 26px（正好 `(物理宽 − 逻辑宽) / 2`）。
//! 修法是**整条链路统一逻辑空间**：工作区矩形除以 `scale`，返回 `LogicalPosition`
//! 交 Tauri 折算。混用单位在 100% 缩放下差值恰好为 0、**完全看不出来**。

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU8, Ordering};
use tauri::{AppHandle, LogicalPosition};

/// 左右档与屏幕边的间距（逻辑px）。0 会让半胶囊的圆帽顶进屏幕圆角，16 是设计稿 §5 拍板值。
pub const EDGE_MARGIN: f64 = 16.0;

/// 六个停靠锚点。**变体顺序 = `as_u8` 编码顺序**，也是设置页六宫格的阅读顺序。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IslandAnchor {
    TopLeft,
    TopCenter,
    TopRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

/// 缺省档 = 现款观感（顶 · 中）：升级后已有用户的岛位置不变。
pub const DEFAULT_ANCHOR: IslandAnchor = IslandAnchor::TopCenter;

static CURRENT_ANCHOR: AtomicU8 = AtomicU8::new(DEFAULT_ANCHOR.code());

impl IslandAnchor {
    /// const 上下文可用（静态初值要用），故与 `from_code` 手工对齐而非 once_cell。
    const fn code(self) -> u8 {
        match self {
            IslandAnchor::TopLeft => 0,
            IslandAnchor::TopCenter => 1,
            IslandAnchor::TopRight => 2,
            IslandAnchor::BottomLeft => 3,
            IslandAnchor::BottomCenter => 4,
            IslandAnchor::BottomRight => 5,
        }
    }

    fn from_code(v: u8) -> IslandAnchor {
        match v {
            0 => IslandAnchor::TopLeft,
            2 => IslandAnchor::TopRight,
            3 => IslandAnchor::BottomLeft,
            4 => IslandAnchor::BottomCenter,
            5 => IslandAnchor::BottomRight,
            _ => IslandAnchor::TopCenter,
        }
    }

    /// config 里的字符串形式（与前端 `src/lib/todo/anchor.ts` 同一份账）。
    pub const fn as_str(self) -> &'static str {
        match self {
            IslandAnchor::TopLeft => "top-left",
            IslandAnchor::TopCenter => "top-center",
            IslandAnchor::TopRight => "top-right",
            IslandAnchor::BottomLeft => "bottom-left",
            IslandAnchor::BottomCenter => "bottom-center",
            IslandAnchor::BottomRight => "bottom-right",
        }
    }

    /// 解析 config 字符串。识别不了返回 `None`，让调用方回落到缺省档——
    /// 不把「读到脏值」当成「读到 top-center」，日志里才看得见是回落。
    pub fn from_str(s: &str) -> Option<IslandAnchor> {
        match s {
            "top-left" => Some(IslandAnchor::TopLeft),
            "top-center" => Some(IslandAnchor::TopCenter),
            "top-right" => Some(IslandAnchor::TopRight),
            "bottom-left" => Some(IslandAnchor::BottomLeft),
            "bottom-center" => Some(IslandAnchor::BottomCenter),
            "bottom-right" => Some(IslandAnchor::BottomRight),
            _ => None,
        }
    }

    /// 贴底档（决定「向上长」与停靠形状压平哪条边）。
    pub fn is_bottom(self) -> bool {
        self.code() >= 3
    }
}

/// 记下锚点（`island_config` 读配置时刷新，定位路径只读缓存）。
pub fn set_anchor(anchor: IslandAnchor) {
    CURRENT_ANCHOR.store(anchor.code(), Ordering::SeqCst);
}

/// 当前锚点。定位路径每帧读它（原子读，无锁）。
pub fn anchor() -> IslandAnchor {
    IslandAnchor::from_code(CURRENT_ANCHOR.load(Ordering::SeqCst))
}

/// 纯函数：六档落位公式（逻辑px 进、逻辑px 出，不碰 AppHandle 所以全平台可单测）。
///
/// - `(wa_x, wa_y, wa_w, wa_h)` = 主屏**工作区**逻辑矩形；
/// - `(w, h)` = 当前舞台尺寸；`m` = 左右边距。
pub fn anchor_origin(
    anchor: IslandAnchor,
    wa_x: f64,
    wa_y: f64,
    wa_w: f64,
    wa_h: f64,
    w: f64,
    h: f64,
    m: f64,
) -> (f64, f64) {
    let x = match anchor {
        IslandAnchor::TopLeft | IslandAnchor::BottomLeft => wa_x + m,
        IslandAnchor::TopCenter | IslandAnchor::BottomCenter => wa_x + (wa_w - w) / 2.0,
        IslandAnchor::TopRight | IslandAnchor::BottomRight => wa_x + wa_w - m - w,
    };
    // 顶档：y 与 h 无关（顶边钉住，展开只向下长）。
    // 底档：y 随 h 逐帧变（底边钉住，展开只向上长）——动画每帧重算的就是这里。
    let y = if anchor.is_bottom() {
        wa_y + wa_h - h
    } else {
        wa_y
    };
    (x, y)
}

/// 按当前锚点算窗口落位（逻辑坐标，交 `set_position` 折算）。
///
/// 一次性定位（`create` / `recenter`）用它。**动画不用它**——逐帧走
/// [`AnchorFrame::rect`]（尺寸 + 位置一次算全、物理像素口径），理由见那个类型。
pub fn calc_anchor_pos(app: &AppHandle, w: f64, h: f64) -> LogicalPosition<f64> {
    let Some(m) = app.primary_monitor().ok().flatten() else {
        // 取不到主屏信息（极罕见）：落 (0,0) 交给窗口系统，不猜分辨率——
        // 猜错的岛会落在屏幕外，比偏一点更难排查。
        return LogicalPosition { x: 0.0, y: 0.0 };
    };
    let scale = m.scale_factor();
    let wa = m.work_area();
    let (x, y) = anchor_origin(
        anchor(),
        wa.position.x as f64 / scale,
        wa.position.y as f64 / scale,
        wa.size.width as f64 / scale,
        wa.size.height as f64 / scale,
        w,
        h,
        EDGE_MARGIN,
    );
    LogicalPosition { x, y }
}

/// 动画用的**一帧窗口矩形**：主屏工作区（物理px）+ scale，取一次，逐帧复用。
///
/// ## 为什么动画不复用 [`calc_anchor_pos`]
///
/// 逐帧形变原先每帧调 `window.set_size()` + `window.set_position()`。查 Tauri 2.11.3 源码：
/// 两个方法都是 `send_user_message` → **投两条消息**给主线程事件循环，主线程分别执行
/// `set_inner_size`（WM_SIZE，连带 WebView2 控制器重排）和 `SetWindowPos`
/// （WM_WINDOWPOSCHANGED）。后果两条，都是用户看到的「卡」：
///
/// 1. 尺寸与位置落在**两个 vsync** 上 → 有一帧「已经变大但还没挪到锚点」，观感是抖；
/// 2. 投递不阻塞动画线程 → 主线程一慢，队列就堆积，之后连续回放 = 「顿一下再窜到位」。
///
/// 改法：**仍然一次 Win32 `SetWindowPos` 同时给尺寸与位置**（保住原子），但这次调用
/// 由 `run_on_main_thread` **投回主线程队列**执行，不再从动画线程直接 send ——
/// 2026-09-28 实测：直接 send 会把窗口甩到 WebView2 绘制前面 1–4 帧（窗口 385×186 时
/// 画面还是 322×40），观感从「卡」变成「形状/边缘不对」；投回队列则缩放与绘制同队列
/// 排队，窗口不可能超过内容。背压改由 `todo_island_stage::DISPATCH_IN_FLIGHT` 承担
/// （在飞最多一条，追不上丢帧不排队）。本类型就是那次调用要的四个数，纯算、可单测。
///
/// ## 单位账（延续模块头那条 🔴 教训）
///
/// 舞台尺寸是**逻辑**px，`work_area` 是**物理**px。这里显式收口成一套：入参逻辑、
/// 出参物理，且**钉边那两条按物理像素取整**——底档 `y = wa.bottom − h(物理)` 让底边
/// 逐帧零误差钉死，逻辑口径来回折算会在 125%/150% 下留 ±1px 呼吸。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AnchorFrame {
    /// 主屏工作区左上角（物理px）
    pub wa_x: f64,
    pub wa_y: f64,
    /// 主屏工作区尺寸（物理px）
    pub wa_w: f64,
    pub wa_h: f64,
    pub scale: f64,
    /// 窗口矩形 − 客户区（物理px）。**每次动画起头现取，不许写死**：`SetWindowPos` 吃的是
    /// 窗口矩形，而 Tauri 的 `set_size` 吃的是客户区，两条路径下达出来的窗口不是同一个数
    /// ——2026-09-28 同日实测到两种状态：`set_size` 之后是 260×40（客户区）/ 260×47（窗口矩形），
    /// 而逐帧 `SetWindowPos` 之后是 260×40 / 260×40（差值归零）。写死 7 或写死 0 都会错，
    /// 所以 [`AnchorFrame::capture`] 每次都重新量。
    pub frame_w: i32,
    pub frame_h: i32,
}

impl AnchorFrame {
    /// 动画起头取一次：主屏工作区 + scale + 客户区/窗口矩形差值。
    ///
    /// 三个数都来自 Tauri 自己的取值器（`window_getter!`：投消息给主线程再等回执），
    /// 所以**只在起头取**，逐帧复用；取不到主屏返回 `None`（调用方放弃本次动画，不猜分辨率）。
    pub fn capture(app: &AppHandle, window: &tauri::WebviewWindow) -> Option<Self> {
        let m = app.primary_monitor().ok().flatten()?;
        let wa = m.work_area();
        let (Ok(outer), Ok(inner)) = (window.outer_size(), window.inner_size()) else {
            return None;
        };
        Some(Self {
            wa_x: wa.position.x as f64,
            wa_y: wa.position.y as f64,
            wa_w: wa.size.width as f64,
            wa_h: wa.size.height as f64,
            scale: m.scale_factor(),
            frame_w: outer.width as i32 - inner.width as i32,
            frame_h: outer.height as i32 - inner.height as i32,
        })
    }

    /// 逻辑 `(w, h)` → 一帧的窗口矩形 `(x, y, w, h)`（**物理px，窗口矩形口径**，
    /// 可直接交给 `SetWindowPos`）。锚点由参数传入（不读缓存），为了让单测能逐档扫
    /// 而不是被全局状态绑住。
    pub fn rect(&self, anchor: IslandAnchor, w_logical: f64, h_logical: f64) -> (i32, i32, u32, u32) {
        let m = EDGE_MARGIN * self.scale;
        // 客户区尺寸（= Tauri `set_size` 的语义）+ 窗口矩形补偿
        let w = (w_logical * self.scale).round().max(1.0) as i32 + self.frame_w;
        let h = (h_logical * self.scale).round().max(1.0) as i32 + self.frame_h;
        let x = match anchor {
            IslandAnchor::TopLeft | IslandAnchor::BottomLeft => (self.wa_x + m).round() as i32,
            IslandAnchor::TopCenter | IslandAnchor::BottomCenter => {
                (self.wa_x + (self.wa_w - w as f64) / 2.0).round() as i32
            }
            IslandAnchor::TopRight | IslandAnchor::BottomRight => {
                (self.wa_x + self.wa_w - m - w as f64).round() as i32
            }
        };
        // 顶档 y 与 h 无关（顶边钉住）；底档 y 随 h 逐帧重算（底边钉住、向上长）。
        let y = if anchor.is_bottom() {
            (self.wa_y + self.wa_h - h as f64).round() as i32
        } else {
            self.wa_y.round() as i32
        };
        (x, y, w.max(1) as u32, h.max(1) as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 编码与 `from_code` 必须一一对应（`is_bottom` 依赖「3/4/5 是底档」这个顺序）。
    #[test]
    fn test_anchor_code_roundtrip() {
        for (i, a) in [
            IslandAnchor::TopLeft,
            IslandAnchor::TopCenter,
            IslandAnchor::TopRight,
            IslandAnchor::BottomLeft,
            IslandAnchor::BottomCenter,
            IslandAnchor::BottomRight,
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(a.code(), i as u8);
            assert_eq!(IslandAnchor::from_code(a.code()), a);
            assert_eq!(IslandAnchor::from_code(99), DEFAULT_ANCHOR, "脏编码回落缺省档");
            assert_eq!(a.is_bottom(), i >= 3);
        }
    }

    /// `as_str` / `from_str` 必须闭环：前端存的字符串要能被 Rust 原样读回。
    #[test]
    fn test_anchor_str_roundtrip() {
        for a in [
            IslandAnchor::TopLeft,
            IslandAnchor::TopCenter,
            IslandAnchor::TopRight,
            IslandAnchor::BottomLeft,
            IslandAnchor::BottomCenter,
            IslandAnchor::BottomRight,
        ] {
            assert_eq!(IslandAnchor::from_str(a.as_str()), Some(a));
        }
        assert_eq!(IslandAnchor::from_str("middle-top"), None);
        // serde 的 kebab-case 与 as_str 同源（前端拿到/写出的就是这套字符串）
        assert_eq!(
            serde_json::to_string(&IslandAnchor::BottomRight).unwrap(),
            "\"bottom-right\""
        );
        assert_eq!(
            serde_json::from_str::<IslandAnchor>("\"top-left\"").unwrap(),
            IslandAnchor::TopLeft
        );
    }

    /// 六档公式逐档钉住（工作区 1920×1040 落在 (0,20) 的「任务栏在顶」场景）：
    /// 顶档 y 恒等于工作区顶、**与 h 无关**；底档 y = 工作区底 − h、逐帧跟 h 走。
    #[test]
    fn test_anchor_origin_six_cells() {
        let (wx, wy, ww, wh) = (0.0, 20.0, 1920.0, 1040.0);
        let (w, h, m) = (208.0, 32.0, EDGE_MARGIN);
        let cases = [
            (IslandAnchor::TopLeft, 16.0, 20.0),
            (IslandAnchor::TopCenter, 856.0, 20.0),
            (IslandAnchor::TopRight, 1696.0, 20.0),
            (IslandAnchor::BottomLeft, 16.0, 1028.0),
            (IslandAnchor::BottomCenter, 856.0, 1028.0),
            (IslandAnchor::BottomRight, 1696.0, 1028.0),
        ];
        for (a, x, y) in cases {
            assert_eq!(anchor_origin(a, wx, wy, ww, wh, w, h, m), (x, y), "{a:?}");
        }
    }

    /// 「钉住一条边」的不变量：同一档下把舞台从胶囊换成展开卡，
    /// 顶档 y 不变 / 底档**底边**不变——底档若忘了跟 h 重算，展开会往下长出屏幕。
    #[test]
    fn test_anchor_origin_pins_edge_across_stage_sizes() {
        let (wx, wy, ww, wh) = (0.0, 0.0, 1920.0, 1080.0);
        let pill = (208.0, 32.0);
        let list = (420.0, 240.0);
        assert_eq!(
            anchor_origin(IslandAnchor::TopCenter, wx, wy, ww, wh, pill.0, pill.1, EDGE_MARGIN).1,
            anchor_origin(IslandAnchor::TopCenter, wx, wy, ww, wh, list.0, list.1, EDGE_MARGIN).1
        );
        let bottom_y = |s: (f64, f64)| {
            anchor_origin(IslandAnchor::BottomCenter, wx, wy, ww, wh, s.0, s.1, EDGE_MARGIN).1
                + s.1
        };
        assert_eq!(bottom_y(pill), bottom_y(list), "底边必须钉死");
        // 居中档横向也钉死（宽度变化只让岛向两侧对称长）
        let cx = |s: (f64, f64)| {
            anchor_origin(IslandAnchor::TopCenter, wx, wy, ww, wh, s.0, s.1, EDGE_MARGIN).0 + s.0 / 2.0
        };
        assert_eq!(cx(pill), cx(list));
        // 右档同理：右缘不动
        let rx = |s: (f64, f64)| {
            anchor_origin(IslandAnchor::TopRight, wx, wy, ww, wh, s.0, s.1, EDGE_MARGIN).0 + s.0
        };
        assert_eq!(rx(pill), rx(list));
    }

    /// 多屏：副屏工作区有原点偏移（`work_area.position` 不为 0），
    /// 公式必须把它加回来，否则岛会跳到主屏。
    #[test]
    fn test_anchor_origin_respects_work_area_origin() {
        let got = anchor_origin(IslandAnchor::TopLeft, 1920.0, 0.0, 1280.0, 1024.0, 208.0, 32.0, 16.0);
        assert_eq!(got, (1936.0, 0.0));
    }

    /// 动画路径（物理口径）与一次性定位路径（逻辑口径）**必须落在同一个矩形上**，
    /// 容差 1 物理px。两者一旦分家，动画落定后任何一次 `recenter()`（笔记变动 / 换主题
    /// 都会触发）都会让岛横向跳 1–2px —— 这正是历史上「偏右 26px」那类单位账的潜伏版。
    #[test]
    fn test_window_rect_phys_agrees_with_logical_path() {
        for scale in [1.0_f64, 1.25, 1.5] {
            let frame = AnchorFrame {
                wa_x: 0.0,
                wa_y: 0.0,
                wa_w: 1920.0 * scale,
                wa_h: 1040.0 * scale,
                scale,
                frame_w: 0,
                frame_h: 0,
            };
            for a in [
                IslandAnchor::TopLeft,
                IslandAnchor::TopCenter,
                IslandAnchor::TopRight,
                IslandAnchor::BottomLeft,
                IslandAnchor::BottomCenter,
                IslandAnchor::BottomRight,
            ] {
                for (w, h) in [(208.0, 32.0), (300.0, 40.0), (420.0, 240.0), (420.0, 280.0)] {
                    let (x, y, rw, rh) = frame.rect(a, w, h);
                    // 逻辑口径：anchor_origin 出逻辑 px，再按同一 scale 折物理
                    let (lx, ly) = anchor_origin(
                        a,
                        frame.wa_x / scale,
                        frame.wa_y / scale,
                        frame.wa_w / scale,
                        frame.wa_h / scale,
                        w,
                        h,
                        EDGE_MARGIN,
                    );
                    assert!(
                        (x as f64 - (lx * scale).round()).abs() <= 1.0,
                        "scale={scale} {a:?} ({w}×{h}) 横向两条路差了 {} px",
                        x as f64 - (lx * scale).round()
                    );
                    assert!(
                        (y as f64 - (ly * scale).round()).abs() <= 1.0,
                        "scale={scale} {a:?} ({w}×{h}) 纵向两条路差了 {} px",
                        y as f64 - (ly * scale).round()
                    );
                    assert_eq!(rw, (w * scale).round() as u32, "{a:?} 宽度必须是逻辑×scale");
                    assert_eq!(rh, (h * scale).round() as u32, "{a:?} 高度必须是逻辑×scale");
                }
            }
        }
    }

    /// 「钉住一条边」在**物理**口径下也必须精确成立：动画逐帧只有 (w,h) 在变，
    /// 被钉的那条边逐帧取整后必须**一个像素都不动**，否则岛在长大时边会呼吸。
    #[test]
    fn test_window_rect_phys_pins_edge_exactly() {
        let frame = AnchorFrame {
            wa_x: 0.0,
            wa_y: 0.0,
            wa_w: 2400.0,
            wa_h: 1300.0,
            scale: 1.25,
            frame_w: 0,
            frame_h: 0,
        };
        // 底档：底边 y+h 恒等于工作区底
        for h in [32.0, 40.0, 123.7, 240.0, 279.9] {
            let (_, y, _, rh) = frame.rect(IslandAnchor::BottomCenter, 420.0, h);
            assert_eq!(
                y + rh as i32,
                (frame.wa_y + frame.wa_h) as i32,
                "底边没钉死（h={h}）"
            );
        }
        // 顶档：顶边恒等于工作区顶，与 h 无关
        for h in [32.0, 240.0, 280.0] {
            let (_, y, _, _) = frame.rect(IslandAnchor::TopRight, 208.0, h);
            assert_eq!(y, frame.wa_y as i32, "顶边不该动（h={h}）");
        }
        // 右档：右缘 x+w 恒定（与 w 无关）；左档：左缘恒定
        let right_edge = |w: f64| {
            let (x, _, rw, _) = frame.rect(IslandAnchor::BottomRight, w, 32.0);
            x + rw as i32
        };
        assert_eq!(right_edge(208.0), right_edge(420.0));
        let left_edge = |w: f64| frame.rect(IslandAnchor::TopLeft, w, 32.0).0;
        assert_eq!(left_edge(208.0), left_edge(420.0));
        // 居中档：中心点随 w 变化最多漂 1px（取整），不许漂成一段位移
        let center = |w: f64| {
            let (x, _, rw, _) = frame.rect(IslandAnchor::TopCenter, w, 32.0);
            x + rw as i32 / 2
        };
        assert!((center(208.0) - center(420.0)).abs() <= 1, "居中档必须原地长");
    }

    /// 🔴 窗口矩形 = 客户区 + frame 差值。这条守卫的来源是实测：125% 下岛的客户区
    /// 是 260×40（= 208×32 逻辑），而 `GetWindowRect` 是 **260×47**。
    /// `SetWindowPos` 吃窗口矩形，Tauri 的 `set_size` 吃客户区 —— 逐帧下达若按客户区
    /// 数值直接调 `SetWindowPos`，每一帧都把卡片底部削掉 7px（动画全程 + 终态）。
    #[test]
    fn test_window_rect_phys_adds_frame_delta() {
        let mut frame = AnchorFrame {
            wa_x: 0.0,
            wa_y: 0.0,
            wa_w: 2560.0,
            wa_h: 1440.0,
            scale: 1.25,
            frame_w: 0,
            frame_h: 7,
        };
        let (_, _, w, h) = frame.rect(IslandAnchor::TopCenter, 208.0, 32.0);
        assert_eq!((w, h), (260_u32, 47_u32), "窗口矩形必须把 frame 差值补回去");
        // 底档：钉的是**窗口矩形**的底边（屏幕上唯一不动的那条边）
        let (_, y0, _, h0) = frame.rect(IslandAnchor::BottomCenter, 208.0, 32.0);
        let (_, y1, _, h1) = frame.rect(IslandAnchor::BottomCenter, 420.0, 240.0);
        assert_eq!(y0 + h0 as i32, y1 + h1 as i32, "底档窗口矩形底边必须钉死");
        // 有横向差值时居中仍按窗口矩形算（否则展开会整体左右偏 delta/2）
        frame.frame_w = 14;
        let (x0, _, w0, _) = frame.rect(IslandAnchor::TopCenter, 208.0, 32.0);
        let (x1, _, w1, _) = frame.rect(IslandAnchor::TopCenter, 420.0, 32.0);
        assert_eq!(x0 + w0 as i32 / 2, x1 + w1 as i32 / 2, "居中档中心点不许随宽度漂");
    }

}
