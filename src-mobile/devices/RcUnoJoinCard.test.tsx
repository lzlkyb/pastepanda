/**
 * 手机端无人值守接入卡的守卫测试 —— 钉住「错了也看不出来」的三件事：
 *
 * ① 完整串（PPU-…）自带 node_id → 直接发起，不需要也不应该再让人选设备；
 * ② 裸码没有机器定位 → 必须先从已配对设备里认一台才能连（否则请求发给谁？）；
 * ③ 角色与凭证形态走对参数（code=接入码 / pass=固定密码，一律申请 control）——
 *    传错的表现是永远连不上，现场没有任何线索（规则 11.1）。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UseRc } from "@/hooks/useRc";
import { RcUnoJoinCard } from "./RcUnoJoinCard";

/** 摄像头由测试驱动：不碰真设备，只让 overlay 按剧本演。 */
const scan = vi.hoisted(() => ({ onFound: null as null | ((t: string) => void) }));
vi.mock("./useQrScan", () => ({
  useQrScan: (onFound: (t: string) => void) => {
    scan.onFound = onFound;
    return {
      state: "idle",
      videoRef: { current: null },
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
  },
}));

function renderCard(rc: Record<string, unknown>, fixedTarget?: string | null) {
  const base = {
    targets: [],
    identity: { node_id: "self-node", device_name: "手机", fingerprint: "AAAA-BBBB" },
    requestUno: vi.fn(async () => true),
    requestPass: vi.fn(async () => true),
    ...rc,
  } as unknown as UseRc;
  render(<RcUnoJoinCard rc={base} fixedTarget={fixedTarget ?? null} onClose={() => {}} onConnected={() => {}} />);
  return base;
}

const TARGETS = [
  { node_id: "node-aaaa1111", name: "台式机", display_name: "台式机" },
  { node_id: "node-bbbb2222", name: "笔记本", display_name: "笔记本" },
];

beforeEach(() => {
  scan.onFound = null;
});

describe("接入码（方案 B）", () => {
  it("完整串自带机器定位：粘上即可连，请求带上码与 node_id", async () => {
    const rc = renderCard({ targets: TARGETS });
    fireEvent.change(
      screen.getByLabelText("无人值守接入码"),
      { target: { value: "接入码：PPU-7K2M-9PQX-node-cccc3333" } },
    );
    // 完整串不需要再选设备（选设备的那一块不该出现）
    expect(screen.queryByText(/裸码不带机器定位/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    await waitFor(() =>
      expect(rc.requestUno).toHaveBeenCalledWith("node-cccc3333", "7K2M9PQX", "control"),
    );
  });

  it("裸码不带定位：没选设备时连接不可用，选了才发", async () => {
    const rc = renderCard({ targets: TARGETS });
    fireEvent.change(screen.getByLabelText("无人值守接入码"), { target: { value: "7K2M-9PQX" } });

    const connect = screen.getByRole("button", { name: "连接" }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    expect(screen.getByText(/裸码不带机器定位/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /台式机/ }));
    });
    expect(connect.disabled).toBe(false);

    fireEvent.click(connect);
    await waitFor(() => expect(rc.requestUno).toHaveBeenCalledWith("node-aaaa1111", "7K2M9PQX", "control"));
  });

  it("扫到电脑上出示的码 → 输入框自动填上完整串", async () => {
    renderCard({});
    fireEvent.click(screen.getByRole("button", { name: /扫一扫/ }));
    scan.onFound?.("PPU-7K2M-9PQX-node-cccc3333");
    await waitFor(() =>
      expect((screen.getByLabelText("无人值守接入码") as HTMLTextAreaElement).value).toContain("PPU-7K2M-9PQX"),
    );
  });

  it("认不出的码 → 明说，不静默", async () => {
    renderCard({});
    fireEvent.change(screen.getByLabelText("无人值守接入码"), { target: { value: "https://x.com/a" } });
    expect(screen.getByText(/认不出无人值守码/)).toBeTruthy();
  });
});

describe("固定密码（方案 C）", () => {
  it("密码 + 从配对设备里认机器 → requestPass", async () => {
    const rc = renderCard({ targets: TARGETS });
    fireEvent.click(screen.getByRole("radio", { name: /固定密码/ }));
    fireEvent.change(screen.getByLabelText("对方的固定密码"), { target: { value: "hunter2!" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /笔记本/ }));
    });

    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    await waitFor(() => expect(rc.requestPass).toHaveBeenCalledWith("node-bbbb2222", "hunter2!", "control"));
  });

  it("太短的密码连不了（与后端最短长度同口径）", () => {
    renderCard({ targets: TARGETS });
    fireEvent.click(screen.getByRole("radio", { name: /固定密码/ }));
    fireEvent.change(screen.getByLabelText("对方的固定密码"), { target: { value: "abc" } });
    expect((screen.getByRole("button", { name: "连接" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
