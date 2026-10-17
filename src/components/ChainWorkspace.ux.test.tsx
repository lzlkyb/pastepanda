import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChainRunnerDialog } from "./ChainRunnerDialog";
import { ChainEditor } from "./ChainEditor";
import { chainList } from "@/lib/api/chains";
import { TransformHubDialog } from "./TransformHubDialog";
import { anyDialogOpen, useDialogStore } from "@/stores/dialogStore";
import type { HistoryItem } from "@/stores/appStore";
import { setAiAvailable } from "@/lib/transforms/aiTransforms";
vi.mock("@/lib/api/chains", () => ({ chainList: vi.fn(async () => []), chainSave: vi.fn(async () => "saved"), chainDelete: vi.fn() }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/SequenceDiscover", () => ({ SequenceDiscover: () => null }));
vi.mock("@/hooks/useActionEventLog", () => ({ useActionEventLog: () => vi.fn() }));
afterEach(() => { cleanup(); useDialogStore.getState().closeChainEditor(); useDialogStore.getState().closeChain(); useDialogStore.getState().closeHub(); setAiAvailable(false); vi.mocked(chainList).mockReset().mockResolvedValue([]); });
it("ordinary text starts with a choice instead of silently selecting a webpage chain", async () => {
  useDialogStore.getState().openChain("普通问题描述");
  await act(async () => { render(<ChainRunnerDialog />); });
  expect(screen.getByText("你想得到什么结果？")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "运行整条链" })).toBeNull();
});
it("displays the steps before running", async () => {
  useDialogStore.getState().openChain("<p>hello</p>", "web-to-text");
  await act(async () => { render(<ChainRunnerDialog />); });
  expect(screen.getByText(/将依次执行 3 步/)).toBeTruthy();
  expect(screen.getByRole("button", { name: /运行这 3 步/ })).toBeTruthy();
});
it("only one visible dialog is active when opening a chain from the hub", async () => {
  useDialogStore.getState().openHub({ id: "x", type: "text", content_type: "text", text: "普通问题描述", source: "", tags: [] } as unknown as HistoryItem);
  useDialogStore.getState().openChain("普通问题描述");
  await act(async () => { render(<><TransformHubDialog /><ChainRunnerDialog /></>); });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});
it("AI entry first asks for a goal without sending content", async () => {
  setAiAvailable(true);
  useDialogStore.getState().openChain("普通问题描述");
  await act(async () => { render(<ChainRunnerDialog />); });
  fireEvent.click(screen.getByRole("tab", { name: "让 AI 设计流程" }));
  expect(screen.getByRole("textbox", { name: "希望得到什么结果？" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "生成步骤并发送" }) as HTMLButtonElement).disabled).toBe(true);
});
it("an empty-input workspace still blocks global list keyboard shortcuts", () => {
  useDialogStore.getState().openChain("");
  expect(anyDialogOpen(useDialogStore.getState())).toBe(true);
});
async function createFlow() {
  fireEvent.click(screen.getByRole("button", { name: /自己组合步骤/ }));
  fireEvent.change(screen.getByRole("textbox", { name: /流程名称/ }), { target: { value: "我的新流程" } });
  fireEvent.click(screen.getByRole("button", { name: /添加步骤/ }));
  fireEvent.change(screen.getByRole("combobox", { name: "第 1 步操作" }), { target: { value: "strip" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "保存并查看流程" })); });
}
it("a late old list cannot erase a newly saved flow", async () => {
  let finish!: (value: never[]) => void;
  vi.mocked(chainList).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  useDialogStore.getState().openChain(" text ");
  await act(async () => { render(<><ChainRunnerDialog /><ChainEditor /></>); });
  await createFlow();
  await act(async () => { finish([]); });
  expect(screen.getByRole("button", { name: "运行这 1 步" })).toBeTruthy();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});
it("returning from the editor retains the current draft", async () => {
  useDialogStore.getState().openChain(" text ", "web-to-text");
  await act(async () => { render(<><ChainRunnerDialog /><ChainEditor /></>); });
  fireEvent.click(screen.getByRole("button", { name: "调整步骤" }));
  fireEvent.change(screen.getByRole("textbox", { name: /流程名称/ }), { target: { value: "保留的草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "返回" }));
  fireEvent.click(screen.getByRole("button", { name: "调整步骤" }));
  expect((screen.getByRole("textbox", { name: /流程名称/ }) as HTMLInputElement).value).toBe("保留的草稿");
});
it("switching AI off while the goal form is open removes its entry and form", async () => {
  setAiAvailable(true);
  useDialogStore.getState().openChain("text", undefined, undefined, "ai");
  await act(async () => { render(<ChainRunnerDialog />); });
  expect(screen.getByRole("textbox", { name: "希望得到什么结果？" })).toBeTruthy();
  act(() => setAiAvailable(false));
  expect(screen.queryByRole("tab", { name: "让 AI 设计流程" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "希望得到什么结果？" })).toBeNull();
});
it("saved list loading failures stay visible beside a retry action", async () => {
  vi.mocked(chainList).mockRejectedValueOnce(new Error("db busy"));
  useDialogStore.getState().openChain("text");
  await act(async () => { render(<ChainRunnerDialog />); });
  expect(screen.getByRole("alert").textContent).toContain("无法读取");
  expect(screen.getByRole("button", { name: "重新加载我的流程" })).toBeTruthy();
});
it("a mismatched webpage flow explains its effect beside the fixed run button", async () => {
  useDialogStore.getState().openChain("普通文字", "web-to-text");
  await act(async () => { render(<ChainRunnerDialog />); });
  const footer = screen.getByRole("button", { name: "运行这 3 步" }).closest("footer");
  expect(footer?.textContent).toContain("可能不会改变内容");
});
