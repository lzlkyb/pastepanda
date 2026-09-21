/**
 * 全屏编辑器三个展示层组件的**结构与可见性守卫**。
 *
 * 为什么要有这个文件（而不是只靠 FullscreenEditor 的集成测试）：
 * 这三个组件是从 `FullscreenEditor.tsx`（原 1004 行）抽出来的，
 * 抽取时最容易犯的错不是逻辑错，而是
 *   ① **漏搬某个 class** —— `styles.xxx` 指向不存在的 key 只会得到 `undefined`，
 *      tsc 与 vitest 都发现不了，页面表现为「样式凭空消失」；
 *   ② **可见性条件漂移** —— 比如把「不适用就不出现」的按钮改成永远渲染，
 *      页面上多出一个点了没反应的按钮。
 *
 * 所以这里按 **「原 JSX 用到的类清单」逐类钉住**，而不只是断几个文案。
 * 类清单来自抽取时的对账结果（见 .workbuddy/memory/2026-09-21.md）。
 *
 * ⚠️ **类名断言必须带哈希后缀，或改用子串匹配**：
 *    jsdom 下 CSS Modules 把类名编译成 `_paneHeader_00f1f4`，
 *    `querySelector(".paneHeader")` **永远查不到**（实测首版 12 个断言全挂）。
 *    本文件统一用 `sel()` 做子串匹配 —— 它同时验证了
 *    「这个类真的被引用到了」，而这正是本文件要防的头号回归。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { EditorToolbar } from "@/components/editors/fullscreen/EditorToolbar";
import { EditorStatusBar, type CursorInfo } from "@/components/editors/fullscreen/EditorStatusBar";
import { PaneHeader, PreviewPaneHeader } from "@/components/editors/fullscreen/PaneHeader";
import type { SpecMode, ViewMode } from "@/components/editors/fullscreen/types";
import { Eye, PanelLeft, Columns2 } from "lucide-react";

afterEach(cleanup);

/** 类名子串匹配（绕开 CSS Modules 哈希后缀） */
const sel = (cls: string) => `[class*="${cls}"]`;
const q = (root: Element, cls: string) => root.querySelector(sel(cls));
const qa = (root: Element, cls: string) => root.querySelectorAll(sel(cls));
/** 判断元素是否带某个 module 类（`_xxx_hash` 形态） */
const hasCls = (el: Element, cls: string) => new RegExp(`_${cls}_\\w+`).test(el.className);

const MODES: SpecMode[] = [
  { key: "edit", title: "仅编辑", label: "编辑", Icon: PanelLeft },
  { key: "split", title: "分屏", label: "分屏", Icon: Columns2 },
  { key: "preview", title: "仅预览", label: "预览", Icon: Eye },
];

/** 工具栏默认 props：markdown 文件模式、三分屏、非全屏 */
function toolbarProps(over: Partial<React.ComponentProps<typeof EditorToolbar>> = {}) {
  return {
    icon: "MD",
    fileName: "周报.md",
    currentFilePath: "D:\\docs\\周报.md",
    isDirty: false,
    isSaving: false,
    onMinimize: vi.fn(),
    dynamicLanguage: false,
    languageName: null,
    onLanguageChange: vi.fn(),
    modes: MODES,
    viewMode: "split" as ViewMode,
    onViewModeChange: vi.fn(),
    showOutlineButton: true,
    showOutline: false,
    onToggleOutline: vi.fn(),
    isFullscreen: false,
    onFullscreenToggle: vi.fn(),
    onReload: vi.fn(),
    onOpen: vi.fn(),
    onSave: vi.fn(),
    onClose: vi.fn(),
    onFocusMode: vi.fn(),
    ...over,
  };
}

describe("EditorToolbar", () => {
  it("左侧渲染类型图标 + 文件名 + 目录（目录是文件名的兄弟节点）", () => {
    const { container } = render(<EditorToolbar {...toolbarProps()} />);
    const left = q(container, "toolbarLeft")!;

    expect(left).toBeTruthy();
    expect(q(left, "fileIcon")!.textContent).toBe("MD");
    expect(q(left, "fileName")!.textContent).toBe("周报.md");
    // 目录带 `— ` 前缀且与文件名**同行**（原实现的视觉基线，改成双行就是回归）
    expect(q(left, "filePath")!.textContent).toBe("— D:\\docs");
  });

  it("剪贴板内容模式（无路径）：⋯ 菜单里没有重载项，也不渲染目录", () => {
    const { container } = render(<EditorToolbar {...toolbarProps({ currentFilePath: null })} />);

    expect(q(container, "filePath")).toBeNull();
    // 「不适用就不出现」是本项目刻意取舍：摆一个点了没反应的按钮比不摆更坏。
    // 重载在 ⋯ 菜单里（P0-4 收编），所以要开菜单后查。
    fireEvent.click(screen.getByTitle("更多操作"));
    expect(screen.queryByText("从磁盘重新加载")).toBeNull();
    // 菜单本体仍要能打开（否则 ⋯ 自己就是死按钮）
    expect(screen.getByText("打开文件…")).toBeTruthy();
  });

  it("isDirty 才渲染未保存圆点", () => {
    const { container: c1 } = render(<EditorToolbar {...toolbarProps({ isDirty: false })} />);
    expect(q(c1, "unsavedDot")).toBeNull();
    cleanup();

    const { container: c2 } = render(<EditorToolbar {...toolbarProps({ isDirty: true })} />);
    expect(q(c2, "unsavedDot")).toBeTruthy();
  });

  it("脏点紧贴文件名（在路径之前）—— 反馈与所属同域（B1）", () => {
    // 原先脏点在路径之后，路径长时被推到很右边、跟文件名脱开。
    // 现在顺序固定为：文件名 → 脏点 → 路径。
    const { container } = render(<EditorToolbar {...toolbarProps({ isDirty: true })} />);
    const left = q(container, "toolbarLeft")!;
    const kids = Array.from(left.children);
    const iName = kids.findIndex((el) => hasCls(el, "fileName"));
    const iDot = kids.findIndex((el) => hasCls(el, "unsavedDot"));
    const iPath = kids.findIndex((el) => hasCls(el, "filePath"));

    expect(iName).toBeGreaterThanOrEqual(0);
    expect(iDot).toBe(iName + 1); // 紧邻文件名
    expect(iPath).toBe(iDot + 1); // 路径在脏点之后
  });

  it("markdown 才渲染大纲按钮；非 markdown 不出现", () => {
    const { container: c1 } = render(<EditorToolbar {...toolbarProps({ showOutlineButton: true })} />);
    expect(q(c1, "toolbarRight")!.querySelector('[title^="大纲"]')).toBeTruthy();
    cleanup();

    const { container: c2 } = render(<EditorToolbar {...toolbarProps({ showOutlineButton: false })} />);
    expect(c2.querySelector('[title^="大纲"]')).toBeNull();
  });

  it("大纲按钮激活时带 tbBtnActive", () => {
    const { container } = render(<EditorToolbar {...toolbarProps({ showOutline: true })} />);
    const btn = container.querySelector('[title^="大纲"]')!;
    expect(hasCls(btn, "tbBtnActive")).toBe(true);

    cleanup();
    const { container: c2 } = render(<EditorToolbar {...toolbarProps({ showOutline: false })} />);
    expect(hasCls(c2.querySelector('[title^="大纲"]')!, "tbBtnActive")).toBe(false);
  });

  it("视图模式 ≥2 时渲染分段控件（图标+常驻文字）并标出当前项；只有 1 个时整组不渲染", () => {
    const { container: c1 } = render(<EditorToolbar {...toolbarProps()} />);
    // 分段控件容器 + 3 个按钮
    expect(q(c1, "viewSeg")).toBeTruthy();
    const btns = c1.querySelectorAll('[title="仅编辑"], [title="分屏"], [title="仅预览"]');
    expect(btns.length).toBe(3);
    // 常驻文字（L2）：不能只靠图标和 title
    expect(c1.textContent).toContain("编辑");
    expect(c1.textContent).toContain("分屏");
    expect(c1.textContent).toContain("预览");
    // 当前项（split）带激活类，其余不带 —— 拆分前由 `.map` 内的条件 class 提供
    expect(hasCls(c1.querySelector('[title="分屏"]')!, "viewSegBtnOn")).toBe(true);
    expect(hasCls(c1.querySelector('[title="仅编辑"]')!, "viewSegBtnOn")).toBe(false);
    expect(hasCls(c1.querySelector('[title="仅预览"]')!, "viewSegBtnOn")).toBe(false);

    // 分隔符：模式组前 1 个（P0-4 收束后右区只此一处分隔线）
    expect(qa(c1, "tbSep").length).toBe(1);
    cleanup();

    const { container: c2 } = render(<EditorToolbar {...toolbarProps({ modes: [MODES[0]] })} />);
    expect(c2.querySelector('[title="仅编辑"]')).toBeNull();
    expect(q(c2, "viewSeg")).toBeNull();
    // 模式组消失后不留悬空分隔线
    expect(qa(c2, "tbSep").length).toBe(0);
  });

  it("⋯ 菜单（P0-4）：打开后含专注模式/重载/打开文件，外点与选中后关闭", () => {
    const props = toolbarProps();
    const { container } = render(<EditorToolbar {...props} />);

    // 收束前这些是常驻按钮；现在必须先开菜单才出现
    expect(screen.queryByText("打开文件…")).toBeNull();
    fireEvent.click(screen.getByTitle("更多操作"));

    // 专注模式是菜单首项，kbd 常驻（P1-3 / L5）
    expect(screen.getByText("专注模式")).toBeTruthy();
    expect(q(container, "menuItemKbd")!.textContent).toBe("Ctrl+Shift+F");
    expect(screen.getByText("从磁盘重新加载")).toBeTruthy();
    expect(screen.getByText("打开文件…")).toBeTruthy();
    // 全屏切换是高频操作（用户拍板方案 B），已回常驻、不再进菜单
    expect(screen.queryByText("放大到真全屏")).toBeNull();
    // 浮层卡类真的被引用（styles.X 指向不存在的类只有 undefined，tsc 查不出）
    expect(q(container, "menuPop")).toBeTruthy();

    // 选中后关闭并回调
    fireEvent.click(screen.getByText("打开文件…"));
    expect(props.onOpen).toHaveBeenCalled();
    expect(q(container, "menuPop")).toBeNull();

    fireEvent.click(screen.getByTitle("更多操作"));
    fireEvent.click(screen.getByText("专注模式"));
    expect(props.onFocusMode).toHaveBeenCalled();
  });

  it("⋯ 菜单：Esc 与外点关闭（不误触发回调）", () => {
    const props = toolbarProps();
    const { container } = render(<EditorToolbar {...props} />);
    fireEvent.click(screen.getByTitle("更多操作"));
    expect(q(container, "menuPop")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(q(container, "menuPop")).toBeNull();
    expect(props.onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle("更多操作"));
    fireEvent.pointerDown(document.body); // 菜单外按下
    expect(q(container, "menuPop")).toBeNull();
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("点击各按钮都回调到对应 handler（低频项经 ⋯ 菜单，高频项常驻）", () => {
    const props = toolbarProps();
    render(<EditorToolbar {...props} />);

    fireEvent.click(screen.getByTitle("更多操作"));
    fireEvent.click(screen.getByText("从磁盘重新加载"));
    expect(props.onReload).toHaveBeenCalled();

    fireEvent.click(screen.getByTitle("更多操作"));
    fireEvent.click(screen.getByText("打开文件…"));
    expect(props.onOpen).toHaveBeenCalled();

    fireEvent.click(screen.getByTitle("保存 Ctrl+S"));
    expect(props.onSave).toHaveBeenCalled();

    // 最小化与全屏切换常驻，直接点
    fireEvent.click(screen.getByTitle("最小化"));
    expect(props.onMinimize).toHaveBeenCalled();

    fireEvent.click(screen.getByTitle("放大到真全屏"));
    expect(props.onFullscreenToggle).toHaveBeenCalled();

    fireEvent.click(screen.getByTitle("关闭 Esc"));
    expect(props.onClose).toHaveBeenCalled();

    fireEvent.click(screen.getByTitle("仅预览"));
    expect(props.onViewModeChange).toHaveBeenCalledWith("preview");
  });

  it("全屏态：常驻全屏按钮变「缩回窗口」并带激活类", () => {
    const { container } = render(<EditorToolbar {...toolbarProps({ isFullscreen: true })} />);
    const btn = container.querySelector('[title="缩回窗口"]')!;
    expect(btn).toBeTruthy();
    expect(hasCls(btn, "tbBtnActive")).toBe(true);
    // 最小化常驻不变
    expect(container.querySelector('[title="最小化"]')).toBeTruthy();
  });

  it("保存是主按钮、关闭按钮带专属类", () => {
    const { container } = render(<EditorToolbar {...toolbarProps()} />);
    expect(hasCls(container.querySelector('[title="保存 Ctrl+S"]')!, "tbBtnPrimary")).toBe(true);
    expect(hasCls(container.querySelector('[title="关闭 Esc"]')!, "tbBtnClose")).toBe(true);
  });

  it("保存中：保存按钮转「… 保存中」并禁用（稿子 data-save=saving）", () => {
    const props = toolbarProps({ isSaving: true });
    render(<EditorToolbar {...props} />);
    const btn = screen.getByTitle("正在保存") as HTMLButtonElement;
    expect(btn.textContent).toContain("保存中");
    expect(btn.disabled).toBe(true);
    // 禁用期间点击不得触发保存回调
    fireEvent.click(btn);
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("动态语言类型才渲染语言选择器", () => {
    const { container: c1 } = render(
      <EditorToolbar {...toolbarProps({ dynamicLanguage: true, languageName: "rust" })} />
    );
    expect(c1.textContent).toContain("rust");
    cleanup();

    const { container: c2 } = render(<EditorToolbar {...toolbarProps()} />);
    // 左侧只有 icon + name + path 三项，无语言选择器
    expect(q(c2, "toolbarLeft")!.children.length).toBe(3);
  });
});

describe("EditorStatusBar", () => {
  const base = {
    lines: 12,
    words: 280,
    readMin: 1,
    isDirty: false,
    isSaving: false,
    autoSaveError: false,
    typeLabel: "Markdown",
    cursor: null as CursorInfo | null,
  };

  it("左侧是 行数/字数/阅读时长/编码 —— 不再重复显示文件名与字符数（P0-6）", () => {
    // 文件名在工具栏已有（同行拼接），字符数与字数是同一信息的两种口径；
    // 状态栏保留对写作更有用的：行数、字数、阅读时长、编码。
    const { container } = render(<EditorStatusBar {...base} />);
    const left = q(container, "statusLeft")!;

    const texts = Array.from(qa(left, "statusItem")).map((e) => e.textContent);
    expect(texts).toEqual(["12 行", "280 字", "约 1 分钟读完", "UTF-8"]);
    expect(container.textContent).not.toContain("周报");
    expect(container.textContent).not.toContain("字符");
  });

  it("readMin 为 0 时不渲染阅读时长条目", () => {
    const { container } = render(<EditorStatusBar {...base} readMin={0} />);
    expect(container.textContent).not.toContain("分钟读完");
    // 行/字/编码 3 项
    expect(qa(q(container, "statusLeft")!, "statusItem").length).toBe(3);
  });

  it("四态互斥且各带对应徽章类 —— 规则 15 的落点，不能被合并", () => {
    // 徽章在 2026-09 工作台化 P0-3 从「一行白字」升级为带色徽章，
    // 所以断言从 .statusItem 改为 .saveBadge + 各态专属类。
    // ① 已保存
    const { container: c1 } = render(<EditorStatusBar {...base} />);
    const s1 = q(c1, "saveBadge")!;
    expect(s1.textContent).toBe("已保存");
    expect(hasCls(s1, "saveBadgeSaved")).toBe(true);
    // 圆点：图形编码，不只靠颜色辨认
    expect(q(s1, "saveBadgeDot")).toBeTruthy();
    cleanup();

    // ② 未保存（防抖期）：既不加 saved 也不加 failed
    const { container: c2 } = render(<EditorStatusBar {...base} isDirty />);
    const s2 = q(c2, "saveBadge")!;
    expect(s2.textContent).toBe("未保存");
    expect(hasCls(s2, "saveBadgeDirty")).toBe(true);
    expect(hasCls(s2, "saveBadgeSaved")).toBe(false);
    expect(hasCls(s2, "saveBadgeFailed")).toBe(false);
    cleanup();

    // ③ 保存中（写盘段）：优先于脏。防抖等待期不算——那还是「未保存」。
    const { container: c4 } = render(<EditorStatusBar {...base} isDirty isSaving />);
    const s4 = q(c4, "saveBadge")!;
    expect(s4.textContent).toBe("保存中…");
    expect(hasCls(s4, "saveBadgeSaving")).toBe(true);
    expect(hasCls(s4, "saveBadgeDirty")).toBe(false);
    cleanup();

    // ④ 自动保存失败：**不会自己好**，必须提示手动重试。这一态被并进前两态就是丢稿。
    const { container: c3 } = render(<EditorStatusBar {...base} isDirty isSaving autoSaveError />);
    const s3 = q(c3, "saveBadge")!;
    expect(s3.textContent).toBe("自动保存失败 · Ctrl+S 重试");
    expect(hasCls(s3, "saveBadgeFailed")).toBe(true);
    expect(s3.getAttribute("title")).toContain("Ctrl+S");
    // 失败态即使同时 isDirty，也必须报失败（优先级不能反）
    expect(hasCls(s3, "saveBadgeDirty")).toBe(false);
  });

  it("右侧第二项是类型标签（动态语言时由调用方传入语言名）", () => {
    const { container } = render(<EditorStatusBar {...base} typeLabel="纯文本" />);
    const right = q(container, "statusRight")!;
    // ⚠️ 不能用 qa(right,"saveBadge").length 数徽章：saveBadgeDot / saveBadgeSaved
    //    都含 "saveBadge" 子串，子串匹配会多算。改数直接子元素。
    expect(right.children.length).toBe(2);
    expect(hasCls(right.children[0], "saveBadge")).toBe(true); // 第 1 项：保存徽章
    expect(hasCls(right.children[1], "statusItem")).toBe(true); // 第 2 项：类型标签
    expect(right.children[1].textContent).toBe("纯文本");
  });

  it("B4：有光标时显示 行/列（等宽），有选区追加 已选 N 字；cursor=null 整组消失", () => {
    // 无选区：只有定位项
    const { container: c1 } = render(
      <EditorStatusBar {...base} cursor={{ line: 12, col: 5, selLen: 0 }} />,
    );
    const right1 = q(c1, "statusRight")!;
    expect(right1.textContent).toContain("行 12，列 5");
    expect(right1.textContent).not.toContain("已选");
    expect(hasCls(right1.children[0], "statusMono")).toBe(true);
    cleanup();

    // 有选区：定位 + 选区并存（稿子 mock 两项同时在）
    const { container: c2 } = render(
      <EditorStatusBar {...base} cursor={{ line: 12, col: 5, selLen: 26 }} />,
    );
    expect(q(c2, "statusRight")!.textContent).toContain("已选 26 字");
    cleanup();

    // 仅预览（cursor=null）：不留占位，右侧回到 徽章+类型 两项
    const { container: c3 } = render(<EditorStatusBar {...base} cursor={null} />);
    expect(q(c3, "statusRight")!.children.length).toBe(2);
    expect(q(c3, "statusRight")!.textContent).not.toContain("行 1，列 1");
  });

  it("P0-3 细节：自动保存失败徽章可点重试（= Ctrl+S）；其余态渲染纯展示 span", () => {
    const onRetry = vi.fn();
    // 失败态 + 有回调 → button
    const { container: c1 } = render(<EditorStatusBar {...base} autoSaveError onSaveRetry={onRetry} />);
    const b1 = q(c1, "saveBadge")!;
    expect(b1.tagName).toBe("BUTTON");
    expect(hasCls(b1, "saveBadgeAsBtn")).toBe(true);
    fireEvent.click(b1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    cleanup();

    // 非失败态即便传了回调也不可点（点徽章语义只在「存不进去」时存在）
    const { container: c2 } = render(<EditorStatusBar {...base} onSaveRetry={onRetry} />);
    expect(q(c2, "saveBadge")!.tagName).toBe("SPAN");

    // 失败态但无回调（FocusChrome 钉另有自己的点击层）→ 仍为 span
    const { container: c3 } = render(<EditorStatusBar {...base} autoSaveError />);
    expect(q(c3, "saveBadge")!.tagName).toBe("SPAN");
  });
});

describe("PaneHeader / PreviewPaneHeader", () => {
  it("基础面板头只有标题，无副标签、无额外控件", () => {
    const { container } = render(<PaneHeader label="编辑" />);
    expect(q(container, "paneLabel")!.textContent).toBe("编辑");
    expect(q(container, "paneSubLabel")).toBeNull();
    expect(q(container, "paneHeader")!.children.length).toBe(1);
  });

  it("预览面板头带副标签与 markdown 行号开关", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <PreviewPaneHeader subLabel="实时" showLineNumbersToggle lineNumbersOn onToggleLineNumbers={onToggle} />
    );
    expect(q(container, "paneLabel")!.textContent).toBe("预览");
    expect(q(container, "paneSubLabel")!.textContent).toBe("实时");

    const toggle = q(container, "lnToggle")!;
    expect(hasCls(toggle, "lnToggleActive")).toBe(true);
    expect(q(toggle, "lnToggleDot")).toBeTruthy();
    expect(toggle.textContent).toContain("行号");

    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalled();
  });

  it("预览面板头主文案可由调用方指定（P0-2：markdown「排版预览」），缺省「预览」", () => {
    const { container: c1 } = render(
      <PreviewPaneHeader label="排版预览" showLineNumbersToggle={false} lineNumbersOn={false} onToggleLineNumbers={vi.fn()} />
    );
    expect(q(c1, "paneLabel")!.textContent).toBe("排版预览");

    cleanup();
    const { container: c2 } = render(
      <PreviewPaneHeader showLineNumbersToggle={false} lineNumbersOn={false} onToggleLineNumbers={vi.fn()} />
    );
    expect(q(c2, "paneLabel")!.textContent).toBe("预览");
  });

  it("非 markdown 不渲染行号开关；关闭态不带激活类", () => {
    const { container: c1 } = render(
      <PreviewPaneHeader showLineNumbersToggle={false} lineNumbersOn={false} onToggleLineNumbers={vi.fn()} />
    );
    expect(q(c1, "lnToggle")).toBeNull();
    cleanup();

    const { container: c2 } = render(
      <PreviewPaneHeader showLineNumbersToggle lineNumbersOn={false} onToggleLineNumbers={vi.fn()} />
    );
    expect(hasCls(q(c2, "lnToggle")!, "lnToggleActive")).toBe(false);
  });
});
