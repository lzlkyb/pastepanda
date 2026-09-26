/**
 * RcWorkbench 骨架的守卫单测（2026-09-21，A 方案稿批次 2 + 批5）。
 *
 * 钉住两件事：
 * ① 会话态**不渲染**工作台标题栏（画面铺满整个工作台，不再白留一条 48px）；
 * ② 非会话态照旧渲染。批7 起它是**自绘标题栏**——品牌 + 通道状态位 + 窗口按钮，
 *    兼作窗口拖拽区（窗口已 `decorations(false)`），所以这里同时钉住那三个按钮在。
 *
 * 判据本身收口在 `hidesWorkbenchTitleBar`（lib/rcWorkbenchA2，另有一组纯函数用例），
 * 这里补的是**消费侧**——`{!chromeHidden && <RcA2TitleBar/>}` 若写成 `chromeHidden &&`，
 * 纯函数用例查不出来，只有渲染断言挡得住（同类「写完了但没接上」的缺口，
 * 见 2026-09-21 的 RcEmptyGuide selfEnabled 漏传）。
 *
 * 批5 补的是第三件：会话历史从这一个 hook 出去要**同时**到侧栏筛选与内容区列表，
 * 只接一半（侧栏有了筛选、列表还自己拉一份）在界面上看不出来，只有断言「两处的
 * 数字来自同一份快照」能挡住。
 *
 * 会话视图 / 配对层 / 四个 hook 全 mock：本用例只关心骨架接线。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RcSession, RcStatus, RcTargetDevice } from "@/lib/api/rc";

const h = vi.hoisted(() => ({
  status: null as RcStatus | null,
  targets: [] as RcTargetDevice[],
  probeTargets: vi.fn().mockResolvedValue(undefined),
  refreshTargets: vi.fn(),
  visible: true,
}));
/** 批7 审查补：toast 要能被断言——「通道未启动时点检测」的修复靠的就是它。 */
const toastSpy = vi.hoisted(() => vi.fn());

vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: toastSpy }) }));
vi.mock("@/components/settings/RcPairLayer", () => ({ RcPairLayer: () => null }));
vi.mock("./RcStage", () => ({ RcStage: () => <div>会话画面（已 mock）</div> }));
vi.mock("@/hooks/useRc", () => ({
  useRc: () => ({
    status: h.status,
    error: null,
    busy: false,
    isOpError: false,
    targets: h.targets,
    reachability: {},
    targetsLoaded: true,
    targetsError: null,
    refresh: vi.fn(),
    refreshIdentity: vi.fn(),
    refreshTargets: h.refreshTargets,
    probeTargets: h.probeTargets,
    startChannel: vi.fn().mockResolvedValue(true),
    end: vi.fn().mockResolvedValue(true),
    setEnabled: vi.fn(),
    setDeviceAllowed: vi.fn(),
    setDeviceTrust: vi.fn(),
    setDeviceAutoAccept: vi.fn(),
    clearError: vi.fn(),
  }),
}));
vi.mock("@/hooks/useWindowVisible", () => ({ useWindowVisible: () => h.visible }));
vi.mock("@/hooks/useRcLaunch", () => ({
  useRcLaunch: () => ({
    cap: "control",
    setDefaultCap: vi.fn(),
    lastPeer: null,
    lastAttempt: null,
    doRequest: vi.fn().mockResolvedValue(true),
    forgetDevice: vi.fn(),
  }),
}));
vi.mock("@/hooks/useRcWorkbenchClose", () => ({ useRcWorkbenchClose: () => {} }));

/** 会话历史 mock：两条都属同一台设备，用来验证侧栏计数与列表出自同一份数据。 */
const hist = vi.hoisted(() => ({
  list: [
    {
      peer: "peer-a",
      peer_name: "工作电脑",
      capability: "control",
      dir: "outbound",
      started_ms: 5000,
      ended_ms: 6000,
      duration_ms: 1000,
      reason: "正常结束",
    },
    {
      peer: "peer-a",
      peer_name: "工作电脑",
      capability: "view",
      dir: "outbound",
      started_ms: 4000,
      ended_ms: 4500,
      duration_ms: 500,
      reason: "用户结束会话",
    },
  ],
  reload: vi.fn(),
}));
vi.mock("@/hooks/useRcHistory", () => ({
  useRcHistory: () => ({ list: hist.list, loading: false, err: null, reload: hist.reload }),
}));

import { RcWorkbench } from "./RcWorkbench";

/** 后端只回传会话位；这里只摆本用例会用到的字段。 */
function status(phase: RcSession["phase"] | null, running = false): RcStatus {
  return {
    enabled: false,
    capability: "control",
    session: phase
      ? {
          id: "s-1",
          peer: "peer-a",
          peer_name: "工作电脑",
          capability: "control",
          phase,
          started_ms: 1_700_000_000_000,
          granted: true,
        }
      : null,
    pending: [],
    joins: [],
    device_deny: {},
    running,
    quality: "auto",
    capture_scope: "virtual",
  } as RcStatus;
}

describe("RcWorkbench 骨架：会话态收标题栏（A 方案稿 批2 / 批7 自绘）", () => {
  it("出站会话态不渲染标题栏，画面接管整个工作台", () => {
    h.status = status("outbound_active");
    const { container } = render(<RcWorkbench />);

    expect(screen.queryByRole("banner")).toBeNull();
    // 标题栏里那格通道状态位也不该在（它是标题栏的一部分）
    expect(screen.queryByText(/远程通道已开启|通道未启动/)).toBeNull();
    // 会话画面本身要在
    expect(screen.getByText("会话画面（已 mock）")).toBeTruthy();
    // 也不该反过来把侧栏留下（会话态是置顶的全宽面）
    expect(container.querySelector("[data-rc-root]")).toBeTruthy();
  });

  it("空闲态渲染标题栏：品牌 + 通道状态位 + 三个自绘窗口按钮", () => {
    h.status = status(null);
    render(<RcWorkbench />);

    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByText("PastePanda")).toBeTruthy();
    // mock 的 running=false → 状态位落在「可点的补救入口」那一支（不是只读文字）
    expect(screen.getByRole("button", { name: /通道未启动 · 点击开启/ })).toBeTruthy();
    // 批7：窗口改 decorations(false) 后系统按钮没了，这三个得自己画
    for (const name of ["最小化", "最大化", "关闭"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("等待对方同意的态也留标题栏", () => {
    h.status = status("outbound_pending");
    render(<RcWorkbench />);

    expect(screen.getByRole("banner")).toBeTruthy();
  });
});

describe("RcWorkbench 接线：会话历史一源两处（批5）", () => {
  it("记录页：侧栏换成「按设备筛选」，计数与内容区列表同源", () => {
    h.status = status(null);
    render(<RcWorkbench />);

    fireEvent.click(screen.getByRole("button", { name: "记录" }));

    // 侧栏：设备列表让位给筛选列表，计数取自同一份 mock
    expect(screen.getByText("按设备筛选")).toBeTruthy();
    expect(screen.getByRole("button", { name: /全部设备，2 条会话记录/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /工作电脑，2 条记录/ })).toBeTruthy();
    expect(screen.queryByRole("searchbox", { name: "搜索设备" })).toBeNull();
    // 内容区：同一条记录的列表本体
    expect(screen.getByRole("region", { name: "会话记录" })).toBeTruthy();
    expect(screen.getByText("正常结束")).toBeTruthy();
  });

  it("记录页带「清空记录」入口——日志可见可删除的删除口在本页", () => {
    h.status = status(null);
    render(<RcWorkbench />);

    fireEvent.click(screen.getByRole("button", { name: "记录" }));
    expect(screen.getByRole("button", { name: /清空记录/ })).toBeTruthy();
  });

  it("筛选到某台设备后，只有它的记录留在列表里", () => {
    h.status = status(null);
    render(<RcWorkbench />);

    fireEvent.click(screen.getByRole("button", { name: "记录" }));
    fireEvent.click(screen.getByRole("button", { name: /工作电脑，2 条记录/ }));

    expect(screen.getByRole("button", { name: /工作电脑，2 条记录/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByText("正常结束")).toBeTruthy();
  });
});

/**
 * 批7 行为审查补的钉子（2026-09-22）。
 *
 * 探测入口从标题栏下放到设备行之后，「通道未启动」这个前置条件**不再由「不渲染设备
 * 列表」代管**（已作死代码删除的旧址侧栏 RcWorkbenchSide 就是靠不渲染来躲的），必须
 * 由 `probeOne` 显式挡。
 * 实证过的失败形态：通道未启动时点「检测」→ `rc_probe_targets` 调用 **0** 次、
 * 无 toast、无 error，按钮文案原地不动 —— 静默死按钮。
 *
 * 两条成对写：① 挡得住；② **不许挡住正常路径**（守卫写错方向是很常见的回归）。
 */
const OFFLINE_TARGET: RcTargetDevice = {
  node_id: "peer-a",
  name: "工作电脑",
  conn_state: "ready",
  last_seen: Date.now() - 3_600_000,
  denied: false,
  source: "rc",
  presence: "never",
  last_path: "lan",
  trusted: false,
  auto_accept: false,
};

describe("RcWorkbench 接线：自动确认与通道前置", () => {
  beforeEach(() => {
    h.targets = [];
    toastSpy.mockReset();
    h.probeTargets.mockReset();
    h.probeTargets.mockResolvedValue(undefined);
    h.refreshTargets.mockReset().mockImplementation(async () => h.targets);
    h.visible = true;
  });

  it("通道未启动时状态明确可见，且不发探测", async () => {
    h.status = status(null); // running=false
    h.targets = [OFFLINE_TARGET];
    render(<RcWorkbench />);

    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole("button", { name: /选择设备“工作电脑”/ }).textContent).toContain("状态无法获取 · 通道未启动");
    expect(h.probeTargets).not.toHaveBeenCalled();
  });

  it("通道已启动时自动探测，无需手动点设备行", async () => {
    h.status = status(null, true); // running=true
    h.targets = [OFFLINE_TARGET];
    render(<RcWorkbench />);

    await waitFor(() => expect(h.probeTargets).toHaveBeenCalledWith(["peer-a"]));

    expect(toastSpy).not.toHaveBeenCalledWith(expect.stringContaining("远程通道未启动"), "error");
  });
});

describe("RcWorkbench 自动确认设备", () => {
  beforeEach(() => {
    h.targets = [OFFLINE_TARGET];
    h.status = status(null, true);
    h.visible = true;
    h.probeTargets.mockReset().mockResolvedValue(undefined);
    h.refreshTargets.mockReset().mockImplementation(async () => h.targets);
  });

  it("打开可见工作台后自动确认设备，无需先点检测", async () => {
    render(<RcWorkbench />);
    await waitFor(() => expect(h.probeTargets).toHaveBeenCalledWith(["peer-a"]));
  });

  it("隐藏工作台不会自动探测设备", async () => {
    h.visible = false;
    render(<RcWorkbench />);
    await act(async () => { await Promise.resolve(); });
    expect(h.probeTargets).not.toHaveBeenCalled();
  });
});
