/**
 * RcFileAsk 的确认条（G6 · B6）—— 钉住「以后自动接收此设备的文件」勾选的三条纪律：
 *
 * 1. **只在 push 上出现**：pull 是「我要发哪个」，没有可自动的东西，摆出来就是假开关。
 * 2. **勾上就不问目录**：以后那些也落同一个地方，这次却让挑一个别的目录，
 *    会让人以为「刚才挑的那个才是以后用的」。
 * 3. **设备记忆写不成必须说出来**：静默失败 = 用户以为已经免问，下次又弹确认条。
 *
 * 另外顺手钉住「不勾选时行为一点没变」——新分支最容易把老路径带坏。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** `@tauri-apps/plugin-dialog` 的系统选择框。默认返回一个「用户挑好的目录」。 */
  open: vi.fn(async (): Promise<string | null> => "D:/picked-by-user"),
  /** 默认接收目录（后端 `rc_file_default_dir`）。 */
  defaultDir: vi.fn(async () => "D:/Downloads/PastePanda 接收"),
  /** 写设备记忆（`rc_device_auto_accept_set`）。 */
  setAuto: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@/lib/api/rcFile", () => ({ rcFileDefaultDir: mocks.defaultDir }));
vi.mock("@/lib/api/rc", () => ({ rcDeviceAutoAcceptSet: mocks.setAuto }));

import { RcFileAskCard, RcFileAskLine } from "@/components/rc/RcFileAsk";
import type { RcFileAsk } from "@/lib/api/rcFile";

function ask(p: Partial<RcFileAsk> = {}): RcFileAsk {
  return {
    id: "a1",
    peer: "peerA",
    peer_name: "笔记本",
    kind: "push",
    name: "报告.zip",
    size: 12_400_000,
    first_seen_ms: 1_000,
    ...p,
  };
}

const AUTO_LABEL = "以后自动接收此设备的文件";

function renderCard(a: RcFileAsk, onRespond = vi.fn(async () => true)) {
  render(<RcFileAskCard ask={a} busy={false} onRespond={onRespond} />);
  return onRespond;
}

afterEach(() => {
  cleanup();
  mocks.open.mockClear();
  mocks.defaultDir.mockClear();
  mocks.setAuto.mockClear();
  mocks.open.mockImplementation(async (): Promise<string | null> => "D:/picked-by-user");
});

describe("勾选框的可见性", () => {
  it("push 卡上有勾选，一行版没有（一行版放不下也不会被误解）", () => {
    renderCard(ask());
    expect(screen.getByText(AUTO_LABEL)).toBeTruthy();

    cleanup();
    render(<RcFileAskLine ask={ask()} busy={false} onRespond={vi.fn(async () => true)} />);
    expect(screen.queryByText(AUTO_LABEL)).toBeNull();
  });

  it("🔴 pull 卡上**没有**勾选（对方要文件时没有「可自动」的东西）", () => {
    renderCard(ask({ kind: "pull", name: "", size: 0 }));
    expect(screen.queryByText(AUTO_LABEL)).toBeNull();
  });
});

describe("接受路径", () => {
  it("不勾选 = 老行为：弹系统选择框，用用户选的目录回应，**不写**设备记忆", async () => {
    const onRespond = renderCard(ask());
    await act(async () => {
      fireEvent.click(screen.getByText("选择保存位置"));
    });
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith("a1", "D:/picked-by-user");
    expect(mocks.setAuto).not.toHaveBeenCalled();
    // 选择框的**初始位置**仍取自默认目录（这是老行为，别被新分支带坏）：
    // 注意它此时只是「建议起点」，用户没选就不作数。
    expect(mocks.open).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, defaultPath: "D:/Downloads/PastePanda 接收" }),
    );
    // 没勾 → 不该去写设备记忆
    expect(mocks.setAuto).not.toHaveBeenCalled();
  });

  it("勾选后按钮变成「接受」：直接用默认目录回应，并写入设备记忆", async () => {
    const onRespond = renderCard(ask());
    fireEvent.click(screen.getByLabelText(AUTO_LABEL));
    // 勾上之后不该再写「选择保存位置」——那是在骗人（不会弹框）
    expect(screen.queryByText("选择保存位置")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText("接受"));
    });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.defaultDir).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith("a1", "D:/Downloads/PastePanda 接收");
    expect(mocks.setAuto).toHaveBeenCalledWith("peerA", true);
  });

  it("拿不到默认目录时退回让用户挑，而不是「点了接受什么也没发生」", async () => {
    mocks.defaultDir.mockRejectedValueOnce(new Error("没有下载目录"));
    const onRespond = renderCard(ask());
    fireEvent.click(screen.getByLabelText(AUTO_LABEL));
    await act(async () => {
      fireEvent.click(screen.getByText("接受"));
    });
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith("a1", "D:/picked-by-user");
  });

  it("🔴 设备记忆写不成要说出来（否则用户以为已经免问，下次又弹）", async () => {
    mocks.setAuto.mockRejectedValueOnce(new Error("这台设备不在远程配对列表里"));
    const onRespond = renderCard(ask());
    fireEvent.click(screen.getByLabelText(AUTO_LABEL));
    await act(async () => {
      fireEvent.click(screen.getByText("接受"));
    });
    // 文件本身收下了：不能说成「回应失败」
    expect(onRespond).toHaveBeenCalledWith("a1", "D:/Downloads/PastePanda 接收");
    expect(screen.getByText(/「自动接收」没存上/)).toBeTruthy();
  });

  it("取消系统选择框 = 不回应（让请求走 60s 超时，不替用户回一个他没选过的路径）", async () => {
    mocks.open.mockImplementationOnce(async () => null);
    const onRespond = renderCard(ask());
    await act(async () => {
      fireEvent.click(screen.getByText("选择保存位置"));
    });
    expect(onRespond).not.toHaveBeenCalled();
    expect(mocks.setAuto).not.toHaveBeenCalled();
  });
});
