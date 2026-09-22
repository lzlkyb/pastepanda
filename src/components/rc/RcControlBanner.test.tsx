/**
 * RcControlBanner 三段式结构的守卫单测（2026-09-22，窄窗崩坏修复 · 方案 A）。
 *
 * 本批把横幅从「单行 flex 塞 8 个元素」改成「身份 / 动作 / 提示 / 能力说明」三段式。
 * 这里只钉 jsdom 能判定、且改动过程中**真的踩过**的三件事：
 *
 * ① 计时器必须在 live region **之外**——否则屏幕阅读器每秒播报一次时长（C5）。
 * ② who + pill 必须在**同一个** flex 项 `.whoLive` 里——窄窗下整个身份组内部折行，
 *    计时器不会被挤成单独一行（实测差 15px，见 design/ 稿 §8）。这条只有渲染断言挡得住：
 *    把计时器写成 `.ctrlWho` 的兄弟节点时，tsc 与视觉稿都发现不了。
 * ③ 提示段无内容时整段**不渲染**——空 div 会白吃一条 `.ctrlStack` 的 row-gap。
 *
 * 布局类结论（550px→135px、320px→213px、竖排 none）不在 jsdom 能力范围内，
 * 由设计稿的 CDP 实测负责，不在这里假断言。
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { RcControlBanner } from "./RcControlBanner";
import styles from "./RemoteComputer.module.css";
import type { RcSession } from "@/lib/api/rc";

vi.mock("@/hooks/useRcFile", () => ({
  useRcFile: () => ({ asks: [], respond: vi.fn() }),
}));
vi.mock("@/lib/confirm", () => ({ confirmDialog: vi.fn().mockResolvedValue(false) }));

const session: RcSession = {
  id: "s1",
  peer: "node-abcd",
  peer_name: "工作电脑",
  capability: "control",
  phase: "inbound_active",
  started_ms: Date.now() - 13_000,
} as RcSession;

function renderBanner(extra: Partial<Parameters<typeof RcControlBanner>[0]> = {}) {
  return render(
    <RcControlBanner session={session} busy={false} onEnd={() => {}} {...extra} />,
  );
}

describe("RcControlBanner 三段式结构（2026-09-22 窄窗崩坏修复）", () => {
  it("① 计时器不在 live region 内；who + pill 在同一个 .whoLive 里", () => {
    const { container } = renderBanner();
    const live = container.querySelector(`.${styles.whoLive}`);
    expect(live).not.toBeNull();
    expect(live!.getAttribute("role")).toBe("status");
    // who 与 pill 同属这一个 live 项
    expect(live!.querySelector(`.${styles.who}`)).not.toBeNull();
    expect(live!.querySelector(`.${styles.pillDanger}`)).not.toBeNull();
    // ② 计时器是 .ctrlWho 的兄弟，不在 live 项里
    const timer = container.querySelector(`.${styles.timer}`);
    expect(timer).not.toBeNull();
    expect(live!.contains(timer!)).toBe(false);
    expect(timer!.parentElement!.classList.contains(styles.ctrlWho)).toBe(true);
  });

  it("③ 没有提示时不渲染 .ctrlNotes（空段会白吃一条 row-gap）", () => {
    const { container } = renderBanner();
    expect(container.querySelector(`.${styles.ctrlNotes}`)).toBeNull();
    // 能力说明必须常驻（规则 15：触发可见，结果也要可见）
    expect(container.querySelector(`.${styles.ctrlFoot}`)!.textContent).toContain(
      "对方可操作键鼠与剪贴板",
    );
  });

  it("③ 有提示时提示条落在 .ctrlNotes 里", () => {
    const { container, getByText } = renderBanner({ scopeNotice: "full" });
    const notes = container.querySelector(`.${styles.ctrlNotes}`);
    expect(notes).not.toBeNull();
    expect(notes!.querySelector(`.${styles.scopeNotice}`)).not.toBeNull();
    expect(getByText(/对方把画面范围改成了/)).toBeDefined();
  });

  it("只看模式的能力说明与胶囊文案跟着 capability 走", () => {
    const { container, getByText } = renderBanner({
      session: { ...session, capability: "view" } as RcSession,
    });
    expect(container.querySelector(`.${styles.pillDanger}`)!.textContent).toBe("只看");
    expect(container.querySelector(`.${styles.ctrlFoot}`)!.textContent).toContain(
      "对方仅可观看画面",
    );
    expect(getByText("立即结束")).toBeDefined();
  });
});
