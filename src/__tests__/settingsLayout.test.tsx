import type { ReactNode } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DEFAULT_CONFIG } from "@/stores/appStore";
import { SettingsView } from "@/components/SettingsView";
import { settingsNavItems } from "@/components/settings/sections/meta";
import styles from "@/components/Settings.module.css";

vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/HelpTooltip", () => ({ HelpTooltip: () => null }));
vi.mock("@/hooks/useSettingsShell", () => ({ useSettingsShell: () => ({
  config: DEFAULT_CONFIG, updateConfig: vi.fn(), updateAndSave: vi.fn().mockResolvedValue(true),
  stats: null, statsError: true, expiredCount: 0, tabStyle: "segmented", saveState: "idle",
  appName: "PastePanda", appVersion: "7.2.11", hasAboutDot: false,
  showCleanupConfirm: false, showResetConfirm: false,
}) }));
vi.mock("@/hooks/useSettingsData", () => ({ useSettingsData: () => ({
  cleanupDays: 30, pendingCleanup: null, trashDays: 30, pendingTrash: null,
  showDeepClean: false, showWeekReport: false, srcOpen: false, loadedAt: "", chains: [], dash: null,
  mdAssoc: "unsupported", mdAssocBusy: false, handleMdAssocToggle: vi.fn(), refreshMdAssoc: vi.fn(),
}) }));
vi.mock("@/components/settings/sections/SyncSection", () => ({ SyncSection: () => <>
  <div className={styles.sSection}>设备与连接</div>
  <div data-settings-parent="设备与连接" className={styles.sSection}>剪贴板同步</div>
  <div className={styles.sRow}><div className={styles.sRowLabel}>同步设备</div></div>
</> }));
vi.mock("@/components/settings/NoteTemplateRows", () => ({ NoteTemplateRows: () => null }));
vi.mock("@/components/settings/AiTab", () => ({ AiTab: () => <div data-testid="ai">模型配置</div> }));
vi.mock("@/components/settings/McpTab", () => ({ McpTab: () => <div data-testid="mcp">接入配置</div> }));
vi.mock("@/components/settings/HelpTabContent", () => ({ HelpTabContent: () => <div>使用帮助内容</div> }));
vi.mock("@/components/settings/AboutTabContent", () => ({ AboutTabContent: () => <div>应用信息内容</div> }));
vi.mock("@/components/settings/LazyMount", () => ({ LazyMount: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/DeepCleanDialog", () => ({ DeepCleanDialog: () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
});
afterEach(cleanup);

it("实际设置页的 13 个标题与四组菜单顺序一致，AI / 接入在连接与数据之间", () => {
  const { container } = render(<SettingsView onClose={vi.fn()} />);
  const nav = screen.getByRole("navigation", { name: "设置分类" });
  const expected = settingsNavItems(false).map(n => n.label);
  expect(within(nav).getAllByRole("button")).toHaveLength(13);
  const headings = [...container.querySelectorAll(`.${styles.settingsContent} .${styles.sSection}`)]
    .map(el => el.textContent).filter(title => expected.includes(title as typeof expected[number]));
  expect(headings).toEqual(expected);
  expect([...nav.querySelectorAll(`.${styles.settingsNavGroup}`)].map(el => el.textContent))
    .toEqual(["基础设置", "功能设置", "连接与扩展", "数据与支持"]);
});

it("搜索仍排除独立配置页，点击工具接入清空关键词并恢复目标", () => {
  render(<SettingsView onClose={vi.fn()} />);
  const input = screen.getByPlaceholderText(/搜索设置/);
  fireEvent.change(input, { target: { value: "栈容量" } });
  expect(screen.queryByTestId("ai")).toBeNull();
  expect(screen.queryByTestId("mcp")).toBeNull();
  const nav = screen.getByRole("navigation", { name: "设置分类" });
  fireEvent.click(within(nav).getByRole("button", { name: /工具接入/ }));
  expect((input as HTMLInputElement).value).toBe("");
  expect(screen.getByTestId("mcp")).toBeDefined();
  expect(within(nav).getByRole("button", { name: /工具接入/ }).className)
    .toContain(styles.settingsNavItemActive);
});
