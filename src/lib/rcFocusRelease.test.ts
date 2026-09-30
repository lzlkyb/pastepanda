/**
 * 乙档-②（2026-09-30）守卫：焦点离开画面时「松不松按住键」的判据（规则 11.1）。
 *
 * 缺陷本体（审计 C4）是**一条无条件释放**：按住 Ctrl 去点胶囊上的「画质」下拉，
 * 画面 `onBlur` 就把按住态全清了，回到画面还得再点一次才重新捕获键盘。
 * 修法是把两类失焦分开——同窗内切焦点＝只暂停；跨应用失焦＝释放。
 *
 * 这条判据一旦写反，两个方向的失败都很难看见：
 * - 全判成「释放」→ 回到 C4 缺陷（用户以为是自己松了手）；
 * - 全判成「不释放」→ 画面被最小化时对端真的留着 Ctrl，毁掉他接下来的每次操作。
 * 所以四种入参都要钉住，包括 `relatedTarget === null`（Chromium 的「窗口整体失焦」）
 * 与 `wrap` 还没挂上（ref 为空）这两条兜底路径。
 */
import { describe, expect, it } from "vitest";
import { rcBlurReleasesHeld, rcBlurTarget } from "./rcFocusRelease";

/** 造一棵「会话壳 > 浮条 > 下拉项」的小树，够判 contains 了。 */
function tree() {
  const wrap = document.createElement("div");
  const zone = document.createElement("div");
  const item = document.createElement("button");
  const outside = document.createElement("div");
  zone.append(item);
  wrap.append(zone);
  document.body.append(wrap, outside);
  return { wrap, zone, item, outside };
}

describe("rcBlurTarget", () => {
  it("焦点进了同窗内的浮条 → inside_session（只暂停注入）", () => {
    const { wrap, item } = tree();
    expect(rcBlurTarget(item, wrap)).toBe("inside_session");
    // 壳自己也算在内：`contains` 含自身
    expect(rcBlurTarget(wrap, wrap)).toBe("inside_session");
  });

  it("焦点去了会话壳外的本机 UI → outside", () => {
    const { wrap, outside } = tree();
    expect(rcBlurTarget(outside, wrap)).toBe("outside");
  });

  it("relatedTarget 为 null（Alt-Tab / 最小化，窗口整体失焦）→ outside", () => {
    const { wrap } = tree();
    expect(rcBlurTarget(null, wrap)).toBe("outside");
  });

  it("会话壳还没挂上（ref 为空）→ outside：宁可释放，不许留卡键", () => {
    const { item } = tree();
    expect(rcBlurTarget(item, null)).toBe("outside");
  });

  it("非 Node 的怪值（window 本身）→ outside，不当成「还在壳里」", () => {
    const { wrap } = tree();
    expect(rcBlurTarget(window, wrap)).toBe("outside");
  });
});

describe("rcBlurReleasesHeld", () => {
  it("只有跨应用失焦才释放按住键", () => {
    expect(rcBlurReleasesHeld("outside")).toBe(true);
    expect(rcBlurReleasesHeld("inside_session")).toBe(false);
  });
});
