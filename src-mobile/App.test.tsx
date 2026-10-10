import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { MobileSheet } from "./ui/MobileSheet";

const state = vi.hoisted(() => ({ update: false, targetsError: null as string | null, fileError: null as string | null, error: null as string | null, session: null as null | { id: string; phase: string; capability: string; peer_name: string }, pending: [] as { peer: string; first_seen_ms: number }[] }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); state.session = null; state.pending = []; state.error = null; state.targetsError = null; state.fileError = null; state.update = false; rcMocks.cancel.mockClear(); });
const rcMocks = vi.hoisted(() => ({ cancel: vi.fn() }));
const inboxState = vi.hoisted(() => ({ items: [] as { id: string }[], openRequestId: undefined as string | undefined }));
vi.mock("./knowledge/useKnowledgeInbox", () => ({ useKnowledgeInbox: () => inboxState }));
afterEach(() => { inboxState.items = []; inboxState.openRequestId = undefined; });
vi.mock("@/hooks/useRc", () => ({ useRc: () => ({ status: { pending: state.pending }, error: state.error, targetsError: state.targetsError, busy: false, cancel: rcMocks.cancel, clearError: vi.fn() }) }));
vi.mock("@/hooks/useRcFile", () => ({ useRcFile: () => ({ asks: [], error: state.fileError }) }));
vi.mock("@/stores/rcStore", () => ({ useRcStore: (select: (s: unknown) => unknown) => select({ status: { session: state.session } }) }));
vi.mock("./ui/useMobileAppearance", () => ({ useMobileAppearance: () => ({ appearance: "system", setAppearance: () => {} }) }));
vi.mock("./ui/MobileUpdate", () => ({ MobileUpdateProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("./ui/MobileUpdateBanner", () => ({ MobileUpdateBanner: () => state.update ? <div>更新提示</div> : null }));
vi.mock("./devices/RcDevicesView", () => ({ RcDevicesView: function DevicePage({ onErrorScopeChange, onSendFiles, pageNotice }: { onErrorScopeChange: (owned: boolean) => void; onSendFiles: (peer: string) => void; pageNotice?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <>
    {pageNotice}
    <p>设备内容</p><button onClick={() => onErrorScopeChange(true)}>打开设备面板</button><button onClick={() => onErrorScopeChange(false)}>关闭设备面板</button>
    <button onClick={() => setOpen(true)}>测试设备操作</button>
    <MobileSheet open={open} title="设备操作" onClose={() => setOpen(false)}>
      <button onClick={() => { onSendFiles("test-computer"); setOpen(false); }}>传文件</button>
    </MobileSheet>
  </>;
} }));
vi.mock("./settings/RcSettingsView", () => ({ RcSettingsView: ({ pageNotice }: { pageNotice?: React.ReactNode }) => <>{pageNotice}<p>设置内容</p></> }));
vi.mock("./knowledge/KnowledgeView", () => ({ KnowledgeView: function KnowledgePage({ onTaskChange }: { onTaskChange?: (focused: boolean) => void }) {
  const [draft, setDraft] = useState("");
  return <><p>知识库内容</p><button onClick={() => onTaskChange?.(true)}>进入阅读任务</button><button onClick={() => onTaskChange?.(false)}>返回知识库列表</button><input aria-label="知识库草稿" value={draft} onChange={event => setDraft(event.target.value)} /></>;
} }));
vi.mock("./session/RcMobileSession", () => ({ RcMobileSession: () => <p>远控内容</p> }));
vi.mock("./devices/RcFilesView", () => ({ RcFilesView: function FilePage({ initialPeer, onStatus, pageNotice }: { initialPeer: string | null; onStatus?: (text: string | null, error?: boolean) => void; pageNotice?: React.ReactNode }) {
  const [draft, setDraft] = useState(0);
  return <>{pageNotice}<button onClick={() => setDraft(draft + 1)}>上传状态 {draft}</button>
    <button onClick={() => onStatus?.(`准备完成 ${draft + 1} 个文件，等对方确认后开始传输。`)}>上报准备状态</button>
    <button onClick={() => onStatus?.("发送失败（示例）", true)}>上报发送失败</button>
    <p>{initialPeer}</p></>;
} }));

it("文件状态切页与进入远控期间保留，隐藏页不能触发操作", () => {
  const view = render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "文件" }));
  fireEvent.click(screen.getByRole("button", { name: "上传状态 0" }));
  fireEvent.click(screen.getByRole("button", { name: "设备" }));
  expect(screen.queryByRole("button", { name: "上传状态 1" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "文件" }));
  expect(screen.getByRole("button", { name: "上传状态 1" })).toBeTruthy();
  state.session = { id: "session", phase: "outbound_active", capability: "control", peer_name: "电脑" };
  view.rerender(<App />);
  expect(screen.getByText("远控内容")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "上传状态 1" })).toBeNull();
  state.session = null; view.rerender(<App />);
  expect(screen.getByRole("button", { name: "上传状态 1" })).toBeTruthy();
});

it("知识库是第四个目的地，切页或进入远控不会卸载草稿", () => {
  const view = render(<App />);
  fireEvent.click(screen.getByRole("button", { name: /^知识库$/ }));
  fireEvent.change(screen.getByLabelText("知识库草稿"), { target: { value: "正在记录" } });
  fireEvent.click(screen.getByRole("button", { name: /^文件$/ }));
  expect(screen.queryByLabelText("知识库草稿")).not.toBeNull();
  expect(screen.queryByRole("region", { name: "知识库" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^知识库$/ }));
  expect((screen.getByLabelText("知识库草稿") as HTMLInputElement).value).toBe("正在记录");
  state.session = { id: "remote", phase: "outbound_active", capability: "control", peer_name: "电脑" };
  view.rerender(<App />); expect(screen.queryByRole("region", { name: "知识库" })).toBeNull();
  state.session = null; view.rerender(<App />);
  expect((screen.getByLabelText("知识库草稿") as HTMLInputElement).value).toBe("正在记录");
});

it("后台连接请求只更新目的地角标，不挤占内容或抢页面", () => {
  const view = render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  state.pending = [{ peer: "pc", first_seen_ms: 1 }];
  view.rerender(<App />);
  expect(screen.getByRole("region", { name: "设置" })).toBeTruthy();
  expect(screen.getByLabelText("1 个待处理请求")).toBeTruthy();
  expect(screen.queryByText("有 1 个连接请求待处理")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "文件" }));
  expect(screen.getByRole("button", { name: "上传状态 0" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  expect(screen.getByText("设置内容")).toBeTruthy();
  state.pending = [...state.pending];
  view.rerender(<App />);
  expect(screen.getByText("设置内容")).toBeTruthy();
  state.pending = [{ peer: "pc", first_seen_ms: 2 }];
  view.rerender(<App />);
  expect(screen.getByRole("region", { name: "设置" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "设备" }));
  expect(screen.getByRole("region", { name: "设备" })).toBeTruthy();
  expect(screen.queryByText("有 1 个连接请求待处理")).toBeNull();
});

it("真实相邻页保持单一实例、独立滚动；隐藏页面不可访问", () => {
  render(<App />);
  const devices = screen.getByRole("region", { name: "设备" });
  const allPages = document.querySelectorAll("main > div > section");
  expect(allPages).toHaveLength(4);
  devices.scrollTop = 240;
  fireEvent.scroll(devices);
  fireEvent.click(screen.getByRole("button", { name: "文件" }));
  const files = screen.getByRole("region", { name: "文件" });
  files.scrollTop = 360;
  expect(devices.hasAttribute("inert")).toBe(true);
  expect(screen.queryByRole("region", { name: "设备" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "设备" }));
  expect(screen.getByRole("region", { name: "设备" })).toBe(devices);
  expect(devices.scrollTop).toBe(240);
  fireEvent.click(screen.getByRole("button", { name: "文件" }));
  expect(screen.getByRole("region", { name: "文件" })).toBe(files);
  expect(files.scrollTop).toBe(360);
});

it("真实弹层内传文件等背景解锁后进入文件页并保留目标电脑", async () => {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "测试设备操作" }));
  expect(screen.getByRole("dialog", { name: "设备操作" })).toBeTruthy();
  expect(document.body.dataset.mobileSheets).toBe("1");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "传文件" }));
    await Promise.resolve();
  });
  expect(screen.queryByRole("dialog", { name: "设备操作" })).toBeNull();
  expect(screen.getByRole("region", { name: "文件" })).toBeTruthy();
  expect(screen.getByText("test-computer")).toBeTruthy();
  expect(document.body.dataset.mobileSheets).toBeUndefined();
});

it("设备面板认领错误后页面不重复显示，关闭后错误仍可处理", () => {
  state.error = "连接未能完成，请重试";
  render(<App />);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "打开设备面板" }));
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "关闭设备面板" }));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
});

it("同一后台故障由设备反馈承载，不再叠加页面和文件提示", () => {
  state.error = "invoke failed"; state.targetsError = "tauri_internal unavailable"; state.fileError = "invoke failed";
  render(<App />);
  // Device view is mocked; its own retry notice owns this cause.
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "查看" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "查看" })).toBeNull();
});

it("文件和更新提示共用一个布局容器，避免两条浮层占据相同位置", () => {
  state.fileError = "电脑未能接收文件"; state.update = true;
  render(<App />);
  expect(screen.getByRole("alert").parentElement).toBe(screen.getByText("更新提示").parentElement);
  expect(screen.getByRole("button", { name: "查看" })).toBeTruthy();
});

it("连接等待中在其他页也能取消，不用先回设备页", () => {
  state.session = { id: "s", phase: "outbound_pending", capability: "control", peer_name: "电脑" };
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  fireEvent.click(screen.getByRole("button", { name: "取消连接" }));
  expect(rcMocks.cancel).toHaveBeenCalledTimes(1);
});

it("跨页的文件准备状态可关闭，发送失败与待确认请求不给关闭入口", () => {
  const view = render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "文件" }));
  fireEvent.click(screen.getByRole("button", { name: "上报准备状态" }));
  fireEvent.click(screen.getByRole("button", { name: "设备" }));
  const notice = screen.getByText(/准备完成 1 个文件/).closest("section") as HTMLElement;
  expect(notice.querySelector('[aria-label="关闭提示"]')).toBeTruthy();
  fireEvent.click(notice.querySelector('[aria-label="关闭提示"]') as HTMLElement);
  expect(screen.queryByText(/准备完成 1 个文件/)).toBeNull();
  // 失败与待确认：只有「查看」，没有跨页关闭入口
  fireEvent.click(screen.getByRole("button", { name: "文件" }));
  fireEvent.click(screen.getByRole("button", { name: "上报发送失败" }));
  fireEvent.click(screen.getByRole("button", { name: "设备" }));
  const failNotice = screen.getByText("发送失败（示例）").closest("section") as HTMLElement;
  expect(failNotice.querySelector('[aria-label="关闭提示"]')).toBeNull();
  expect(failNotice.getAttribute("data-tone")).toBe("error");
  view.unmount();
});
it("内容横滑和滚动不会改变主导航，只有点击目的地才切页", () => {
  render(<App />);
  const pager = document.querySelector("main > div") as HTMLElement;
  pager.scrollLeft = 400;
  fireEvent.scroll(pager);
  fireEvent(pager, new Event("scrollend"));
  fireEvent.touchStart(pager, { touches: [{ clientX: 300, clientY: 180 }] });
  fireEvent.touchEnd(pager, { changedTouches: [{ clientX: 40, clientY: 180 }] });
  expect(screen.getByRole("region", { name: "设备" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "文件" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "文件" }));
  const files = screen.getByRole("region", { name: "文件" });
  expect(files.hasAttribute("inert")).toBe(false);
  expect(screen.queryByRole("region", { name: "设备" })).toBeNull();
  expect(screen.getByRole("button", { name: /^文件$/ }).getAttribute("aria-current")).toBe("page");
  const send = screen.getByRole("button", { name: "上传状态 0" });
  fireEvent.pointerDown(send);
  fireEvent.click(send);
  expect(screen.getByRole("button", { name: "上传状态 1" })).toBeTruthy();
  files.scrollTop = 300;
  fireEvent.scroll(files);
  expect(screen.getByRole("region", { name: "文件" })).toBe(files);
  expect(screen.getByRole("button", { name: "文件" }).getAttribute("aria-current")).toBe("page");
});

it("迟到旧分享和清理最新条目不抢当前页面，仅显式分享意图可跳转", () => {
  const view = render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  inboxState.items = [{ id: "older" }, { id: "newer" }];
  view.rerender(<App />);
  expect(screen.getByRole("region", { name: "设置" })).toBeTruthy();
  expect(screen.getByLabelText("2 条待收集内容")).toBeTruthy();
  inboxState.items = [{ id: "older" }]; view.rerender(<App />);
  expect(screen.getByRole("region", { name: "设置" })).toBeTruthy();
  inboxState.openRequestId = "explicit-share"; view.rerender(<App />);
  expect(screen.getByRole("region", { name: "知识库" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "文件" }));
  inboxState.items = []; view.rerender(<App />);
  expect(screen.getByRole("region", { name: "文件" })).toBeTruthy();
});

it("内容任务隐藏主导航，返回恢复导航和原草稿，后台错误仍可见", () => {
  const view = render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "知识库" }));
  fireEvent.change(screen.getByLabelText("知识库草稿"), { target: { value: "保留输入" } });
  fireEvent.click(screen.getByRole("button", { name: "进入阅读任务" }));
  expect(screen.queryByRole("navigation", { name: "主要导航" })).toBeNull();
  state.fileError = "传输失败"; view.rerender(<App />);
  expect(screen.getByText("传输失败")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "返回知识库列表" }));
  expect(screen.getByRole("navigation", { name: "主要导航" })).toBeTruthy();
  expect((screen.getByLabelText("知识库草稿") as HTMLInputElement).value).toBe("保留输入");
});
