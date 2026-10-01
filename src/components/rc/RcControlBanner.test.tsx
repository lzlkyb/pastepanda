/**
 * RcControlBanner 胶囊 + 抽屉结构的守卫单测（2026-09-24，方案 B 重构）。
 *
 * 前身是三段式横幅的守卫（09-22 方案 A）——窄窗压缩模型没变（压缩量只由
 * .who 承担、计时器在 live region 外），这两条守卫跟着迁到胶囊上。新增钉：
 *
 * ① 抽屉默认收起——被控提示常驻但极轻（胶囊 ~34px），事实表不该常占 DOM。
 * ② 展开抽屉必须经胶囊点击，且 aria-expanded 跟着走（屏幕阅读器的展开状态）。
 * ③ 文件请求到达自动展开抽屉一次（规则 15：触发可见）；而知会型通知反过来——
 *   编码/画质/范围/扬声器到达只挂橙点徽标、不弹抽屉（2026-10-01 用户拍板，见 ④b）。
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
    const { container } = renderBanner();
    // 未点击任何东西，抽屉已展开
    expect(container.querySelector(`.${styles.ctrlDrawer}`)).not.toBeNull();
    expect(container.querySelector(`.${styles.ctrlBadge}`)).not.toBeNull();
  });

  it("④b 知会型通知（编码/画质/范围/扬声器）默认不弹抽屉；只挂橙点徽标", () => {
    // 2026-10-01 拍板：提示类通知没有要按的键，不许把人从远程操作里拽开。
    const stream = renderBanner({
      streamNotice: { kind: "codec", name: "jpeg" },
      scopeNotice: "full",
      spkMutedByPeer: true,
    });
    expect(stream.container.querySelector(`.${styles.ctrlDrawer}`)).toBeNull();
    // 徽标照亮：不弹 ≠ 看不见（规则 15 的另一半——点开胶囊仍能看到提示条）
    expect(stream.container.querySelector(`.${styles.ctrlBadge}`)).not.toBeNull();
    // aria-expanded 保持 false：屏幕阅读器不会误报「已展开」
    expect(
      stream.container.querySelector(`.${styles.ctrlPillMain}`)!.getAttribute("aria-expanded"),
    ).toBe("false");
    stream.unmount();

    // 新通知到达也不弹（对端连续改档位时每来一条都不弹）
    const { container, rerender } = renderBanner({
      streamNotice: { kind: "codec", name: "jpeg" },
    });
    rerender(
      <RcControlBanner
        session={session}
        busy={false}
        onEnd={() => {}}
        streamNotice={{ kind: "codec", name: "h264" }}
      />,
    );
    expect(container.querySelector(`.${styles.ctrlDrawer}`)).toBeNull();
  });

  it("④c 通知没被看到时，点开胶囊仍能看到提示条（不弹但可查）", () => {
    const { container, getByText } = renderBanner({
      streamNotice: { kind: "codec", name: "jpeg" },
    });
    fireEvent.click(container.querySelector(`.${styles.ctrlPillMain}`)!);
    expect(getByText(/对方把编码切成了「JPEG」/)).toBeDefined();
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

  /**
   * 🔴 乙-③（2026-09-30）：被控侧的输入权交接。
   *
   * 这里最容易被写错的不是逻辑而是**措辞**：「收回」挡的是对方发来的键鼠，
   * 「锁定」吞的是我自己的物理键鼠——两句话被互换，被控者就会以为自己已经把
   * 对方赶出去了，而实际上什么都没发生。断言按这条口径写。
   */
  describe("乙-③ 输入权交接（收回 / 允许锁定 / 谁在动）", () => {
    const open = (container: HTMLElement) =>
      fireEvent.click(container.querySelector(`.${styles.ctrlPillMain}`)!);

    it("⑦ 收回键鼠：胶囊上挂常驻徽标（抽屉一收就看不见的状态不算告知）", () => {
      const onToggleInputHold = vi.fn();
      const { container } = renderBanner({
        inputHold: true,
        onToggleInputHold,
      });
      const badge = container.querySelector(`.${styles.pillHold}`);
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toContain("键鼠已收回");
      // 🔴 必须是胶囊主键的**同级**：button 套 button 在 HTML 里非法，且点徽标会
      // 顺带把抽屉展开（jsdom 不拦这种结构，只有这条断言拦得住）。
      expect(badge!.parentElement!.classList.contains(styles.ctrlPill)).toBe(true);
      expect(badge!.closest(`.${styles.ctrlPillMain}`)).toBeNull();
      // 橙点徽标同时亮起（有需要处理的状态，与文件请求同一判据）
      expect(container.querySelector(`.${styles.ctrlBadge}`)).not.toBeNull();
      fireEvent.click(badge!);
      expect(onToggleInputHold).toHaveBeenCalledTimes(1);
    });

    it("⑧ 未收回时不摆徽标（常驻 UI 只在状态成立时出现）", () => {
      const { container } = renderBanner({ onToggleInputHold: vi.fn() });
      expect(container.querySelector(`.${styles.pillHold}`)).toBeNull();
    });

    it("⑨ 抽屉两把闸的措辞不得互换：收回说「对方发来的」，授权说「我的输入」", () => {
      const { container } = renderBanner({
        onToggleInputHold: vi.fn(),
        onToggleLockGrant: vi.fn(),
      });
      open(container);
      const hold = screen.getByText("暂时收回我的键鼠");
      const grant = screen.getByText(/允许对方锁定我的输入/);
      expect(hold.classList.contains(styles.inputActBtn)).toBe(true);
      expect(grant.classList.contains(styles.inputActBtn)).toBe(true);
      expect(hold.getAttribute("title")).toContain("对方发来的键鼠会被拦下");
      expect(grant.getAttribute("title")).toContain("锁住你的键盘鼠标");
      // 授权默认关（aria-pressed=false）——默认开 = 任何人连进来就能锁住这台机器
      expect(grant.getAttribute("aria-pressed")).toBe("false");
    });

    it("⑩ 收回态：按钮翻成「归还」并带选中态；锁定生效时给常驻说明行", () => {
      const { container } = renderBanner({
        inputHold: true,
        lockGranted: true,
        lockActive: true,
        onToggleInputHold: vi.fn(),
        onToggleLockGrant: vi.fn(),
      });
      open(container);
      const back = screen.getByText("归还键鼠给对方");
      expect(back.classList.contains(styles.inputActBtnOn)).toBe(true);
      expect(container.textContent).toContain("对方现在锁着你的键盘鼠标");
      expect(screen.getByText(/允许对方锁定我的输入：开/).getAttribute("aria-pressed")).toBe("true");
    });

    it("⑪ 谁在动：只有窗口内点亮的那枚才摆，idle 不凭空挂灰点", () => {
      const first = renderBanner({
        onToggleInputHold: vi.fn(),
        inputPills: { keyboard: "idle", mouse: "blocked" },
      });
      open(first.container);
      const pills = first.container.querySelector(`.${styles.inputPills}`);
      expect(pills).not.toBeNull();
      expect(pills!.textContent).toContain("鼠标·对方无权却被按下");
      expect(pills!.textContent).not.toContain("键盘");
      first.unmount();

      // 两枚都 idle ⇒ 整行不渲染（抽屉不凭空挂两枚读不懂的灰点）
      const second = renderBanner({
        onToggleInputHold: vi.fn(),
        inputPills: { keyboard: "idle", mouse: "idle" },
      });
      open(second.container);
      expect(second.container.querySelector(`.${styles.inputPills}`)).toBeNull();
    });
  });

  /**
   * 🔴 丙-③（2026-09-30）：暂停对方观看。
   *
   * 与乙-③ 是两条正交的路——这条挡对方的**眼睛**（画面停帧），那条挡对方的**手**
   * （注入被拦）。所以断言重点是：两枚徽标各自独立出现、措辞不许互相借词，
   * 以及「抽屉一收起状态就看不见」这条老坑不许复发（规则 15.1）。
   */
  describe("丙-③ 暂停对方观看（画面停帧，会话不断）", () => {
    const open = (container: HTMLElement) =>
      fireEvent.click(container.querySelector(`.${styles.ctrlPillMain}`)!);

    it("⑫ 暂停中：胶囊行挂常驻徽标，点它直接恢复（不必再开抽屉）", () => {
      const onToggleVideoPause = vi.fn();
      const { container } = renderBanner({
        videoPaused: true,
        onToggleInputHold: vi.fn(),
        onToggleVideoPause,
      });
      const badge = container.querySelector(`.${styles.pillPause}`);
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toContain("画面已暂停");
      // 同 ⑦ 的结构红线：button 不能套 button，徽标必须是胶囊主键的同级
      expect(badge!.parentElement!.classList.contains(styles.ctrlPill)).toBe(true);
      expect(badge!.closest(`.${styles.ctrlPillMain}`)).toBeNull();
      fireEvent.click(badge!);
      expect(onToggleVideoPause).toHaveBeenCalledTimes(1);
    });

    it("⑬ 收回键鼠与暂停画面各挂各的徽标：一条成立不影响另一条（正交的两把闸）", () => {
      const { container } = renderBanner({
        inputHold: true,
        onToggleInputHold: vi.fn(),
        videoPaused: false,
        onToggleVideoPause: vi.fn(),
      });
      expect(container.querySelector(`.${styles.pillHold}`)).not.toBeNull();
      // 只按了收回 ⇒ 画面照常在推，不许凭空挂一枚「画面已暂停」
      expect(container.querySelector(`.${styles.pillPause}`)).toBeNull();
    });

    it("⑭ 抽屉里那颗键：默认「暂停对方观看」，点它调一次动作", () => {
      const onToggleVideoPause = vi.fn();
      const first = renderBanner({ onToggleInputHold: vi.fn(), onToggleVideoPause });
      open(first.container);
      const btn = screen.getByText("暂停对方观看");
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(btn);
      expect(onToggleVideoPause).toHaveBeenCalledTimes(1);
      first.unmount();
    });

    it("⑭b 不传 handler ⇒ 整颗键不摆（与「不发送声音」同款纪律：不给半条路）", () => {
      const { container } = renderBanner({ onToggleInputHold: vi.fn() });
      open(container);
      expect(screen.queryByText("暂停对方观看")).toBeNull();
      expect(container.querySelector(`.${styles.inputPanelActs}`)).not.toBeNull();
    });

    it("⑮ 暂停态：按钮文案翻面 + 常驻徽标同时在位（触发与反馈同一可见性域）", () => {
      const { container } = renderBanner({
        onToggleInputHold: vi.fn(),
        videoPaused: true,
        onToggleVideoPause: vi.fn(),
      });
      open(container);
      const back = screen.getByText("恢复对方观看");
      expect(back.classList.contains(styles.inputActBtnOn)).toBe(true);
      expect(container.querySelector(`.${styles.pillPause}`)).not.toBeNull();
      // 措辞守住边界：暂停不是断连，也不许写成黑屏（机制已在拍板时否掉）
      expect(container.textContent).not.toMatch(/已断开|黑屏/);
    });
  });
});
