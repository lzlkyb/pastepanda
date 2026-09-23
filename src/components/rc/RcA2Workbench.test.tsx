import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { RcHistoryItem, RcTargetDevice } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";
import { useRcDeviceUi } from "@/hooks/useRcDeviceUi";
import { RcA2Sidebar } from "./RcA2Sidebar";
import { RcA2DeviceDetail } from "./RcA2DeviceDetail";
import { RcPageFiles } from "./RcPageFiles";

const confirmDialog = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/confirm", () => ({ confirmDialog }));
vi.mock("./RcFilePanel", () => ({
  RcFilePanel: ({ peer }: { peer: string }) => <div>文件目标：{peer}</div>,
}));

const TARGET: RcTargetDevice = {
  node_id: "peer-a",
  name: "工作电脑",
  conn_state: "ready",
  last_seen: Date.now(),
  denied: false,
  source: "rc",
  presence: "live",
  last_path: "lan",
  trusted: false,
  auto_accept: false,
};

/** 侧栏 props 大多同类：新用例只写与本用例相关的差异，其余走默认。 */
function renderSidebar(props: Partial<ComponentProps<typeof RcA2Sidebar>> = {}) {
  const defaults: ComponentProps<typeof RcA2Sidebar> = {
    page: "devices",
    targets: [],
    selectedId: null,
    busy: false,
    locked: false,
    lockedLabel: "",
    onSelect: vi.fn(),
    onConnect: vi.fn(),
    onPair: vi.fn(),
    onNavigate: vi.fn(),
  };
  return render(<RcA2Sidebar {...defaults} {...props} />);
}

describe("RcA2Sidebar", () => {
  it("点设备行只切换详情，连接必须点带文字的连接按钮", () => {
    const onSelect = vi.fn();
    const onConnect = vi.fn();
    render(
      <RcA2Sidebar
        page="devices"
        targets={[TARGET]}
        selectedId={null}
        busy={false}
        locked={false}
        lockedLabel=""
        onSelect={onSelect}
        onConnect={onConnect}
        onPair={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /选择设备“工作电脑”/ }));
    expect(onSelect).toHaveBeenCalledWith("peer-a");
    expect(onConnect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "连接工作电脑" }));
    expect(onConnect).toHaveBeenCalledWith("peer-a", "control");
  });

  it("没有设备时直接给添加设备入口，底部工具均有常驻文字", () => {
    const onPair = vi.fn();
    const onNavigate = vi.fn();
    render(
      <RcA2Sidebar
        page="devices"
        targets={[]}
        selectedId={null}
        busy={false}
        locked={false}
        lockedLabel=""
        onSelect={vi.fn()}
        onConnect={vi.fn()}
        onPair={onPair}
        onNavigate={onNavigate}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加设备" }));
    expect(onPair).toHaveBeenCalledTimes(1);
    for (const label of ["文件", "记录", "设置"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "文件" }));
    expect(onNavigate).toHaveBeenCalledWith("files");
  });

  it("文件页切换设备时留在文件页，避免重复的目标选择器", () => {
    const onSelect = vi.fn();
    const onNavigate = vi.fn();
    render(
      <RcA2Sidebar
        page="files"
        targets={[TARGET]}
        selectedId={null}
        busy={false}
        locked={false}
        lockedLabel=""
        onSelect={onSelect}
        onConnect={vi.fn()}
        onPair={vi.fn()}
        onNavigate={onNavigate}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /选择设备“工作电脑”/ }));
    expect(onSelect).toHaveBeenCalledWith("peer-a");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("保留被远程开关、一次性协助与接入码路径", () => {
    const onToggleSelf = vi.fn();
    const onHelpMe = vi.fn();
    const onHelpOther = vi.fn();
    const onUnoJoin = vi.fn();
    render(
      <RcA2Sidebar
        page="devices"
        targets={[]}
        selectedId={null}
        busy={false}
        locked={false}
        lockedLabel=""
        onSelect={vi.fn()}
        onConnect={vi.fn()}
        onPair={vi.fn()}
        onNavigate={vi.fn()}
        selfEnabled={false}
        onToggleSelf={onToggleSelf}
        onHelpMe={onHelpMe}
        onHelpOther={onHelpOther}
        onUnoJoin={onUnoJoin}
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "已暂停" }));
    fireEvent.click(screen.getByRole("button", { name: "让别人帮我" }));
    fireEvent.click(screen.getByRole("button", { name: "帮助别人" }));
    fireEvent.click(screen.getByRole("button", { name: "输入接入码" }));
    expect(onToggleSelf).toHaveBeenCalledWith(true);
    expect(onHelpMe).toHaveBeenCalledTimes(1);
    expect(onHelpOther).toHaveBeenCalledTimes(1);
    expect(onUnoJoin).toHaveBeenCalledTimes(1);
  });

  it("禁止入站不影响本机主动连接该设备", () => {
    const onConnect = vi.fn();
    render(
      <RcA2Sidebar
        page="devices"
        targets={[{ ...TARGET, denied: true }]}
        selectedId="peer-a"
        busy={false}
        locked={false}
        lockedLabel=""
        onSelect={vi.fn()}
        onConnect={onConnect}
        onPair={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    const connect = screen.getByRole("button", { name: "连接工作电脑" });
    expect((connect as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(connect);
    expect(onConnect).toHaveBeenCalledWith("peer-a", "control");
  });

  it("状态更新时设备保留原顺序，不因分组跳行", () => {
    renderSidebar({
      targets: [
        TARGET,
        { ...TARGET, node_id: "peer-b", name: "家里的电脑", presence: "seen" },
        { ...TARGET, node_id: "peer-c", name: "旧笔记本", presence: "never" },
      ],
    });

    expect(screen.getAllByRole("button", { name: /选择设备/ }).map((row) => row.getAttribute("aria-label"))).toEqual([
      "选择设备“工作电脑”",
      "选择设备“家里的电脑”",
      "选择设备“旧笔记本”",
    ]);
  });

  it("在线状态直接写在设备行", () => {
    renderSidebar({ targets: [TARGET] });

    const row = screen.getByRole("button", { name: /选择设备“工作电脑”/ });
    expect(row.textContent).toContain("在线");
  });

  it("未知状态不再把历史时间冒充当前状态", () => {
    renderSidebar({
      targets: [
        {
          ...TARGET,
          node_id: "peer-b",
          name: "旧笔记本",
          presence: "seen",
          last_seen: Date.now() - 3 * 24 * 60 * 60 * 1000,
          last_path: "relay",
        },
      ],
    });

    const row = screen.getByRole("button", { name: /选择设备“旧笔记本”/ });
    // U8：「尚未确认」改说用户视角的话
    expect(row.textContent).toContain("最近在线 · 未实测");
    expect(row.textContent).not.toContain("局域网在线");
  });

  it("搜索只过滤设备，不改变剩余设备的状态文字", () => {
    renderSidebar({
      targets: [
        TARGET,
        { ...TARGET, node_id: "peer-b", name: "家里的电脑", presence: "live" },
      ],
    });

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索设备" }), {
      target: { value: "家里" },
    });

    expect(screen.getByRole("button", { name: /选择设备“家里的电脑”/ }).textContent).toContain("在线");
    expect(screen.queryByRole("button", { name: /选择设备“工作电脑”/ })).toBeNull();
  });
});

describe("RcA2Sidebar 记录页形态（批5c）", () => {
  const HIST_FILTER = {
    devices: [
      { key: "peer-a", label: "工作电脑", count: 7, lastMs: 3 },
      { key: "peer-b", label: "家里的电脑", count: 5, lastMs: 2 },
    ],
    total: 12,
    peer: null,
    onSelect: vi.fn(),
  };

  it("记录页把设备列表换成「按设备筛选」，计数来自同一份快照", () => {
    renderSidebar({ page: "history", targets: [TARGET], historyFilter: HIST_FILTER });

    expect(screen.queryByRole("searchbox", { name: "搜索设备" })).toBeNull();
    expect(screen.getByRole("button", { name: /全部设备，12 条会话记录/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /工作电脑，7 条记录/ })).toBeTruthy();
    // 7 + 5 === 12：总数与各设备之和必须对得上
    expect(7 + 5).toBe(HIST_FILTER.total);
  });

  it("点筛选项把 node_id 交给上层，点「返回设备」回设备页", () => {
    const onSelect = vi.fn();
    const onNavigate = vi.fn();
    renderSidebar({
      page: "history",
      targets: [TARGET],
      historyFilter: { ...HIST_FILTER, onSelect },
      onNavigate,
    });

    fireEvent.click(screen.getByRole("button", { name: /家里的电脑，5 条记录/ }));
    expect(onSelect).toHaveBeenCalledWith("peer-b");

    fireEvent.click(screen.getByRole("button", { name: "返回设备" }));
    expect(onNavigate).toHaveBeenCalledWith("devices");
  });

  it("选中的那一项带 aria-pressed，其余不带", () => {
    renderSidebar({
      page: "history",
      targets: [TARGET],
      historyFilter: { ...HIST_FILTER, peer: "peer-a" },
    });

    expect(
      screen.getByRole("button", { name: /工作电脑，7 条记录/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: /全部设备，12 条会话记录/ }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("没有记录时不摆一个空的筛选列表", () => {
    renderSidebar({
      page: "history",
      targets: [],
      historyFilter: { ...HIST_FILTER, devices: [], total: 0 },
    });

    expect(screen.getByText("还没有会话记录")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /全部设备/ })).toBeNull();
  });
});

describe("RcPageFiles A2 模式", () => {
  it("由侧栏控制目标时不再渲染第二套设备选择器", () => {
    render(<RcPageFiles rc={{ targets: [TARGET] } as UseRc} selectedPeer="peer-a" showTargetPicker={false} />);

    expect(screen.queryByLabelText("选择目标设备")).toBeNull();
    expect(screen.getByText("文件目标：peer-a")).toBeTruthy();
  });
});

/** 详情面 props 大多同类：新用例只写差异，其余走默认。
 *  `ui` 由 DetailHost 提供（真实 useRcDeviceUi），测试不直接构造。 */
function detailProps(
  props: Partial<ComponentProps<typeof RcA2DeviceDetail>> = {},
): Omit<ComponentProps<typeof RcA2DeviceDetail>, "ui"> {
  return {
    target: TARGET,
    busy: false,
    locked: false,
    historyList: [],
    onConnect: vi.fn(),
    onSendFiles: vi.fn(),
    onPair: vi.fn(),
    onSetAllowed: vi.fn().mockResolvedValue(true),
    onSetTrust: vi.fn().mockResolvedValue(true),
    onSetAutoAccept: vi.fn().mockResolvedValue(true),
    onForget: vi.fn().mockResolvedValue(true),
    onRename: vi.fn(async () => true),
    onViewHistory: vi.fn(),
    toast: vi.fn(),
    ...props,
  };
}

/** 模拟工作台：ui 状态上提 + 渲染期 syncPeer（P3-7 / 规则 15.2）。 */
function DetailHost(props: Partial<ComponentProps<typeof RcA2DeviceDetail>> = {}) {
  const ui = useRcDeviceUi();
  const target = "target" in props ? props.target : TARGET;
  ui.syncPeer(target?.node_id ?? null);
  return <RcA2DeviceDetail {...detailProps({ ...props, target })} ui={ui} />;
}

function renderDetail(props: Partial<ComponentProps<typeof RcA2DeviceDetail>> = {}) {
  return render(<DetailHost {...props} />);
}

describe("RcA2DeviceDetail", () => {
  it("详情区把只看、可控和传文件接到各自真实动作", async () => {
    const onConnect = vi.fn();
    const onSendFiles = vi.fn();
    const onSetTrust = vi.fn().mockResolvedValue(true);
    const onSetAutoAccept = vi.fn().mockResolvedValue(true);
    const onForget = vi.fn().mockResolvedValue(true);
    renderDetail({ onConnect, onSendFiles, onSetTrust, onSetAutoAccept, onForget });

    fireEvent.click(screen.getByRole("button", { name: "连接并控制" }));
    fireEvent.click(screen.getByRole("button", { name: "只看" }));
    fireEvent.click(screen.getByRole("button", { name: "传文件" }));
    expect(onConnect.mock.calls).toEqual([
      ["peer-a", "control"],
      ["peer-a", "view"],
    ]);
    expect(onSendFiles).toHaveBeenCalledWith("peer-a");

    // 权限动作收在「管理此设备」里：未展开时不该常驻占位
    expect(screen.queryByRole("button", { name: "开启免确认" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /管理此设备/ }));
    fireEvent.click(screen.getByRole("button", { name: "开启免确认" }));
    fireEvent.click(screen.getByRole("button", { name: "开启自动接收文件" }));
    fireEvent.click(screen.getByRole("button", { name: "移除设备" }));
    // 2026-09-23 审计收口后，「开启免确认」先过共享确认框（lib/rcTrust）再写入，
    // 所以 trust 的落地比其它按钮晚一个微任务——用 waitFor 断言。
    await waitFor(() => expect(onSetTrust).toHaveBeenCalledWith("peer-a", true));
    expect(onSetAutoAccept).toHaveBeenCalledWith("peer-a", true);
    await waitFor(() => expect(onForget).toHaveBeenCalledWith("peer-a"));
    expect(confirmDialog).toHaveBeenCalled();
  });

  it("管理此设备是权限动作的唯一常驻入口，展开状态可读", () => {
    renderDetail();

    const toggle = screen.getByRole("button", { name: /管理此设备/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "移除设备" })).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: /管理此设备/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "移除设备" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /管理此设备/ }));
    expect(screen.queryByRole("button", { name: "移除设备" })).toBeNull();
  });

  it("换设备时收起管理面板，不把上一台的展开态带过去", () => {
    const { rerender } = renderDetail();
    fireEvent.click(screen.getByRole("button", { name: /管理此设备/ }));
    expect(screen.getByRole("button", { name: "移除设备" })).toBeTruthy();

    rerender(<DetailHost target={{ ...TARGET, node_id: "peer-b" }} />);
    expect(screen.queryByRole("button", { name: "移除设备" })).toBeNull();
    expect(screen.getByRole("button", { name: /管理此设备/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("设备详情保留改名能力，失败时不退出编辑", async () => {
    const onRename = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderDetail({ onRename });

    fireEvent.click(screen.getByRole("button", { name: "重命名设备" }));
    fireEvent.change(screen.getByRole("textbox", { name: "设备备注名" }), {
      target: { value: "书房电脑" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("peer-a", "书房电脑"));
    expect(screen.getByRole("textbox", { name: "设备备注名" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "设备备注名" })).toBeNull());
  });

  it("纯同步设备只给完成远程配对与入站允许动作", () => {
    const onPair = vi.fn();
    renderDetail({ target: { ...TARGET, source: "sync" }, onPair });

    fireEvent.click(screen.getByRole("button", { name: /管理此设备/ }));
    expect(screen.queryByRole("button", { name: "开启免确认" })).toBeNull();
    expect(screen.queryByRole("button", { name: "开启自动接收文件" })).toBeNull();
    expect(screen.queryByRole("button", { name: "移除设备" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重命名设备" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "完成远程配对" }));
    expect(onPair).toHaveBeenCalledTimes(1);
  });

  it("没有设备时说明下一步并直接进入配对", () => {
    const onPair = vi.fn();
    renderDetail({ target: null, onPair });

    expect(screen.getByText("配对第一台设备")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "开始配对" }));
    expect(onPair).toHaveBeenCalledTimes(1);
  });
});

describe("RcA2DeviceDetail 最近会话（批5a）", () => {
  function item(over: Partial<RcHistoryItem>): RcHistoryItem {
    return {
      peer: "peer-a",
      peer_name: "工作电脑",
      capability: "control",
      dir: "outbound",
      started_ms: 1_000,
      ended_ms: 2_000,
      duration_ms: 1_000,
      reason: "正常结束",
      ...over,
    };
  }

  it("只取本设备的最近 5 条，跨设备与更早的记录都不进来", () => {
    renderDetail({
      historyList: [
        item({ started_ms: 7000, reason: "最新一次" }),
        item({ started_ms: 6000, reason: "第二次" }),
        item({ started_ms: 5000, reason: "第三次" }),
        item({ started_ms: 4000, reason: "第四次" }),
        item({ started_ms: 3000, reason: "第五次" }),
        item({ started_ms: 2000, reason: "该被截掉的第六条" }),
        item({ started_ms: 9000, peer: "peer-b", peer_name: "别的电脑", reason: "别的设备的记录" }),
      ],
    });

    expect(screen.getByText("最新一次")).toBeTruthy();
    expect(screen.getByText("第五次")).toBeTruthy();
    // 超过 5 条的部分、以及别的设备的记录，都不该出现在详情面
    expect(screen.queryByText("该被截掉的第六条")).toBeNull();
    expect(screen.queryByText("别的设备的记录")).toBeNull();
  });

  it("不依赖后端顺序：先按时间倒序再截断", () => {
    renderDetail({
      historyList: [
        item({ started_ms: 1000, reason: "最旧的一条" }),
        item({ started_ms: 9000, reason: "实际最新" }),
        item({ started_ms: 5000, reason: "中间那条" }),
      ],
    });

    const rows = screen.getAllByText(/实际最新|中间那条|最旧的一条/);
    expect(rows.map((n) => n.textContent)).toEqual(["实际最新", "中间那条", "最旧的一条"]);
  });

  it("「上次连接」补上最近实测延迟——是实测值，不写「预计」", () => {
    renderDetail({ historyList: [item({ rtt_avg: 12 })] });

    expect(screen.getByText(/最近实测 ~12 ms/)).toBeTruthy();
  });

  it("从没采到过样本时整段不显示，不摆一个「~0 ms」", () => {
    renderDetail({ historyList: [item({})] });

    expect(screen.queryByText(/最近实测/)).toBeNull();
  });

  it("这台设备没有记录时给一句解释，不留空壳", () => {
    renderDetail({ historyList: [item({ peer: "peer-b", peer_name: "别的电脑" })] });

    expect(screen.getByText("这台设备还没有会话记录。")).toBeTruthy();
  });

  it("「查看全部」把用户带到记录页", () => {
    const onViewHistory = vi.fn();
    renderDetail({ historyList: [item({})], onViewHistory });

    fireEvent.click(screen.getByRole("button", { name: "查看全部" }));
    expect(onViewHistory).toHaveBeenCalledTimes(1);
  });
});

describe("RcA2DeviceDetail 系统标签（批6b）", () => {
  it("短连接刚成功时徽标不误称在线", () => {
    renderDetail({
      target: { ...TARGET, presence: "seen" },
      check: { state: "reachable", checkedAt: Date.now() },
    });
    expect(screen.getByText("刚刚可连接")).toBeTruthy();
    expect(screen.queryByText("在线")).toBeNull();
  });
  it("对端自报过系统时，标题行展示当前状态和系统", () => {
    renderDetail({ target: { ...TARGET, os: "Windows 11" } });

    const line = screen.getAllByText(/局域网在线/).find((el) => el.hasAttribute("data-tone"))?.parentElement;
    expect(line?.textContent).toBe("局域网在线 · Windows 11");
  });

  it("采不到系统（空串）时整段不渲染，不留一个孤立的「 · 」", () => {
    renderDetail({ target: { ...TARGET, os: "" } });

    expect(screen.queryByText(/Windows/)).toBeNull();
    const line = screen.getAllByText(/局域网在线/).find((el) => el.hasAttribute("data-tone"))?.parentElement;
    expect(line?.textContent).toBe("局域网在线");
  });

  it("字段整个缺失（旧后端 / 仅同步配对设备）同样不渲染，不炸", () => {
    // 默认 TARGET 刻意不带 os：代表「还没建立过会话」这一类设备
    renderDetail();

    const line = screen.getAllByText(/局域网在线/).find((el) => el.hasAttribute("data-tone"))?.parentElement;
    expect(line?.textContent).toBe("局域网在线");
  });
});

describe("RcA2DeviceList 自动状态与一步连接", () => {
  const withPresence = (presence: RcTargetDevice["presence"]): RcTargetDevice => ({
    ...TARGET,
    presence,
  });

  it("在线设备可连接", () => {
    renderSidebar({ targets: [withPresence("live")] });

    expect(screen.getByRole("button", { name: "连接工作电脑" })).toBeTruthy();
  });

  it("最近在线的设备也能一步连接，不要求先点检测", () => {
    const onConnect = vi.fn();
    renderSidebar({ targets: [withPresence("seen")], onConnect });

    const connect = screen.getByRole("button", { name: "连接工作电脑" });
    expect((connect as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(connect);
    expect(onConnect).toHaveBeenCalledWith("peer-a", "control");
  });

  it("自动确认的结果在行内常驻可见，失败不写成已离线", () => {
    renderSidebar({
      targets: [withPresence("seen")],
      reachability: { "peer-a": { state: "unreachable", checkedAt: Date.now() } },
    });
    const row = screen.getByRole("button", { name: /选择设备“工作电脑”/ });
    expect(row.textContent).toContain("暂时连不上");
    expect(row.textContent).toContain("检查");
    expect(screen.getByRole("button", { name: "连接工作电脑" })).toHaveProperty("disabled", false);
  });

  it("检查进行中在侧栏显示台数", () => {
    renderSidebar({
      targets: [withPresence("seen")],
      reachability: { "peer-a": { state: "checking" } },
    });
    expect(screen.getByText("1 台设备 · 正在确认 1 台")).toBeTruthy();
  });

  it("列表读取失败显示重试，不误称没有设备", () => {
    renderSidebar({ targets: [], targetsLoaded: false, targetsError: "读取失败" });
    expect(screen.getByText(/设备列表暂时无法加载/)).toBeTruthy();
    expect(screen.queryByText("还没有已配对的设备")).toBeNull();
  });
});
