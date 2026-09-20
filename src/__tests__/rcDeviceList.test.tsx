/**
 * RcDeviceList 守卫单测 —— B 方案「设备行直发」改造的三条必测项
 * （design/远程电脑-交互精简-B方案-设计稿.html §6 风险 #1）：
 *
 * 整行可点之后，**行内任何一个控件漏了 stopPropagation 都会多发一次申请**——
 * 点「更多」弹出菜单的同时顺手发一个远程申请，是最坏的用户体验。
 * 这组测试钉死：菜单交互零副作用、指定档发起只发一次、syncOnly 不给发起入口。
 *
 * A1（2026-09-18）追加：备注名显示优先级与行内编辑的副作用隔离。
 * 方案 A（2026-09-18）追加：操作区图标化后，行内文本按钮全部变成 26px 图标按钮，
 *   所以下面一律用 `getByLabelText("发起远程"/"去配对"/"更多操作")` 定位 ——
 *   图标按钮的 **aria-label 就是它唯一的无障碍名**，测试也顺带钉住「不许漏 label」。
 *   同时钉住「解除禁止」收进菜单后，`setAllowed` 的传参方向（曾经反了两次）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { RcDeviceList } from "@/components/rc/RcDeviceList";
import type { RcTargetDevice } from "@/lib/api/rc";

const DEV: RcTargetDevice = {
  node_id: "peerA",
  name: "甲机",
  conn_state: "lan",
  last_seen: Date.now() - 30_000,
  denied: false,
  source: "rc",
  presence: "live",
  last_path: "lan",
};

const SYNC_ONLY: RcTargetDevice = {
  ...DEV,
  node_id: "peerB",
  name: "乙机",
  source: "sync",
};

function setup(
  targets: RcTargetDevice[],
  requestCap: "view" | "control" = "view",
  locked = false,
) {
  const onRequest = vi.fn();
  const onRequestWith = vi.fn();
  const onRename = vi.fn().mockResolvedValue(true);
  const onTrustToggle = vi.fn().mockResolvedValue(true);
  const onAutoAcceptToggle = vi.fn().mockResolvedValue(true);
  const onSetAllowed = vi.fn().mockResolvedValue(true);
  render(
    <RcDeviceList
      targets={targets}
      lastPeer={null}
      deviceDeny={{}}
      busy={false}
      locked={locked}
      lockedLabel="远程会话进行中"
      requestCap={requestCap}
      onRequest={onRequest}
      onRequestWith={onRequestWith}
      onForget={vi.fn().mockResolvedValue(true)}
      onSetAllowed={onSetAllowed}
      onTrustToggle={onTrustToggle}
      onAutoAcceptToggle={onAutoAcceptToggle}
      onRename={onRename}
      onPair={vi.fn()}
      toast={vi.fn()}
    />,
  );
  return {
    onRequest,
    onRequestWith,
    onRename,
    onTrustToggle,
    onAutoAcceptToggle,
    onSetAllowed,
  };
}

/** 设备行根节点（className 含 devItem 哈希） */
const rowOf = (name: string) =>
  screen.getByText(name).closest('[class*="devItem"]') as HTMLElement;

beforeEach(() => {
  cleanup();
});

describe("RcDeviceList 守卫（B 方案：整行可点后的副作用隔离）", () => {
  it("🔴 点「更多」只开菜单，不触发发起——整行可点后行内控件必须 stopPropagation", () => {
    const { onRequest } = setup([DEV]);
    fireEvent.click(screen.getByLabelText("更多操作"));
    // 菜单开了
    expect(screen.getByText("以「只看」发起")).toBeTruthy();
    // 但一次申请都没发
    expect(onRequest).not.toHaveBeenCalled();
  });

  it("🔴 菜单指定档发起各发对各的档，且只发一次（不连带行点击）", () => {
    const { onRequest, onRequestWith } = setup([DEV]);
    fireEvent.click(screen.getByLabelText("更多操作"));
    fireEvent.click(screen.getByText("以「可控」发起"));
    expect(onRequestWith).toHaveBeenCalledTimes(1);
    expect(onRequestWith).toHaveBeenCalledWith("peerA", "control");
    expect(onRequest).not.toHaveBeenCalled();

    // 再开菜单，走「只看」
    fireEvent.click(screen.getByLabelText("更多操作"));
    fireEvent.click(screen.getByText("以「只看」发起"));
    expect(onRequestWith).toHaveBeenCalledTimes(2);
    expect(onRequestWith).toHaveBeenLastCalledWith("peerA", "view");
    expect(onRequest).not.toHaveBeenCalled();
  });

  it("🔴 主按钮「发起」按 requestCap 发；菜单关闭状态点行 = 直发", () => {
    const { onRequest } = setup([DEV], "control");
    // 整行点击 = 同一个主动作
    fireEvent.click(rowOf("甲机"));
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onRequest).toHaveBeenCalledWith("peerA");
  });

  it("🔴 syncOnly 设备：无「发起」按钮、无改档菜单、点行不发申请（它的下一步是「去配对」）", () => {
    const { onRequest, onRequestWith } = setup([SYNC_ONLY]);
    expect(screen.queryByLabelText("发起远程")).toBeNull();
    expect(screen.getByLabelText("去配对")).toBeTruthy();
    // 整行点击刻意不接发起
    fireEvent.click(rowOf("乙机"));
    expect(onRequest).not.toHaveBeenCalled();
    // 菜单里也不该出现「以指定方式发起」组（该项由 !syncOnly 控制）
    fireEvent.click(screen.getByLabelText("更多操作"));
    expect(screen.queryByText("以「只看」发起")).toBeNull();
    expect(screen.queryByText("以「可控」发起")).toBeNull();
    expect(onRequestWith).not.toHaveBeenCalled();
  });

  it("菜单开着时点行 = 只收菜单，不当成发起", () => {
    const { onRequest } = setup([DEV]);
    fireEvent.click(screen.getByLabelText("更多操作"));
    expect(screen.getByText("忘记设备")).toBeTruthy();
    fireEvent.click(rowOf("甲机"));
    expect(onRequest).not.toHaveBeenCalled();
    expect(screen.queryByText("忘记设备")).toBeNull();
  });

  // —— A1：本地备注名 ——
  it("A1：有备注显示备注，自报名括号保留；没备注回落自报名", () => {
    setup([{ ...DEV, note: "客厅的电脑" }]);
    expect(screen.getByText("客厅的电脑")).toBeTruthy();
    expect(screen.getByText(/甲机/)).toBeTruthy();
    cleanup();
    setup([{ ...DEV }]); // 没备注
    expect(screen.getByText("甲机")).toBeTruthy();
  });

  it("A1：改名入口在菜单里；保存调 onRename 且不触发发起；编辑框不因行点击误关自己之外的东西", async () => {
    const { onRename, onRequest } = setup([DEV]);
    fireEvent.click(screen.getByLabelText("更多操作"));
    fireEvent.click(screen.getByText("设置备注名"));
    expect(screen.queryByText("忘记设备")).toBeNull(); // 菜单收起
    const input = screen.getByPlaceholderText("甲机") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "客厅的电脑" } });
    fireEvent.click(screen.getByText("保存"));
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith("peerA", "客厅的电脑");
    expect(onRequest).not.toHaveBeenCalled();
    await act(async () => {}); // 收掉 saveRename 的异步收尾（收编辑框），保持测试输出干净
  });

  it("A1：onRename 失败（false）时编辑框保持打开，不让用户白打字", async () => {
    const onRequest = vi.fn();
    const onRenameFail = vi.fn().mockResolvedValue(false);
    render(
      <RcDeviceList
        targets={[DEV]}
        lastPeer={null}
        deviceDeny={{}}
        busy={false}
        locked={false}
        lockedLabel="远程会话进行中"
        requestCap="view"
        onRequest={onRequest}
        onRequestWith={vi.fn()}
        onForget={vi.fn().mockResolvedValue(true)}
        onSetAllowed={vi.fn().mockResolvedValue(true)}
        onTrustToggle={vi.fn().mockResolvedValue(true)}
        onAutoAcceptToggle={vi.fn().mockResolvedValue(true)}
        onRename={onRenameFail}
        toast={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("更多操作"));
    fireEvent.click(screen.getByText("设置备注名"));
    fireEvent.change(screen.getByPlaceholderText("甲机"), { target: { value: "X" } });
    fireEvent.click(screen.getByText("保存"));
    // vi.runAllTicks 等价：直接 flush microtask
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByPlaceholderText("甲机")).toBeTruthy();
  });

  // —— A1（免确认直连）：把方案 D 的能力从设置页端到设备行 ——
  it("A1：免确认入口在菜单里，标签是动作；点它只调 onTrustToggle，不触发发起", async () => {
    const { onTrustToggle, onRequest } = setup([DEV]); // trusted 缺省 = false
    expect(screen.queryByText("免确认")).toBeNull(); // 没开就没有徽章
    fireEvent.click(screen.getByLabelText("更多操作"));
    fireEvent.click(screen.getByText("以后不再询问"));
    expect(onTrustToggle).toHaveBeenCalledTimes(1);
    expect(onTrustToggle).toHaveBeenCalledWith("peerA", true);
    expect(onRequest).not.toHaveBeenCalled();
    // 收尾是异步的（等 Promise）：用 act 冲掉状态更新后菜单应已收起
    await act(async () => {});
    expect(screen.queryByText("以后不再询问")).toBeNull();
  });

  it("A1：已免确认的设备行有常驻徽章，菜单改成「恢复每次询问」并回调 trusted=false", async () => {
    const { onTrustToggle } = setup([{ ...DEV, trusted: true }]);
    expect(screen.getByText("免确认")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("更多操作"));
    expect(screen.queryByText("以后不再询问")).toBeNull();
    fireEvent.click(screen.getByText("恢复每次询问"));
    expect(onTrustToggle).toHaveBeenCalledWith("peerA", false);
    await act(async () => {}); // 收掉异步收尾的状态更新，别把 act 警告留给下一个人
  });

  it("🔴 A1：syncOnly 与 denied 都不摆免确认项（点了也不生效，摆出来就是死项）", () => {
    // 同步配对设备：还没有 rc_devices 行
    setup([SYNC_ONLY]);
    fireEvent.click(screen.getByLabelText("更多操作"));
    expect(screen.queryByText("以后不再询问")).toBeNull();
    expect(screen.queryByText("恢复每次询问")).toBeNull();
    cleanup();

    // 已禁止远程本机：deny 优先级高于免确认
    setup([{ ...DEV, denied: true }]);
    fireEvent.click(screen.getByLabelText("更多操作"));
    expect(screen.queryByText("以后不再询问")).toBeNull();
    expect(screen.queryByText("恢复每次询问")).toBeNull();
    cleanup();

    // 已免确认 + 刚被禁止：徽章也不能留着（那时真实状态是「已禁止」）
    setup([{ ...DEV, denied: true, trusted: true }]);
    expect(screen.queryByText("免确认")).toBeNull();
    expect(screen.getByText("已禁止控本机")).toBeTruthy();
  });

  // —— 决策 10（自动接收文件）：与免确认一样，入口在菜单、当前态在行上 ——
  it("决策 10：自动接收入口在菜单里，点它调 onAutoAcceptToggle(id, true)，不触发发起", async () => {
    const { onAutoAcceptToggle, onRequest } = setup([DEV]); // auto_accept 缺省 = false
    expect(screen.queryByText("自动收文件")).toBeNull(); // 没开就没有徽章
    fireEvent.click(screen.getByLabelText("更多操作"));
    fireEvent.click(screen.getByText("自动接收此设备的文件"));
    expect(onAutoAcceptToggle).toHaveBeenCalledTimes(1);
    expect(onAutoAcceptToggle).toHaveBeenCalledWith("peerA", true);
    expect(onRequest).not.toHaveBeenCalled();
    await act(async () => {});
    expect(screen.queryByText("自动接收此设备的文件")).toBeNull();
  });

  it("决策 10：已开启的设备行有常驻徽章，菜单改成「关闭自动接收文件」并回调 on=false", async () => {
    const { onAutoAcceptToggle } = setup([{ ...DEV, auto_accept: true }]);
    // 🔴 徽章文案必须与「免确认」区分开：一个是「能控我屏幕」，一个是「文件会自动落盘」
    expect(screen.getByText("自动收文件")).toBeTruthy();
    expect(screen.queryByText("免确认")).toBeNull();
    fireEvent.click(screen.getByLabelText("更多操作"));
    expect(screen.queryByText("自动接收此设备的文件")).toBeNull();
    fireEvent.click(screen.getByText("关闭自动接收文件"));
    expect(onAutoAcceptToggle).toHaveBeenCalledWith("peerA", false);
    await act(async () => {});
  });

  it("🔴 决策 10：syncOnly 与 denied 都不摆自动接收项；denied 时徽章也不留", () => {
    // 同步配对设备：还没有 rc_devices 行可写
    setup([SYNC_ONLY]);
    fireEvent.click(screen.getByLabelText("更多操作"));
    expect(screen.queryByText("自动接收此设备的文件")).toBeNull();
    expect(screen.queryByText("关闭自动接收文件")).toBeNull();
    cleanup();

    // 已禁止远程本机：deny 优先级更高，开了也不生效（摆出来就是死项）
    setup([{ ...DEV, denied: true }]);
    fireEvent.click(screen.getByLabelText("更多操作"));
    expect(screen.queryByText("自动接收此设备的文件")).toBeNull();
    cleanup();

    // 已开启 + 刚被禁止：徽章不能留着（否则读起来像「还在自动收」）
    setup([{ ...DEV, denied: true, auto_accept: true }]);
    expect(screen.queryByText("自动收文件")).toBeNull();
    expect(screen.getByText("已禁止控本机")).toBeTruthy();
  });

  // —— 方案 A：操作区图标化（26px）——
  it("🔴 方案 A：行内图标按钮必须带无障碍名；行内不再有「解除禁止」", () => {
    setup([DEV]);
    // 图标按钮没有可见文字，aria-label 就是它唯一的无障碍名（缺失 = 屏幕阅读器念不出）
    expect(screen.getByLabelText("发起远程")).toBeTruthy();
    expect(screen.getByLabelText("更多操作")).toBeTruthy();
    // 主按钮的 title 必须写明将以哪一档发起（能力记忆，设计稿风险 #3）
    expect(screen.getByLabelText("发起远程").getAttribute("title")).toContain("只看");
    // 「解除禁止」已收进 ⋯ 菜单，行内不该再有
    expect(screen.queryByText("解除禁止")).toBeNull();
  });

  it("🔴 方案 A：已禁止设备 —— 菜单「允许远程本机」是解除禁止的唯一出口", async () => {
    const { onSetAllowed, onRequest } = setup([{ ...DEV, denied: true }]);
    expect(screen.queryByText("解除禁止")).toBeNull();
    fireEvent.click(screen.getByLabelText("更多操作"));
    // 当前态是「已禁止」，禁止项就不该再摆（点了也不生效 = 死项）
    expect(screen.queryByText("禁止远程本机")).toBeNull();
    fireEvent.click(screen.getByText("允许远程本机"));
    expect(onSetAllowed).toHaveBeenCalledTimes(1);
    expect(onSetAllowed).toHaveBeenCalledWith("peerA", true);
    expect(onRequest).not.toHaveBeenCalled();
    // 收尾是异步的（等 Promise）：用 act 冲掉状态更新后菜单应已收起
    await act(async () => {});
  });

  it("🔴 方案 A：未禁止设备 —— 菜单「禁止远程本机」必须真的传 allowed=false", async () => {
    // 这条钉死 hook 的入参语义：曾经是「当前是否已禁止」再取反，两边反了两次，
    // 导致「禁止」发出去的其实是「允许」。断言传参方向，不看 toast。
    const { onSetAllowed } = setup([DEV]);
    fireEvent.click(screen.getByLabelText("更多操作"));
    expect(screen.queryByText("允许远程本机")).toBeNull();
    fireEvent.click(screen.getByText("禁止远程本机"));
    expect(onSetAllowed).toHaveBeenCalledTimes(1);
    expect(onSetAllowed).toHaveBeenCalledWith("peerA", false);
    await act(async () => {});
  });

  it("🔴 方案 A：纯同步 + 已禁止仍有菜单（早返回已删，否则解除禁止彻底没入口）", () => {
    setup([{ ...SYNC_ONLY, denied: true }]);
    fireEvent.click(screen.getByLabelText("更多操作"));
    expect(screen.getByText("允许远程本机")).toBeTruthy();
  });

  it("🔴 方案 A：图标化后菜单触发钮仍是「菜单交互零副作用」", () => {
    const { onRequest } = setup([DEV]);
    fireEvent.click(screen.getByLabelText("更多操作"));
    expect(screen.getByText("以「只看」发起")).toBeTruthy();
    expect(onRequest).not.toHaveBeenCalled();
  });

  // —— 会话进行中锁定（后端只有一个会话位，发起必被 busy_local 拒）——
  it("🔴 locked：整行点击与「发起」都不发申请（不摆点了必失败的入口）", () => {
    const { onRequest } = setup([DEV], "view", true);
    fireEvent.click(rowOf("甲机"));
    expect(onRequest).not.toHaveBeenCalled();
    const btn = screen.getByLabelText("发起远程") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onRequest).not.toHaveBeenCalled();
  });

  it("🔴 locked：菜单项一并禁用（按钮禁用了，菜单不能留成后门）", () => {
    const { onRequestWith } = setup([DEV], "view", true);
    fireEvent.click(screen.getByLabelText("更多操作"));
    const cap = screen.getByText("以「可控」发起") as HTMLButtonElement;
    expect(cap.disabled).toBe(true);
    fireEvent.click(cap);
    expect(onRequestWith).not.toHaveBeenCalled();
  });

  it("locked 不影响纯同步设备行（它的出口是「去配对」，与会话位无关）", () => {
    const onPair = vi.fn();
    render(
      <RcDeviceList
        targets={[SYNC_ONLY]}
        lastPeer={null}
        deviceDeny={{}}
        busy={false}
        locked
        lockedLabel="远程会话进行中"
        requestCap="view"
        onRequest={vi.fn()}
        onRequestWith={vi.fn()}
        onForget={vi.fn().mockResolvedValue(true)}
        onSetAllowed={vi.fn().mockResolvedValue(true)}
        onTrustToggle={vi.fn().mockResolvedValue(true)}
        onAutoAcceptToggle={vi.fn().mockResolvedValue(true)}
        onRename={vi.fn().mockResolvedValue(true)}
        onPair={onPair}
        toast={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("去配对"));
    expect(onPair).toHaveBeenCalledTimes(1);
  });
});
