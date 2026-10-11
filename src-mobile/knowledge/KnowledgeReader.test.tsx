import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { copyToClipboard } from "@/lib/utils";
import { openUrl } from "@tauri-apps/plugin-opener";
import { KnowledgeReader } from "./KnowledgeReader";

vi.mock("@/lib/utils", () => ({ copyToClipboard: vi.fn(), knowledgeErrorText: () => "本机操作未能完成，请重试。" }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../ui/useMobileBack", () => ({ useMobileBack: vi.fn() }));
vi.mock("../ui/MobileSheet", () => ({ MobileSheet: ({ open, title, children, footer, onClose }: { open: boolean; title: string; children: ReactNode; footer: ReactNode; onClose: () => void }) => open ? <aside role="dialog" aria-label={title}><button onClick={onClose}>关闭面板</button>{children}{footer}</aside> : null }));
const note = { id: "n1", title: "手机阅读", content: "## 章节\n\n原始正文", updated_at: "2026-10-07T09:00:00Z", tags: [], deleted_at: null };
const metadata = { common: false, reading_position: .5, last_access_at: null };
let current: typeof note | null = note;
let failure: string | null = null;
beforeEach(() => {
  current = { ...note }; failure = null;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === failure) throw new Error("private-path/database.db");
    if (command === "note_get") return current;
    if (command === "mobile_knowledge_meta") return metadata;
    if (command === "mobile_knowledge_visit") return metadata;
    if (command === "mobile_knowledge_set_common") return { ...metadata, common: (args as { common: boolean }).common };
    if (command === "mobile_knowledge_list") return { items: [], has_more: false };
  });
  vi.mocked(copyToClipboard).mockResolvedValue(true);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("数据库失败区别于空/已删除，不暴露私有路径；重试可恢复", async () => {
  failure = "note_get";
  render(<KnowledgeReader noteId="n1" active onBack={vi.fn()} />);
  await screen.findByText("未能读取笔记");
  expect(screen.queryByText(/已不在本机/)).toBeNull();
  expect(document.body.textContent).not.toContain("database.db");
  failure = null;
  fireEvent.click(screen.getByRole("button", { name: "重试读取" }));
  await screen.findByRole("heading", { name: "手机阅读" });
});
it("读取null明确本机不存在，不宣称电脑端已删除", async () => {
  current = null;
  render(<KnowledgeReader noteId="n1" active onBack={vi.fn()} />);
  await screen.findByText("这篇笔记已不在本机知识库中");
  expect(screen.getByText(/可能已删除或尚未同步/)).toBeTruthy();
});
it("正文复制的成功失败在触发操作面板可见，常用失败不改变状态", async () => {
  vi.mocked(copyToClipboard).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<KnowledgeReader noteId="n1" active onBack={vi.fn()} />);
  await screen.findByRole("heading", { name: "手机阅读" });
  fireEvent.click(screen.getByRole("button", { name: "更多" }));
  fireEvent.click(screen.getByRole("button", { name: "复制正文" }));
  await screen.findByText("未能复制正文");
  expect(screen.getByRole("dialog").textContent).toContain("未能复制正文");
  expect(copyToClipboard).toHaveBeenCalledWith(note.content);
  fireEvent.click(screen.getByRole("button", { name: "复制正文" }));
  await screen.findByText("已复制正文");
  fireEvent.click(screen.getByRole("button", { name: "关闭面板" }));
  failure = "mobile_knowledge_set_common";
  fireEvent.click(screen.getByRole("button", { name: "加入手机常用" }));
  await screen.findByText("未能更新常用");
  expect(screen.getByRole("button", { name: "加入手机常用" }).getAttribute("aria-pressed")).toBe("false");
});
it("后台重新读取只提示新版，用户选择之后才替换阅读正文", async () => {
  render(<KnowledgeReader noteId="n1" active onBack={vi.fn()} />);
  await screen.findByText("原始正文");
  current = { ...note, content: "新的正文", updated_at: "2026-10-07T10:00:00Z" };
  act(() => window.dispatchEvent(new Event("focus")));
  await screen.findByText("本机正文已更新");
  expect(screen.getByText("原始正文")).toBeTruthy();
  expect(screen.queryByText("新的正文")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "载入新版" }));
  await screen.findByText("新的正文");
});
it("恢复阅读比例，退出保存最后位置而不是恢复位置", async () => {
  const { container, unmount } = render(<KnowledgeReader noteId="n1" active onBack={vi.fn()} />);
  const scroll = container.querySelector('[class*="scroll"]') as HTMLElement;
  Object.defineProperties(scroll, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 200, configurable: true } });
  await screen.findByText("原始正文");
  expect(scroll.scrollTop).toBe(400);
  scroll.scrollTop = 600; fireEvent.scroll(scroll);
  unmount();
  expect(invoke).toHaveBeenCalledWith("mobile_knowledge_visit", { id: "n1", readingPosition: .75 });
});
it("file和javascript链接不调用系统浏览器，https必须明确点击打开", async () => {
  current = { ...note, content: "[本机](file:///private/a)\n\n[网页](https://example.test/)" };
  render(<KnowledgeReader noteId="n1" active onBack={vi.fn()} />);
  await screen.findByText("网页");
  fireEvent.click(screen.getByText("本机"));
  await screen.findByText("这个链接无法在手机上打开");
  expect(openUrl).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "关闭面板" }));
  fireEvent.click(screen.getByText("网页"));
  expect(openUrl).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "在浏览器中打开" }));
  await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://example.test/"));
});
it("同名双链显示候选让用户选择，不自动跳到第一篇", async () => {
  current = { ...note, content: "[[同名]]" };
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => command === "mobile_knowledge_list" ? {
    items: [{ id: "one", title: "同名", excerpt: "版本一" }, { id: "two", title: "同名", excerpt: "版本二" }], has_more: false,
  } : original(command, args));
  const open = vi.fn();
  render(<KnowledgeReader noteId="n1" active onBack={vi.fn()} onOpenNote={open} />);
  fireEvent.click(await screen.findByRole("link", { name: "同名" }));
  await screen.findByText("有多篇同名笔记，请选择");
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /同名.*版本二/ }));
  expect(open).toHaveBeenCalledWith("two");
});
it("本机失效双链不误断言远端已删除", async () => {
  current = { ...note, content: "[[尚未同步]]" };
  const open = vi.fn();
  render(<KnowledgeReader noteId="n1" active onBack={vi.fn()} onOpenNote={open} />);
  fireEvent.click(await screen.findByRole("link", { name: "尚未同步" }));
  await screen.findByText("本机没有找到这篇笔记");
  expect(screen.getByText(/可能还未同步，也可能已改名/)).toBeTruthy();
  expect(open).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledWith("mobile_knowledge_list", { options: { exact_title: "尚未同步", view: "all" } });
});
it("含凭据的外部图片地址不交给系统浏览器", async () => {
  current = { ...note, content: "![带凭据](https://user:secret@example.test/image.png)" };
  render(<KnowledgeReader noteId="n1" active onBack={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "打开外部图片" }));
  await screen.findByText("这个链接无法在手机上打开");
  expect(openUrl).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "在浏览器中打开" })).toBeNull();
});
it("元数据加载失败仍阅读正文且不能误改未知常用状态", async () => {
  failure = "mobile_knowledge_meta";
  render(<KnowledgeReader noteId="n1" active onBack={vi.fn()} />);
  await screen.findByText("原始正文");
  expect(screen.getByText("阅读偏好未能加载")).toBeTruthy();
  expect(screen.getByRole("button", { name: "加入手机常用" }).hasAttribute("disabled")).toBe(true);
  failure = null;
  fireEvent.click(screen.getByRole("button", { name: "重试偏好" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "加入手机常用" }).hasAttribute("disabled")).toBe(false));
});

it("阅读工具集中在页头，常用反馈同层可见且正文保留", async () => {
  const { container } = render(<KnowledgeReader noteId="n1" active onBack={vi.fn()} />);
  await screen.findByText("原始正文");
  const common = screen.getByRole("button", { name: "加入手机常用" });
  expect(common.closest("header")).not.toBeNull();
  expect(screen.getByRole("button", { name: "目录" }).closest("header")).not.toBeNull();
  expect(container.querySelector("footer")).toBeNull();
  fireEvent.click(common);
  await screen.findByText("已加入手机常用");
  expect(screen.getByText("原始正文")).toBeTruthy();
  expect(screen.getByRole("button", { name: "手机常用" }).textContent).toBe("已常用");
});
