/**
 * 手机端文件页的守卫测试 —— 钉住几件「错了也看不出来」的事：
 *
 * ① 取回按钮拿的是**后端给的接收目录**（Android 上目录由 Rust 算——
 *    应用外部私有目录，前端拼路径必拼错）；
 * ② 对方推文件来的 ask 卡：接受 = 存进接收目录、拒绝 = 明确回绝——
 *    这是 push 方向唯一的人机关口，接错参数文件就落到不知道哪里；
 * ③ 任务行来自 rcFileStore 快照（事件驱动），取消/清空接到对应命令。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UseRc } from "@/hooks/useRc";
import { useRcFileStore } from "@/stores/rcFileStore";
import { RcFilesView } from "./RcFilesView";

const api = vi.hoisted(() => ({
  defaultDir: vi.fn(),
  pull: vi.fn(),
  respond: vi.fn(),
  cancel: vi.fn(),
  clearFinished: vi.fn(),
  snapshot: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@/lib/api/rcFile", () => ({
  rcFileDefaultDir: api.defaultDir,
  rcFilePull: api.pull,
  rcFileRespond: api.respond,
  rcFileCancel: api.cancel,
  rcFileClearFinished: api.clearFinished,
  rcFileSnapshot: api.snapshot,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: api.listen }));

/** 页面只需要 targets / identity 两个字段。 */
function renderView(targets: unknown[] = []) {
  const rc = {
    targets,
    identity: { node_id: "self", device_name: "手机", fingerprint: "AAAA" },
  } as unknown as UseRc;
  render(<RcFilesView rc={rc} />);
}

const TARGET = { node_id: "pc-1", name: "台式机", display_name: "台式机" };

beforeEach(() => {
  vi.clearAllMocks();
  api.defaultDir.mockResolvedValue("/storage/emulated/0/Android/data/app/files/PastePanda 接收");
  api.respond.mockResolvedValue(undefined);
  api.cancel.mockResolvedValue(undefined);
  api.clearFinished.mockResolvedValue(undefined);
  // 挂载时 acquire 会取一次首帧快照——让它按用例需要返回（数据走真实 applySnapshot 流）
  api.snapshot.mockResolvedValue({ asks: [], tasks: [] });
});

/** 把快照喂进挂载后的首帧（绕开「手动 setState 被异步首帧覆盖」的竞态）。 */
function snapshotFor(payload: unknown) {
  api.snapshot.mockResolvedValue(payload);
}

describe("接收落点与取回", () => {
  it("落点显示后端给的原样路径", async () => {
    renderView([TARGET]);
    await waitFor(() => expect(screen.getByText(/Android\/data/)).toBeTruthy());
  });

  it("没有配对设备 → 空态引导，不给取回按钮", () => {
    renderView([]);
    expect(screen.getByText(/还没有配对的电脑/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /从电脑取文件/ })).toBeNull();
  });

  it("点取回 → rcFilePull(设备, 落点)", async () => {
    api.pull.mockResolvedValue(true);
    renderView([TARGET]);
    await waitFor(() => expect(screen.getByRole("button", { name: /从电脑取文件/ })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /从电脑取文件/ }));
    });
    expect(api.pull).toHaveBeenCalledWith("pc-1", "/storage/emulated/0/Android/data/app/files/PastePanda 接收");
  });

  it("多台设备出现挑选 chips，选中的那台被传给 pull", async () => {
    api.pull.mockResolvedValue(true);
    renderView([TARGET, { node_id: "pc-2", name: "笔记本", display_name: "笔记本" }]);
    await waitFor(() => expect(screen.getByRole("radio", { name: "笔记本" })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "笔记本" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /从电脑取文件/ }));
    });
    expect(api.pull).toHaveBeenCalledWith("pc-2", expect.any(String));
  });

  it("发送方向就位：有设备时出「发文件到电脑」按钮（上载管线由 rcSendFiles.test 钉）", async () => {
    renderView([TARGET]);
    await waitFor(() => expect(screen.getByRole("button", { name: /发文件到电脑/ })).toBeTruthy());
    // 承接系统选择器的隐藏 input 在文档里（jsdom 点不出真选择器，管线在
    // rcSendFiles.test.ts 里已覆盖——这里只钉「入口在、不缺方向」）
    expect(document.querySelector("input[type='file'][multiple]")).toBeTruthy();
  });
});

describe("对方推来的 ask 卡", () => {
  const ASK = {
    id: "ask-1",
    peer: "pc-1",
    peer_name: "台式机",
    kind: "push",
    name: "报告.pdf",
    size: 2048,
    first_seen_ms: Date.now(),
  };

  it("接受 → respond(id, 接收目录)；拒绝 → respond(id, null)", async () => {
    snapshotFor({ asks: [ASK], tasks: [] });
    renderView([TARGET]);
    expect(await screen.findByText(/台式机 想给你发送文件/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "接受" }));
    });
    expect(api.respond).toHaveBeenCalledWith("ask-1", "/storage/emulated/0/Android/data/app/files/PastePanda 接收");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    });
    expect(api.respond).toHaveBeenCalledWith("ask-1", null);
  });

  it("pull 请求（电脑想从手机取文件）接受不了：禁用并指路，拒绝仍可用", async () => {
    snapshotFor({ asks: [{ ...ASK, kind: "pull", name: "", size: 0 }], tasks: [] });
    renderView([TARGET]);
    expect(await screen.findByText(/请求你发送文件/)).toBeTruthy();

    // 手机拿不出真实路径——接受必须禁用，且说明写清原因与替代路径
    expect((screen.getByRole("button", { name: "去选择文件" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/用下面的「发文件到电脑」/)).toBeTruthy();
    // 拒绝仍是活路（60 秒超时等价拒绝，但主动拒绝不用干等）
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    });
    expect(api.respond).toHaveBeenCalledWith("ask-1", null);
  });

  it("任务快照渲染成行，取消接到对应命令", async () => {
    snapshotFor({
      asks: [],
      tasks: [{
        id: "t-1", peer: "pc-1", peer_name: "台式机", dir: "recv",
        name: "报告.pdf", size: 1000, offset: 0, done: 400,
        state: "transferring", started_ms: Date.now(), updated_ms: Date.now(),
      }],
    });
    renderView([TARGET]);
    expect(await screen.findByText("报告.pdf")).toBeTruthy();
    expect(screen.getByText(/接收中 40%/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "取消 报告.pdf" }));
    });
    expect(api.cancel).toHaveBeenCalledWith("t-1");
  });
});
