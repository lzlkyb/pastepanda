import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { UpdateNotesDialog } from "@/components/UpdateNotesDialog";

// ── Mocks（vi.hoisted 保证在 vi.mock 工厂提升后可用） ──────────

const { mockUseUpdate } = vi.hoisted(() => ({ mockUseUpdate: vi.fn() }));

vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: mockUseUpdate,
}));

vi.mock("@/lib/changelog.generated", () => ({
  CHANGELOG: [
    {
      version: "9.9.9",
      date: "2026-07-27",
      summary: "测试版本摘要",
      categories: [
        {
          type: "feat",
          name: "新增",
          items: [{ text: "新功能甲" }, { text: "事件驱动监听：两级管线" }],
        },
        {
          type: "change",
          name: "改进",
          groups: [{ label: "体验优化", items: [{ text: "改进乙" }] }],
        },
        { type: "fix", name: "修复", items: [{ text: "修复丙" }] },
      ],
    },
  ],
}));

// matchMedia stub（usePrefersReducedMotion / dialogMotion 依赖）
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  cleanup();
});

function mockUpdate(overrides: Record<string, unknown> = {}) {
  mockUseUpdate.mockReturnValue({
    status: "available",
    update: { version: "9.9.9", body: null },
    progress: 0,
    progressIndeterminate: false,
    bytesPerSec: 0,
    downloadAndInstall: vi.fn(),
    skipThisVersion: vi.fn(),
    ...overrides,
  });
}

/** chip 按钮与时间线 tag 文本重复，按标签名取 chip */
function chipByLabel(label: string): HTMLElement {
  const el = screen
    .getAllByText(label)
    .find((e) => e.tagName === "BUTTON");
  if (!el) throw new Error(`未找到 chip「${label}」`);
  return el;
}

// ── 用例 ────────────────────────────────────────────────

describe("UpdateNotesDialog（方案 C 玻璃时间线）", () => {
  it("open=false 时不渲染内容", () => {
    mockUpdate();
    render(<UpdateNotesDialog open={false} onClose={() => {}} currentVersion="9.9.8" />);
    expect(screen.queryByText("PastePanda")).toBeNull();
  });

  it("结构化日志：版本过渡、摘要引语、chips 与时间线全部条目", () => {
    mockUpdate();
    render(<UpdateNotesDialog open onClose={() => {}} currentVersion="9.9.8" />);

    // 顶部 header 行
    expect(screen.getByText("PastePanda")).toBeTruthy();
    expect(screen.getByText("v9.9.8")).toBeTruthy();
    expect(screen.getByText("v9.9.9")).toBeTruthy();
    expect(screen.getByText("NEW")).toBeTruthy();

    // 摘要引语
    expect(screen.getByText("测试版本摘要")).toBeTruthy();

    // chips（全部 4 条）
    const allChip = screen.getByText("全部").closest("button");
    expect(allChip?.textContent).toBe("全部4");
    expect(chipByLabel("新增")).toBeTruthy();
    expect(chipByLabel("改进")).toBeTruthy();
    expect(chipByLabel("修复")).toBeTruthy();

    // 时间线：普通条目、「标题：」加粗拆分、分组标签
    expect(screen.getByText("新功能甲")).toBeTruthy();
    expect(screen.getByText("事件驱动监听")).toBeTruthy(); // <b> 前缀
    expect(screen.getByText("体验优化")).toBeTruthy(); // 分组标签行
    expect(screen.getByText("改进乙")).toBeTruthy();
    expect(screen.getByText("修复丙")).toBeTruthy();

    // 页脚
    expect(screen.getByText("下载并更新")).toBeTruthy();
    expect(screen.getByText("跳过此版本")).toBeTruthy();
  });

  it("chip 筛选：点「修复」后仅修复条目可见，其余挂 tlHidden", () => {
    mockUpdate();
    render(<UpdateNotesDialog open onClose={() => {}} currentVersion="9.9.8" />);

    fireEvent.click(chipByLabel("修复"));

    expect(screen.getByText("修复丙").closest("div")?.className).not.toContain("tlHidden");
    expect(screen.getByText("改进乙").closest("div")?.className).toContain("tlHidden");
    expect(screen.getByText("新功能甲").closest("div")?.className).toContain("tlHidden");
    // 分组标签行随所属分类一起隐藏
    expect(screen.getByText("体验优化").className).toContain("tlHidden");

    // 点「全部」恢复
    fireEvent.click(screen.getByText("全部"));
    expect(screen.getByText("改进乙").closest("div")?.className).not.toContain("tlHidden");
  });

  it("下载中：按钮显示进度文本并禁用", () => {
    mockUpdate({ status: "downloading", progress: 42 });
    render(<UpdateNotesDialog open onClose={() => {}} currentVersion="9.9.8" />);
    const btn = screen.getByText("下载中 42%").closest("button");
    expect(btn?.disabled).toBe(true);
  });

  it("跳过此版本：调用 skipThisVersion 并关闭弹框", () => {
    const skip = vi.fn();
    const close = vi.fn();
    mockUpdate({ skipThisVersion: skip });
    render(<UpdateNotesDialog open onClose={close} currentVersion="9.9.8" />);

    fireEvent.click(screen.getByText("跳过此版本"));
    expect(skip).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("包内无条目时解析 update.body：平铺 notes 渲染为「更新内容」时间线", () => {
    // 真实更新场景：目标版本（0.0.1）不在包内 CHANGELOG（仅 9.9.9），
    // body 为 v5.3.2 及更早的 notes 格式（分类标题被 CI 剥离的纯 bullet）
    mockUpdate({
      update: {
        version: "0.0.1",
        body: "- 全屏编辑器主题样式丢失：已补齐样式导入\n- 托盘弹窗同类问题：已修复",
      },
    });
    render(<UpdateNotesDialog open onClose={() => {}} currentVersion="0.0.0" />);

    expect(screen.queryByText("暂无详细更新日志")).toBeNull();
    // 摘要引语取首条；「标题：」前缀在时间线内加粗
    expect(screen.getByText("全屏编辑器主题样式丢失")).toBeTruthy();
    expect(screen.getByText("托盘弹窗同类问题")).toBeTruthy();
    // 平铺格式归入单个「更新内容」分类 chip
    expect(chipByLabel("更新内容")).toBeTruthy();
    expect(screen.getByText("全部").closest("button")?.textContent).toBe("全部2");
  });

  it("包内无条目时解析 update.body：结构化 notes 还原分类 chips 与时间线", () => {
    // v5.3.3 起的 notes 格式：完整段落含 ### 分类标题
    mockUpdate({
      update: {
        version: "0.0.2",
        body: "### 新增\n- 新功能甲\n\n### 修复\n- 修复乙",
      },
    });
    render(<UpdateNotesDialog open onClose={() => {}} currentVersion="0.0.1" />);

    expect(screen.queryByText("暂无详细更新日志")).toBeNull();
    expect(chipByLabel("新增")).toBeTruthy();
    expect(chipByLabel("修复")).toBeTruthy();
    // 首条条目同时出现在摘要引语与时间线（summary 取首条）
    expect(screen.getAllByText("新功能甲")).toHaveLength(2);
    expect(screen.getByText("修复乙")).toBeTruthy();
    expect(screen.getByText("全部").closest("button")?.textContent).toBe("全部2");
  });

  it("无结构化日志条目时走 fallback", () => {
    mockUpdate({ update: { version: "0.0.1", body: "原始日志文本" } });
    render(<UpdateNotesDialog open onClose={() => {}} currentVersion="0.0.0" />);
    expect(screen.getByText("暂无详细更新日志")).toBeTruthy();
    expect(screen.getByText("原始日志文本")).toBeTruthy();
  });
});
