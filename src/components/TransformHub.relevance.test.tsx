import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TransformHubDialog } from "./TransformHubDialog";
import { useDialogStore } from "@/stores/dialogStore";
import { parseNlCommand } from "@/lib/nlActionParser";
import type { HistoryItem } from "@/stores/appStore";
import { setAiAvailable } from "@/lib/transforms/aiTransforms";
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/useActionEventLog", () => ({ useActionEventLog: () => vi.fn() }));
vi.mock("@/components/editors/CodecEditor", () => ({ CodecEditor: () => <div>编解码内容</div> }));
vi.mock("@/components/editors/QREditor", () => ({ QREditor: () => <div>二维码内容</div> }));
vi.mock("@/components/transform/TransformCard", async () => {
  const { useState } = await import("react");
  return { TransformCard: function MockCard({ t }: { t: { label: string; id: string } }) {
    const [draft, setDraft] = useState("");
    return <div>{t.label}<input aria-label={`draft-${t.id}`} value={draft} onChange={e => setDraft(e.target.value)} /></div>;
  } };
});
vi.mock("@/components/NlCommandBar", () => ({ NlCommandBar: ({ onResult }: { onResult: (value: ReturnType<typeof parseNlCommand>) => void }) => <button onClick={() => onResult(parseNlCommand("生成二维码"))}>查找二维码</button> }));
beforeEach(() => useDialogStore.getState().openHub({ id: "hub", text: "普通段落", type: "text", content_type: "text", source: "", tags: [] } as unknown as HistoryItem));
afterEach(() => { cleanup(); useDialogStore.getState().closeHub(); setAiAvailable(false); });
it("does not keep workbench promotion buttons above recommendations", () => {
  render(<TransformHubDialog />);
  expect(screen.queryByRole("button", { name: /二维码工作台/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /编解码工作台/ })).toBeNull();
});
it("all transformations preserve manual access to QR", async () => {
  render(<TransformHubDialog />);
  fireEvent.click(screen.getByRole("button", { name: /查看全部变换/ }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /二维码工作台/ })); });
  expect(screen.getByText("二维码内容")).toBeTruthy();
});
it("explicit QR intent opens the existing workbench", async () => {
  render(<TransformHubDialog />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "查找二维码" })); });
  expect(screen.getByText("二维码内容")).toBeTruthy();
});
it("manual lookup can reveal a conversion omitted by automatic recommendations", () => {
  render(<TransformHubDialog />);
  expect(screen.queryByText("SQL IN（分隔值）")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /查看全部变换/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "查找全部变换" }), { target: { value: "SQL IN（分隔值）" } });
  fireEvent.click(screen.getByRole("button", { name: "SQL IN（分隔值）" }));
  expect(screen.getByText("你指定的操作")).toBeTruthy();
  expect(screen.getByText("SQL IN（分隔值）")).toBeTruthy();
});
it("AI disabled hides AI chain entry", () => {
  setAiAvailable(false);
  render(<TransformHubDialog />);
  // 查询名必须与真实按钮一致：曾是 /AI 编链/，而 UI 文案是「让 AI 设计流程」，
  // 那条断言恒为 null 恒通过（假绿），守护不了门控。改文案时同步这里。
  expect(screen.queryByRole("button", { name: /让 AI 设计流程/ })).toBeNull();
});
it("AI enabled shows the AI chain entry", () => {
  setAiAvailable(true);
  render(<TransformHubDialog />);
  expect(screen.getByRole("button", { name: /让 AI 设计流程/ })).toBeTruthy();
});
it("selecting an already visible action preserves its mounted result", () => {
  useDialogStore.getState().openHub({ id: "base64", text: "SGVsbG8sIFBhc3RlUGFuZGEh", type: "text", content_type: "text", source: "", tags: [] } as unknown as HistoryItem);
  render(<TransformHubDialog />);
  const draft = screen.getByRole("textbox", { name: "draft-base64_decode" });
  fireEvent.change(draft, { target: { value: "keep result" } });
  fireEvent.click(screen.getByRole("button", { name: /查看全部变换/ }));
  fireEvent.click(screen.getByRole("button", { name: "Base64 解码" }));
  expect((screen.getByRole("textbox", { name: "draft-base64_decode" }) as HTMLInputElement).value).toBe("keep result");
});
