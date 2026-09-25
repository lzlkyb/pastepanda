/**
 * RcControlBanner 胶囊 + 抽屉结构的守卫单测（2026-09-24，方案 B 重构）。
 *
 * 前身是三段式横幅的守卫（09-22 方案 A）——窄窗压缩模型没变（压缩量只由
 * .who 承担、计时器在 live region 外），这两条守卫跟着迁到胶囊上。新增钉：
 *
 * ① 抽屉默认收起——被控提示常驻但极轻（胶囊 ~34px），事实表不该常占 DOM。
 * ② 展开抽屉必须经胶囊点击，且 aria-expanded 跟着走（屏幕阅读器的展开状态）。
 * ③ 文件请求到达自动展开抽屉一次（规则 15：触发可见）。
 * ④ 结束入口（图标 + 抽屉按钮）都必须走 confirmDialog——红线：误触代价不对称，
 *    mock 返回 false 时 onEnd 绝不能被调。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RcControlBanner } from "./RcControlBanner";
import styles from "./RemoteComputer.module.css";
import type { RcSession } from "@/lib/api/rc";
import type { RcFileAsk } from "@/lib/api/rcFile";

const h = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  asks: [] as RcFileAsk[],
}));

vi.mock("@/hooks/useRcFile", () => ({
  useRcFile: () => ({ asks: h.asks, respond: vi.fn() }),
}));
vi.mock("@/lib/confirm", () => ({ confirmDialog: h.confirmDialog }));

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

beforeEach(() => {
  h.asks = [];
  h.confirmDialog.mockReset().mockResolvedValue(false);
});

describe("RcControlBanner 胶囊 + 抽屉（2026-09-24 方案 B）", () => {
  it("① 胶囊：计时器在 live region 外；who + pill 在同一个 .whoLive 里", () => {
    const { container } = renderBanner();
    const live = container.querySelector(`.${styles.whoLive}`);
    expect(live).not.toBeNull();
    expect(live!.getAttribute("role")).toBe("status");
    expect(live!.querySelector(`.${styles.who}`)).not.toBeNull();
    expect(live!.querySelector(`.${styles.pillDanger}`)).not.toBeNull();
    const timer = container.querySelector(`.${styles.timer}`);
    expect(timer).not.toBeNull();
    expect(live!.contains(timer!)).toBe(false);
    expect(timer!.parentElement!.classList.contains(styles.ctrlPillMain)).toBe(true);
  });

  it("② 抽屉默认收起：事实表不在 DOM；胶囊挂 aria-expanded=false", () => {
    const { container } = renderBanner();
    expect(container.querySelector(`.${styles.ctrlDrawer}`)).toBeNull();
    const pill = container.querySelector(`.${styles.ctrlPillMain}`);
    expect(pill!.getAttribute("aria-expanded")).toBe("false");
    // 无提示时无橙点徽标
    expect(container.querySelector(`.${styles.ctrlBadge}`)).toBeNull();
    // 结束图标必须常驻胶囊（规则 15：随时可停的入口不折叠）
    expect(container.querySelector(`.${styles.ctrlPillEnd}`)).not.toBeNull();
  });

  it("③ 点击胶囊展开抽屉：事实表 + 免确认 + 立即结束出现，aria-expanded 翻转", () => {
    const { container, getByText } = renderBanner({
      quality: "auto",
      activeQuality: "uhd",
      captureScope: "virtual",
      trusted: true,
    });
    fireEvent.click(container.querySelector(`.${styles.ctrlPillMain}`)!);
    const drawer = container.querySelector(`.${styles.ctrlDrawer}`);
    expect(drawer).not.toBeNull();
    expect(container.querySelector(`.${styles.ctrlPillMain}`)!.getAttribute("aria-expanded")).toBe(
      "true",
    );
    // 事实表四项
    expect(getByText("对方指纹")).toBeDefined();
    expect(getByText("画面范围")).toBeDefined();
    expect(getByText("本机画质")).toBeDefined();
    expect(getByText(/已开启/)).toBeDefined();
    // 能力说明（规则 15 语义保留在抽屉里）
    expect(drawer!.textContent).toContain("对方可操作键鼠与剪贴板");
    // 抽屉里的完整结束按钮
    expect(getByText("立即结束")).toBeDefined();
  });

  it("④ 文件请求到达自动展开抽屉；有提示时橙点徽标出现", () => {
    h.asks = [
      {
        id: "a1",
        peer: "node-abcd",
        peer_name: "工作电脑",
        kind: "push",
        name: "report.zip",
        size: 1024,
        first_seen_ms: Date.now(),
      },
    ];
    const { container } = renderBanner({ scopeNotice: "full" });
    // 未点击任何东西，抽屉已展开
    expect(container.querySelector(`.${styles.ctrlDrawer}`)).not.toBeNull();
    expect(container.querySelector(`.${styles.ctrlBadge}`)).not.toBeNull();
  });

  it("⑤ 结束入口两处都走 confirmDialog；拒绝时 onEnd 不被调（红线）", async () => {
    const onEnd = vi.fn();
    const { container } = renderBanner({ onEnd });
    // 胶囊图标
    fireEvent.click(container.querySelector(`.${styles.ctrlPillEnd}`)!);
    expect(h.confirmDialog).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.confirmDialog).toHaveBeenCalled());
    expect(onEnd).not.toHaveBeenCalled(); // mock 返回 false

    // 抽屉按钮
    fireEvent.click(container.querySelector(`.${styles.ctrlPillMain}`)!);
    fireEvent.click(screen.getByText("立即结束"));
    expect(h.confirmDialog).toHaveBeenCalledTimes(2);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("⑥ 只看模式：pill 与能力说明跟着 capability 走", () => {
    const { container, getByText } = renderBanner({
      session: { ...session, capability: "view" } as RcSession,
    });
    expect(container.querySelector(`.${styles.pillDanger}`)!.textContent).toBe("只看");
    fireEvent.click(container.querySelector(`.${styles.ctrlPillMain}`)!);
    expect(container.querySelector(`.${styles.ctrlDrawer}`)!.textContent).toContain(
      "对方仅可观看画面",
    );
    expect(getByText("立即结束")).toBeDefined();
  });
});
