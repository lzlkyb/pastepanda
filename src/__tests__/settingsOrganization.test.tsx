import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { DEFAULT_CONFIG } from "@/stores/appStore";
import { AppearanceSection } from "@/components/settings/sections/AppearanceSection";
import { CopyPasteSection } from "@/components/settings/sections/CopyPasteSection";
import { CaptureSection } from "@/components/settings/sections/CaptureSection";
import { WindowEditorSection } from "@/components/settings/sections/WindowEditorSection";
import { HotkeySection } from "@/components/settings/sections/HotkeySection";
import { settingsNavItems } from "@/components/settings/sections/meta";
import { useSettingsSearch } from "@/hooks/useSettingsSearch";
import styles from "@/components/Settings.module.css";

vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/HelpTooltip", () => ({ HelpTooltip: () => null }));
vi.mock("@/components/settings/NoteTemplateRows", () => ({ NoteTemplateRows: () => null }));
vi.mock("@/components/settings/KbAutoDepositRows", () => ({ KbAutoDepositRows: () => null }));

const save = vi.fn().mockResolvedValue(true);
const props = { config: DEFAULT_CONFIG, updateAndSave: save };
beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);

function Harness() {
  const search = useSettingsSearch();
  return <>
    <input aria-label="搜索" value={search.filter} onChange={e => search.setFilter(e.target.value)} />
    <div ref={search.containerRef}>
      <AppearanceSection {...props} tabStyle="segmented" handleSwitchTabStyle={vi.fn()} />
      <CopyPasteSection {...props} />
      <WindowEditorSection {...props} mdAssoc="unsupported" mdAssocBusy={false}
        handleMdAssocToggle={vi.fn()} refreshMdAssoc={vi.fn()} />
      <HotkeySection {...props} />
      <CaptureSection {...props} chains={[]} />
    </div>
  </>;
}

/** 用户应能按功能找到设置；断言真实设置行所在的最近一级标题。 */
function owner(container: HTMLElement, label: string) {
  const row = [...container.querySelectorAll<HTMLElement>(`.${styles.sRow}`)]
    .find(el => el.querySelector(`.${styles.sRowLabel}`)?.firstChild?.textContent?.trim() === label);
  expect(row, label).toBeDefined();
  for (let el = row?.previousElementSibling; el; el = el.previousElementSibling) {
    if (el.classList.contains(styles.sSection) && !el.hasAttribute("data-settings-parent")) {
      return el.textContent;
    }
  }
}

describe("设置分类方案 B", () => {
  it("导航按四组功能排序，保持 13 个可读入口", () => {
    expect(settingsNavItems(false).map(n => n.label)).toEqual([
      "外观与窗口", "快捷键", "剪贴板", "笔记与编辑", "截图与录屏", "待办灵动岛",
      "设备与连接", "AI 设置", "工具接入", "数据管理", "使用统计", "帮助", "关于",
    ]);
    expect([...new Set(settingsNavItems(false).map(n => n.group))]).toEqual([
      "基础设置", "功能设置", "连接与扩展", "数据与支持",
    ]);
  });

  it("窗口、笔记、粘贴和录屏各归其类，快捷键统一管理", () => {
    const { container } = render(<Harness />);
    for (const label of ["窗口置顶", "开机自启"]) expect(owner(container, label)).toBe("外观与窗口");
    expect(owner(container, "编辑器自动保存")).toBe("笔记与编辑");
    for (const label of ["卡片悬浮行为", "双击列表行为", "快捷粘贴布局", "栈容量"]) {
      expect(owner(container, label)).toBe("剪贴板");
    }
    for (const label of ["默认画质档", "截图后执行动作链"]) expect(owner(container, label)).toBe("截图与录屏");
    for (const label of ["录屏热键", "录制中：暂停 / 继续", "录制中：停止并保存", "录制中：标记时刻"]) {
      expect(owner(container, label)).toBe("快捷键");
    }
    expect(container.querySelectorAll(`[class*="${styles.sRowLabel}"]`).length).toBeGreaterThan(30);
  });

  it.each(["剪贴板", "复制与粘贴"])("搜索 %s 能展开含粘贴栈在内的完整分类", query => {
    const { container, getByLabelText } = render(<Harness />);
    fireEvent.change(getByLabelText("搜索"), { target: { value: query } });
    const row = [...container.querySelectorAll<HTMLElement>(`.${styles.sRow}`)]
      .find(el => el.querySelector(`.${styles.sRowLabel}`)?.textContent === "栈容量");
    expect(row).toBeDefined();
    expect(row?.style.display).toBe("");
    const unrelated = [...container.querySelectorAll<HTMLElement>(`.${styles.sRow}`)]
      .find(el => el.querySelector(`.${styles.sRowLabel}`)?.textContent === "默认画质档");
    expect(unrelated?.style.display).toBe("none");
  });

  it("只命中末尾小节时，仍显示所属一级分类标题", () => {
    const { container, getByLabelText } = render(<Harness />);
    fireEvent.change(getByLabelText("搜索"), { target: { value: "栈容量" } });
    const head = [...container.querySelectorAll<HTMLElement>(`.${styles.sSection}`)]
      .find(el => el.textContent === "剪贴板");
    expect(head?.style.display).toBe("");
  });
});
