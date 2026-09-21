import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RcTargetDevice } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";
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

    fireEvent.click(screen.getByRole("button", { name: "选择设备“工作电脑”" }));
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
});

describe("RcPageFiles A2 模式", () => {
  it("由侧栏控制目标时不再渲染第二套设备选择器", () => {
    render(<RcPageFiles rc={{ targets: [TARGET] } as UseRc} selectedPeer="peer-a" showTargetPicker={false} />);

    expect(screen.queryByLabelText("选择目标设备")).toBeNull();
    expect(screen.getByText("文件目标：peer-a")).toBeTruthy();
  });
});

describe("RcA2DeviceDetail", () => {
  it("详情区把只看、可控和传文件接到各自真实动作", async () => {
    const onConnect = vi.fn();
    const onSendFiles = vi.fn();
    const onSetTrust = vi.fn().mockResolvedValue(true);
    const onSetAutoAccept = vi.fn().mockResolvedValue(true);
    const onForget = vi.fn().mockResolvedValue(true);
    render(
      <RcA2DeviceDetail
        target={TARGET}
        busy={false}
        locked={false}
        onConnect={onConnect}
        onSendFiles={onSendFiles}
        onPair={vi.fn()}
        onSetAllowed={vi.fn().mockResolvedValue(true)}
        onSetTrust={onSetTrust}
        onSetAutoAccept={onSetAutoAccept}
        onForget={onForget}
        onRename={vi.fn(async () => true)}
        toast={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "连接并控制" }));
    fireEvent.click(screen.getByRole("button", { name: "只看" }));
    fireEvent.click(screen.getByRole("button", { name: "传文件" }));
    expect(onConnect.mock.calls).toEqual([
      ["peer-a", "control"],
      ["peer-a", "view"],
    ]);
    expect(onSendFiles).toHaveBeenCalledWith("peer-a");
    fireEvent.click(screen.getByRole("button", { name: "开启免确认连接" }));
    fireEvent.click(screen.getByRole("button", { name: "开启自动接收文件" }));
    fireEvent.click(screen.getByRole("button", { name: "移除设备" }));
    expect(onSetTrust).toHaveBeenCalledWith("peer-a", true);
    expect(onSetAutoAccept).toHaveBeenCalledWith("peer-a", true);
    await waitFor(() => expect(onForget).toHaveBeenCalledWith("peer-a"));
    expect(confirmDialog).toHaveBeenCalled();
  });

  it("设备详情保留改名能力，失败时不退出编辑", async () => {
    const onRename = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(
      <RcA2DeviceDetail
        target={TARGET}
        busy={false}
        locked={false}
        onConnect={vi.fn()}
        onSendFiles={vi.fn()}
        onPair={vi.fn()}
        onSetAllowed={vi.fn().mockResolvedValue(true)}
        onSetTrust={vi.fn().mockResolvedValue(true)}
        onSetAutoAccept={vi.fn().mockResolvedValue(true)}
        onForget={vi.fn().mockResolvedValue(true)}
        onRename={onRename}
        toast={vi.fn()}
      />,
    );

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
    render(
      <RcA2DeviceDetail
        target={{ ...TARGET, source: "sync" }}
        busy={false}
        locked={false}
        onConnect={vi.fn()}
        onSendFiles={vi.fn()}
        onPair={onPair}
        onSetAllowed={vi.fn().mockResolvedValue(true)}
        onSetTrust={vi.fn().mockResolvedValue(true)}
        onSetAutoAccept={vi.fn().mockResolvedValue(true)}
        onForget={vi.fn().mockResolvedValue(true)}
        onRename={vi.fn(async () => true)}
        toast={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "开启免确认连接" })).toBeNull();
    expect(screen.queryByRole("button", { name: "开启自动接收文件" })).toBeNull();
    expect(screen.queryByRole("button", { name: "移除设备" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重命名设备" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "完成远程配对" }));
    expect(onPair).toHaveBeenCalledTimes(1);
  });

  it("没有设备时说明下一步并直接进入配对", () => {
    const onPair = vi.fn();
    render(
      <RcA2DeviceDetail
        target={null}
        busy={false}
        locked={false}
        onConnect={vi.fn()}
        onSendFiles={vi.fn()}
        onPair={onPair}
        onSetAllowed={vi.fn().mockResolvedValue(true)}
        onSetTrust={vi.fn().mockResolvedValue(true)}
        onSetAutoAccept={vi.fn().mockResolvedValue(true)}
        onForget={vi.fn().mockResolvedValue(true)}
        onRename={vi.fn(async () => true)}
        toast={vi.fn()}
      />,
    );
    expect(screen.getByText("配对第一台设备")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "开始配对" }));
    expect(onPair).toHaveBeenCalledTimes(1);
  });
});
