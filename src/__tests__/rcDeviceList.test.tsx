/**
 * RcDeviceList 守卫单测 —— B 方案「设备行直发」改造的三条必测项
 * （design/远程电脑-交互精简-B方案-设计稿.html §6 风险 #1）：
 *
 * 整行可点之后，**行内任何一个控件漏了 stopPropagation 都会多发一次申请**——
 * 点「更多」弹出菜单的同时顺手发一个远程申请，是最坏的用户体验。
 * 这组测试钉死：菜单交互零副作用、指定档发起只发一次、syncOnly 不给发起入口。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
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

function setup(targets: RcTargetDevice[], requestCap: "view" | "control" = "view") {
  const onRequest = vi.fn();
  const onRequestWith = vi.fn();
  render(
    <RcDeviceList
      targets={targets}
      lastPeer={null}
      deviceDeny={{}}
      busy={false}
      requestCap={requestCap}
      onRequest={onRequest}
      onRequestWith={onRequestWith}
      onForget={vi.fn().mockResolvedValue(true)}
      onSetAllowed={vi.fn().mockResolvedValue(true)}
      onPair={vi.fn()}
      toast={vi.fn()}
    />,
  );
  return { onRequest, onRequestWith };
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
    fireEvent.click(screen.getByText("更多"));
    // 菜单开了
    expect(screen.getByText("以「只看」发起")).toBeTruthy();
    // 但一次申请都没发
    expect(onRequest).not.toHaveBeenCalled();
  });

  it("🔴 菜单指定档发起各发对各的档，且只发一次（不连带行点击）", () => {
    const { onRequest, onRequestWith } = setup([DEV]);
    fireEvent.click(screen.getByText("更多"));
    fireEvent.click(screen.getByText("以「可控」发起"));
    expect(onRequestWith).toHaveBeenCalledTimes(1);
    expect(onRequestWith).toHaveBeenCalledWith("peerA", "control");
    expect(onRequest).not.toHaveBeenCalled();

    // 再开菜单，走「只看」
    fireEvent.click(screen.getByText("更多"));
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
    expect(screen.queryByText("发起")).toBeNull();
    expect(screen.getByText("去配对")).toBeTruthy();
    // 整行点击刻意不接发起
    fireEvent.click(rowOf("乙机"));
    expect(onRequest).not.toHaveBeenCalled();
    // 菜单里也不该出现「以指定方式发起」组（该项由 !syncOnly 控制）
    fireEvent.click(screen.getByText("更多"));
    expect(screen.queryByText("以「只看」发起")).toBeNull();
    expect(screen.queryByText("以「可控」发起")).toBeNull();
    expect(onRequestWith).not.toHaveBeenCalled();
  });

  it("菜单开着时点行 = 只收菜单，不当成发起", () => {
    const { onRequest } = setup([DEV]);
    fireEvent.click(screen.getByText("更多"));
    expect(screen.getByText("忘记设备")).toBeTruthy();
    fireEvent.click(rowOf("甲机"));
    expect(onRequest).not.toHaveBeenCalled();
    expect(screen.queryByText("忘记设备")).toBeNull();
  });
});
