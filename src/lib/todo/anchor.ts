/**
 * 岛停靠锚点（方案 C1，设计稿 `design/待办灵动岛-停靠位置-设计稿.html`）。
 *
 * 六个锚点 = 2 条边 × 3 个横向位置。存在的理由：岛原本只有「顶 · 中」一个落位，
 * 那块常驻胶囊正压在浏览器标签栏 / 应用标题栏上，用户要点附近的关闭按钮就点不到。
 *
 * 口径收口在这里（规则 11.1）：字符串集合、缺省档、边 → 朝向的映射，
 * 三个消费方共用——设置页六宫格、岛前端写 `html[data-island-dock]`、appStore 的脏值夹取。
 * Rust 侧同一套字符串在 `src-tauri/src/todo_island_anchor.rs::IslandAnchor::as_str`，
 * 改一边必须改另一边（守卫单测钉住不了跨语言，靠 `anchorDock` 的键集合测试兜一半）。
 */

export type AnchorKey =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

/** 缺省档 = 锚点功能之前的唯一落位，老用户升级后岛的位置不变 */
export const ANCHOR_DEFAULT: AnchorKey = "top-center";

/** 六宫格的阅读顺序：上排顶三档、下排底三档（设置页按每行 3 个排版） */
export const ANCHOR_LABELS: Record<AnchorKey, string> = {
  "top-left": "顶 · 左",
  "top-center": "顶 · 中",
  "top-right": "顶 · 右",
  "bottom-left": "底 · 左",
  "bottom-center": "底 · 中",
  "bottom-right": "底 · 右",
};

export const ANCHOR_ORDER: AnchorKey[] = [
  "top-left",
  "top-center",
  "top-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

/** 任意来源 → 合法锚点；认不出来落缺省档。 */
export function normalizeAnchor(raw: unknown): AnchorKey {
  return typeof raw === "string" && (ANCHOR_ORDER as string[]).includes(raw)
    ? (raw as AnchorKey)
    : ANCHOR_DEFAULT;
}

/** 贴哪条边 → CSS 停靠朝向（半胶囊压平上缘还是下缘）。 */
export function anchorDock(anchor: AnchorKey): "top" | "bottom" {
  return anchor.startsWith("bottom-") ? "bottom" : "top";
}

/** 横向档位 → 预览条里胶囊贴哪一侧（设置页预览用，与 `anchorDock` 合成两轴定位）。 */
export function anchorSide(anchor: AnchorKey): "left" | "center" | "right" {
  const side = anchor.split("-")[1];
  return side === "right" || side === "center" ? side : "left";
}
