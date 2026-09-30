/**
 * RcLinkMask 守卫单测（甲-③，2026-09-29）。
 *
 * 两条重心：
 * 1. 组件本身：两态各说哪一句、按钮改不改口、没判据时整层不出现。
 * 2. 🔴 **挂载位置**（=C2/C3 的真正病灶）：遮罩与错误面板都必须在全屏元素
 *    `.sessionWrap` 的子树里。浏览器只渲染全屏元素的子树，挂在 `<main>` / 树根的
 *    东西在全屏态等于不存在——这条只能靠读源码钉，jsdom 里没有真全屏。
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RcLinkMask } from "./RcLinkMask";

const props = (over: Record<string, unknown> = {}) => ({
  hasFrame: true,
  state: "failed" as const,
  busy: false,
  peerName: "客厅的电脑",
  onReconnect: vi.fn(),
  onRequestEnd: vi.fn(),
  ...over,
});

describe("RcLinkMask", () => {
  it("判据不成立 ⇒ 整层不出现（connected / 没画面时不许盖黑）", () => {
    const { container: a } = render(<RcLinkMask {...props({ state: "connected" })} />);
    expect(a.firstChild).toBeNull();
    const { container: b } = render(<RcLinkMask {...props({ hasFrame: false })} />);
    expect(b.firstChild).toBeNull();
  });

  it("判死且无在途 → 「需要对方重新同意」+ 按钮改口「重新发起」", () => {
    render(<RcLinkMask {...props()} />);
    expect(screen.getByRole("alert").textContent).toContain("需要对方重新同意");
    expect(screen.getByRole("button", { name: /重新发起/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /立即重连/ })).toBeNull();
  });

  it("在途重连 → 「正在尝试恢复」，并明说用户不需要做任何事", () => {
    render(<RcLinkMask {...props({ state: "reconnecting" })} />);
    const mask = screen.getByRole("alert");
    expect(mask.textContent).toContain("正在尝试恢复");
    expect(mask.textContent).toContain("你不需要做任何事");
    expect(screen.getByRole("button", { name: /立即重连/ })).toBeTruthy();
  });

  it("文案只讲结果：不许出现「第 N/M 次」这类把自动重连变成用户决策点的字", () => {
    render(<RcLinkMask {...props({ state: "reconnecting", busy: true })} />);
    expect(screen.getByRole("alert").textContent).not.toMatch(/第\s*\d+\s*\/\s*\d+\s*次/);
  });

  it("结束会话永远在（遮罩吃掉了画面点击，就必须自带出口）", () => {
    render(<RcLinkMask {...props()} />);
    expect(screen.getByRole("button", { name: /结束会话/ })).toBeTruthy();
  });
});

describe("RcLinkMask / RcErrorPanel 挂载位置（=C2、C3）", () => {
  const src = (f: string) =>
    readFileSync(join(process.cwd(), "src", "components", "rc", f), "utf8");

  it("遮罩挂在 RcSessionStage 的 fakeScreen 内（= .sessionWrap 子树）", () => {
    const stage = src("RcSessionStage.tsx");
    const at = stage.indexOf("<RcLinkMask");
    expect(at, "RcSessionStage 没挂遮罩 = C3 复发").toBeGreaterThan(-1);
    // 落在 fakeScreen 之后、`</div>` 收尾之前才算在全屏元素子树里
    expect(at).toBeGreaterThan(stage.indexOf("styles.fakeScreen"));
  });

  it("🔴 会话态的错误面板不再挂 <main>，而是下传进 .sessionWrap", () => {
    const stage = src("RcStage.tsx");
    const view = src("RcSessionView.tsx");
    expect(stage).toMatch(/!inSession\s*&&\s*errorPanel/);
    expect(stage).toMatch(/errorSlot=\{errorPanel\}/);
    expect(view.indexOf("{errorSlot}")).toBeLessThan(view.indexOf("<RcSessionStage"));
  });
});
