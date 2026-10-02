/**
 * 图标表的覆盖守卫。
 *
 * 截图 AI 弹层曾经把后端返回的 icon **名字符串**直接画进 26px 的格子（实测 23 行里
 * 20 行溢出），根因是图标表只服务于主窗口、没有别处在用、也没有测试钉住它。
 * 这条守卫的做法是直接从后端源码里抓 `icon: "..."` 字面量：
 * 后端新增一个动作、前端忘了加映射，测试就会红——而不是等到界面印英文串。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { TRANSFORM_ICONS } from "@/components/transform/TransformIcon";

// vitest 从项目根启动，process.cwd() = 项目根（import.meta.url 在 vitest 下不是 file scheme）
const ACTIONS_RS = join(process.cwd(), "src-tauri", "src", "ai", "actions.rs");

/** 后端声明的全部 icon 语义键（去重后） */
function backendIconKeys(): string[] {
  const src = readFileSync(ACTIONS_RS, "utf-8");
  const found = src.matchAll(/icon:\s*"([^"]+)"/g);
  return [...new Set([...found].map((m) => m[1]))];
}

describe("图标语义键表", () => {
  it("后端 actions.rs 声明的每个 icon 都有映射", () => {
    const keys = backendIconKeys();
    // 抓到空数组说明正则或路径失效了，这条守卫就变成永真——先钉住它本身
    expect(keys.length).toBeGreaterThanOrEqual(20);
    const missing = keys.filter((k) => !(k in TRANSFORM_ICONS));
    expect(missing).toEqual([]);
  });

  it("本地变换的图标键同样在表内（否则卡片静默回落成通用图标）", () => {
    for (const k of ["database", "table", "rows", "list", "case-upper", "case-lower",
      "eraser", "pilcrow", "quote", "remove-formatting", "link", "globe", "mail",
      "phone", "code", "minus", "hash", "palette", "folder", "file-text", "search",
      "list-collapse"]) {
      expect(TRANSFORM_ICONS[k]).toBeDefined();
    }
  });
});
