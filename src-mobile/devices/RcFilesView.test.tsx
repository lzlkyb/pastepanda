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
  receiveDirSet: vi.fn(),
  pull: vi.fn(),
  respond: vi.fn(),
  cancel: vi.fn(),
  clearFinished: vi.fn(),
  snapshot: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@/lib/api/rcFile", () => ({
  rcFileDefaultDir: api.defaultDir,
  rcFileReceiveDirSet: api.receiveDirSet,
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
  useRcFileStore.setState({ error: null, errorPeer: null, busy: false });
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
  it("取回请求未返回时锁住目标，成功只说明等待电脑选文件", async () => {
    let finish!: () => void;
    api.pull.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    renderView([TARGET]);
    await waitFor(() => expect((screen.getByRole("button", { name: "从电脑取文件" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "从电脑取文件" }));
    expect((screen.getByRole("button", { name: /传输对象/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("正在发出取回请求…")).toBeTruthy();
    await act(async () => finish());
    expect(screen.getByText("已请求 台式机 选择文件，请在电脑上确认。")).toBeTruthy();
    expect((screen.getByRole("button", { name: /传输对象/ }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("取回目录被拒后可重置；只有重置成功才清错，下一次请求使用新目录", async () => {
    api.pull.mockRejectedValueOnce("接收目录建不出来：Permission denied (os error 13)").mockResolvedValue(undefined);
    api.receiveDirSet.mockRejectedValueOnce("接收目录仍不可用").mockResolvedValueOnce("/system/downloads/PastePanda 接收");
    renderView([TARGET]);
    await waitFor(() => expect((screen.getByRole("button", { name: "从电脑取文件" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "从电脑取文件" }));
    // 同一句文案先出现在 store 的通知里（无动作），晚一拍才出现在 actionErr 的通知里（带动作）；
    // 等文案会在负载高的机器上拿到中间帧，同步 getByRole 就判空——CI 的红色转储就是那一帧。等被点的按钮本身。
    const reset = await screen.findByRole("button", { name: "重置接收位置" });
    expect(screen.getByText(/无法在当前接收位置保存文件/)).toBeTruthy();
    expect(screen.queryByText("操作权限不足，请检查系统设置")).toBeNull();
    fireEvent.click(reset);
    expect(await screen.findByText("接收目录仍不可用")).toBeTruthy();
    // 重置失败不把原取回失败伪装成已恢复；目录错误的重试可继续使用。
    fireEvent.click(await screen.findByRole("button", { name: "重置接收位置" }));
    expect(await screen.findByText("已恢复默认接收位置，请重新取文件。")).toBeTruthy();
    expect(api.receiveDirSet).toHaveBeenCalledWith("");
    fireEvent.click(screen.getByRole("button", { name: "从电脑取文件" }));
    await waitFor(() => expect(api.pull).toHaveBeenLastCalledWith("pc-1", "/system/downloads/PastePanda 接收"));
  });

  it("应用内部授权失败不显示重置目录或要求修改手机权限", async () => {
    api.pull.mockRejectedValueOnce("command rc_file_pull permission denied");
    renderView([TARGET]);
    await waitFor(() => expect((screen.getByRole("button", { name: "从电脑取文件" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "从电脑取文件" }));
    expect(await screen.findByText(/应用内部授权失败/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重置接收位置" })).toBeNull();
  });

  it("落点显示后端给的原样路径", async () => {
    renderView([TARGET]);
    fireEvent.click(screen.getByRole("button", { name: "查看接收位置" }));
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

  it("多台设备在弹层中选择，选中的那台被传给 pull", async () => {
    api.pull.mockResolvedValue(true);
    renderView([TARGET, { node_id: "pc-2", name: "笔记本", display_name: "笔记本" }]);
    fireEvent.click(screen.getByRole("button", { name: /传输对象/ }));
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
    expect(screen.getByText(/手机无法接受电脑取文件的请求/)).toBeTruthy();
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
