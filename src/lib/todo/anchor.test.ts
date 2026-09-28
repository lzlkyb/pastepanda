/**
 * 守卫测试（规则 11.1）：`anchor.ts` 是停靠锚点的唯一口径收口——
 * 设置页六宫格、岛前端写 `html[data-island-dock]`、appStore 脏值夹取三处都过它，
 * 而 Rust 侧 `IslandAnchor::as_str` 吃的是**同一批字符串**（跨语言，见下面的钉值用例）。
 */
import { describe, expect, it } from "vitest";
import {
  ANCHOR_DEFAULT,
  ANCHOR_LABELS,
  ANCHOR_ORDER,
  anchorDock,
  anchorSide,
  normalizeAnchor,
  type AnchorKey,
} from "./anchor";

/** Rust `todo_island_anchor.rs::IslandAnchor::as_str` 的字面量抄本。
 *  两边任何一侧改名/删档，这条用例就会红——跨语言对不齐时岛会静默回落缺省档，
 *  比编译错误难查得多，所以把它钉在测试里。 */
const RUST_SIDE_KEYS = [
  "top-left",
  "top-center",
  "top-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

describe("anchor 键集合", () => {
  it("六档齐全且与 Rust 侧字符串一一对应", () => {
    expect([...ANCHOR_ORDER].sort()).toEqual([...RUST_SIDE_KEYS].sort());
    expect(new Set(ANCHOR_ORDER).size).toBe(6);
    for (const key of ANCHOR_ORDER) expect(ANCHOR_LABELS[key]).toBeTruthy();
  });

  it("缺省档必须是六档之一（否则 normalizeAnchor 的回落值自己就非法）", () => {
    expect(ANCHOR_ORDER).toContain(ANCHOR_DEFAULT);
    expect(normalizeAnchor(undefined)).toBe(ANCHOR_DEFAULT);
  });

  it("六宫格阅读顺序 = 上排顶三档、下排底三档（设置页按每行 3 个排版）", () => {
    expect(ANCHOR_ORDER.slice(0, 3).every((k) => anchorDock(k) === "top")).toBe(true);
    expect(ANCHOR_ORDER.slice(3).every((k) => anchorDock(k) === "bottom")).toBe(true);
  });
});

describe("normalizeAnchor", () => {
  it("合法值原样通过", () => {
    for (const key of ANCHOR_ORDER) expect(normalizeAnchor(key)).toBe(key);
  });

  it("脏值（手改 config / 已删的旧档名 / 非字符串）一律回落缺省档", () => {
    for (const bad of ["middle", "left-top", "", "TOP-LEFT", null, undefined, 42, {}, []]) {
      expect(normalizeAnchor(bad)).toBe(ANCHOR_DEFAULT);
    }
  });
});

describe("anchorDock / anchorSide", () => {
  it("两轴合起来必须唯一确定一档（预览条靠这两个属性定位，撞车就分不清两档）", () => {
    const pairs = ANCHOR_ORDER.map((k) => `${anchorDock(k)}/${anchorSide(k)}`);
    expect(new Set(pairs).size).toBe(6);
  });

  it("取值域收在联合类型里（CSS 选择器只写了这三档，越界会定位不到）", () => {
    for (const k of ANCHOR_ORDER) {
      expect(["top", "bottom"]).toContain(anchorDock(k));
      expect(["left", "center", "right"]).toContain(anchorSide(k));
    }
    // 兜底：normalizeAnchor 保证进来的永远是上面六档之一
    expect(anchorDock(normalizeAnchor("nonsense"))).toBe("top");
    expect(anchorSide(normalizeAnchor("nonsense"))).toBe("center");
  });
});

// 类型层面的护栏：ANCHOR_ORDER 的元素必须是 AnchorKey（改成 string[] 就编不过）。
const _typeCheck: AnchorKey[] = [...ANCHOR_ORDER];
void _typeCheck;
