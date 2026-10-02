import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rcFileDefaultDir, rcFileReceiveDirSet } from "@/lib/api/rcFile";
import { open } from "@tauri-apps/plugin-dialog";
import { RcReceiveDirectorySetting } from "./RcReceiveDirectorySetting";
import { RcSettingsChoiceTags } from "./RcSettingsChoiceTags";

vi.mock("@/lib/api/rcFile", () => ({
  rcFileDefaultDir: vi.fn(),
  rcFileReceiveDirSet: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("接收目录状态与恢复", () => {
  it("读取失败有重试入口，重试成功后显示真实目录", async () => {
    vi.mocked(rcFileDefaultDir).mockRejectedValueOnce("unavailable").mockResolvedValueOnce("D:/Received");
    render(<RcReceiveDirectorySetting toast={vi.fn()} />);
    expect(await screen.findByText("接收目录读取失败")).not.toBeNull();
    expect(screen.queryByText("读取中…")).toBeNull();
    expect((screen.getByRole("button", { name: "打开" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("D:/Received")).not.toBeNull();
    expect((screen.getByRole("button", { name: "打开" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("目录选择器失败有可见错误并恢复按钮", async () => {
    vi.mocked(rcFileDefaultDir).mockResolvedValue("D:/Received");
    vi.mocked(open).mockRejectedValue("dialog unavailable");
    const toast = vi.fn();
    render(<RcReceiveDirectorySetting toast={toast} />);
    await screen.findByText("D:/Received");
    fireEvent.click(screen.getByRole("button", { name: "更改" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("无法更改接收目录：dialog unavailable", "error"));
    expect((screen.getByRole("button", { name: "更改" }) as HTMLButtonElement).disabled).toBe(false);
    expect(rcFileReceiveDirSet).not.toHaveBeenCalled();
  });

  it("选择目录期间禁用按钮，取消后保留原目录", async () => {
    vi.mocked(rcFileDefaultDir).mockResolvedValue("D:/Received");
    let finish!: (value: null) => void;
    vi.mocked(open).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<RcReceiveDirectorySetting toast={vi.fn()} />);
    await screen.findByText("D:/Received");
    fireEvent.click(screen.getByRole("button", { name: "更改" }));
    expect((screen.getByRole("button", { name: "更改中…" }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    finish(null);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "更改" }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.getByText("D:/Received")).not.toBeNull();
    expect(rcFileReceiveDirSet).not.toHaveBeenCalled();
  });

  it("保存失败保留原目录，下次可以继续修改", async () => {
    vi.mocked(rcFileDefaultDir).mockResolvedValue("D:/Received");
    vi.mocked(open).mockResolvedValue("D:/Other");
    vi.mocked(rcFileReceiveDirSet).mockRejectedValue("permission denied");
    const toast = vi.fn();
    render(<RcReceiveDirectorySetting toast={toast} />);
    await screen.findByText("D:/Received");
    fireEvent.click(screen.getByRole("button", { name: "更改" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("无法更改接收目录：permission denied", "error"));
    expect(screen.getByText("D:/Received")).not.toBeNull();
    expect((screen.getByRole("button", { name: "更改" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

it("连接方式分组有可访问组名与选中状态", () => {
  const onPick = vi.fn();
  render(
    <RcSettingsChoiceTags
      label="默认发起方式"
      value="view"
      options={[
        { key: "view", label: "只看" },
        { key: "control", label: "可控" },
      ]}
      onPick={onPick}
    />,
  );
  expect(screen.getByRole("group", { name: "默认发起方式" })).not.toBeNull();
  expect(screen.getByRole("button", { name: "只看" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "可控" }).getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "可控" }));
  expect(onPick).toHaveBeenCalledWith("control");
});
