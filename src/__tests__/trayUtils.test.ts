/**
 * trayUtils 测试 — 覆盖 TrayPopup 纯逻辑函数
 * 保护 M9 重构（TrayPopup 共享基础设施提取）
 */
import { describe, it, expect } from "vitest";
import {
  formatDbSize,
  calcMemPercent,
  buildMenuItems,
  clampIndexDown,
  clampIndexUp,
  resolvePasteTarget,
  getTypeIcon,
  getTypeColor,
  type TrayRecentItem,
  type TrayStatsData,
} from "../lib/trayUtils";

// ============================================================
// formatDbSize
// ============================================================
describe("formatDbSize", () => {
  it("小于 1024 KB 显示为 KB", () => {
    expect(formatDbSize(512)).toBe("512.0 KB");
  });

  it("0 KB", () => {
    expect(formatDbSize(0)).toBe("0.0 KB");
  });

  it("1023.9 KB 仍显示为 KB", () => {
    expect(formatDbSize(1023.9)).toBe("1023.9 KB");
  });

  it("1024 KB 显示为 1.0 MB", () => {
    expect(formatDbSize(1024)).toBe("1.0 MB");
  });

  it("2048 KB 显示为 2.0 MB", () => {
    expect(formatDbSize(2048)).toBe("2.0 MB");
  });

  it("小数 MB 保留一位", () => {
    expect(formatDbSize(1536)).toBe("1.5 MB");
  });
});

// ============================================================
// calcMemPercent
// ============================================================
describe("calcMemPercent", () => {
  it("null stats 返回 0", () => {
    expect(calcMemPercent(null)).toBe(0);
  });

  it("max_size_mb 为 0 时返回 0（防除零）", () => {
    const stats: TrayStatsData = { today_count: 0, total_count: 0, db_size_kb: 100, max_size_mb: 0 };
    expect(calcMemPercent(stats)).toBe(0);
  });

  it("正常比例计算", () => {
    // 512 KB / 1 MB = 512/1024/1 * 100 = 50%
    const stats: TrayStatsData = { today_count: 0, total_count: 0, db_size_kb: 512, max_size_mb: 1 };
    expect(calcMemPercent(stats)).toBe(50);
  });

  it("超过上限时 cap 到 100", () => {
    // 2048 KB / 1 MB = 200% → cap 100
    const stats: TrayStatsData = { today_count: 0, total_count: 0, db_size_kb: 2048, max_size_mb: 1 };
    expect(calcMemPercent(stats)).toBe(100);
  });

  it("空数据库返回 0", () => {
    const stats: TrayStatsData = { today_count: 0, total_count: 0, db_size_kb: 0, max_size_mb: 10 };
    expect(calcMemPercent(stats)).toBe(0);
  });
});

// ============================================================
// buildMenuItems
// ============================================================
describe("buildMenuItems", () => {
  it("监听中显示'暂停监听'", () => {
    const items = buildMenuItems(true);
    const toggle = items.find((i) => i.id === "toggle_monitor");
    expect(toggle?.label).toBe("暂停监听");
  });

  it("未监听显示'恢复监听'", () => {
    const items = buildMenuItems(false);
    const toggle = items.find((i) => i.id === "toggle_monitor");
    expect(toggle?.label).toBe("恢复监听");
  });

  it("包含 4 个菜单项", () => {
    const items = buildMenuItems(true);
    expect(items).toHaveLength(4);
  });

  it("退出项标记 danger", () => {
    const items = buildMenuItems(true);
    const exit = items.find((i) => i.id === "exit");
    expect(exit?.danger).toBe(true);
  });

  it("显示主窗口有快捷键提示", () => {
    const items = buildMenuItems(true);
    const show = items.find((i) => i.id === "show");
    expect(show?.hint).toBe("Ctrl+Alt+V");
  });

  it("菜单项顺序固定: show → toggle → settings → exit", () => {
    const items = buildMenuItems(true);
    expect(items.map((i) => i.id)).toEqual(["show", "toggle_monitor", "settings", "exit"]);
  });
});

// ============================================================
// clampIndexDown / clampIndexUp
// ============================================================
describe("clampIndexDown", () => {
  it("正常递增", () => {
    expect(clampIndexDown(0, 5)).toBe(1);
    expect(clampIndexDown(3, 5)).toBe(4);
  });

  it("到达上限不再递增", () => {
    expect(clampIndexDown(5, 5)).toBe(5);
    expect(clampIndexDown(10, 5)).toBe(5);
  });
});

describe("clampIndexUp", () => {
  it("正常递减", () => {
    expect(clampIndexUp(3)).toBe(2);
    expect(clampIndexUp(1)).toBe(0);
  });

  it("到达 0 不再递减", () => {
    expect(clampIndexUp(0)).toBe(0);
  });
});

// ============================================================
// resolvePasteTarget
// ============================================================
describe("resolvePasteTarget", () => {
  function makeItem(overrides: Partial<TrayRecentItem> = {}): TrayRecentItem {
    return {
      id: "1",
      text: "hello",
      type: "text",
      content: "",
      time: "2026-01-01 12:00:00",
      ...overrides,
    };
  }

  it("文本项 → pasteText(text)", () => {
    const item = makeItem({ type: "text", text: "hello world" });
    expect(resolvePasteTarget(item)).toEqual({ method: "text", payload: "hello world" });
  });

  it("图片项有 content → pasteImage(content)", () => {
    const item = makeItem({ type: "image", content: "/path/img.png", text: "img.png" });
    expect(resolvePasteTarget(item)).toEqual({ method: "image", payload: "/path/img.png" });
  });

  it("图片项无 content → 回退 pasteText(text)", () => {
    const item = makeItem({ type: "image", content: "", text: "fallback" });
    expect(resolvePasteTarget(item)).toEqual({ method: "text", payload: "fallback" });
  });

  it("文件项有 content → pasteText(content)", () => {
    const item = makeItem({ type: "file", content: "C:\\file.txt", text: "file.txt" });
    expect(resolvePasteTarget(item)).toEqual({ method: "text", payload: "C:\\file.txt" });
  });

  it("文件项无 content → 回退 pasteText(text)", () => {
    const item = makeItem({ type: "file", content: "", text: "no-path" });
    expect(resolvePasteTarget(item)).toEqual({ method: "text", payload: "no-path" });
  });
});

// ============================================================
// getTypeIcon / getTypeColor
// ============================================================
describe("getTypeIcon", () => {
  it("image → 🖼", () => {
    expect(getTypeIcon("image")).toBe("🖼");
  });

  it("file → 📁", () => {
    expect(getTypeIcon("file")).toBe("📁");
  });

  it("text → 📝", () => {
    expect(getTypeIcon("text")).toBe("📝");
  });

  it("未知类型 → 📝", () => {
    expect(getTypeIcon("unknown")).toBe("📝");
  });
});

describe("getTypeColor", () => {
  it("image → icon-purple", () => {
    expect(getTypeColor("image")).toBe("icon-purple");
  });

  it("file → icon-orange", () => {
    expect(getTypeColor("file")).toBe("icon-orange");
  });

  it("text → icon-blue", () => {
    expect(getTypeColor("text")).toBe("icon-blue");
  });

  it("未知类型 → icon-blue", () => {
    expect(getTypeColor("other")).toBe("icon-blue");
  });
});
