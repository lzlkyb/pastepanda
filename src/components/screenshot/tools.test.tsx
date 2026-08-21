import { describe, it, expect } from "vitest";
import { TOOLS, TOOL_BY_KEY } from "./tools";

/**
 * 马赛克合并（V6.20）：模糊 / 自动打码 收进「马赛克」属性栏的模式分段。
 * 守卫的是三个容易被后续改动弄坏的约定：
 *  ① 主栏渲染必须过滤 hidden（否则模糊/自动打码按钮又冒出来）；
 *  ② key 7 仍映射 blur（肌肉记忆不失效）——即使按钮已隐藏；
 *  ③ blur 仍是合法 ToolId（已画标注的 type、属性栏模式分段都还引用它）。
 */
describe("马赛克合并：模糊/自动打码收进属性栏", () => {
  it("主栏隐藏 blur / automask，保留 mosaic", () => {
    const visible = TOOLS.filter((t) => !t.hidden).map((t) => t.id);
    expect(visible).not.toContain("blur");
    expect(visible).not.toContain("automask");
    expect(visible).toContain("mosaic");
  });

  it("快捷键 6/7 仍映射 mosaic / blur（肌肉记忆不失效）", () => {
    expect(TOOL_BY_KEY["6"]).toBe("mosaic");
    expect(TOOL_BY_KEY["7"]).toBe("blur");
  });

  it("隐藏的 blur / automask 仍是合法工具定义（已画标注与属性栏模式仍引用）", () => {
    const ids = TOOLS.map((t) => t.id);
    expect(ids).toContain("blur");
    expect(ids).toContain("automask");
  });
});
