import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 常挂载、靠自身 open 条件渲染的弹窗，必须自带 AnimatePresence 边界：
 * 它们不在 CardList 那层 presence 的子树里，条件挂载而没有边界时，
 * dialogMotion authored 的 exit 变体永远不会播放（关弹窗 = 瞬移消失）。
 * 2026-10-18 审查 M5：ChainRunnerDialog / ChainEditor 曾是这个形态。
 */
const DIALOGS = [
  ["src/components/ChainRunnerDialog.tsx", "w.open"],
  ["src/components/ChainEditor.tsx", "e.open"],
] as const;

describe("常挂载弹窗的 presence 边界", () => {
  for (const [file, flag] of DIALOGS) {
    it(`${file} 把条件挂载包在 AnimatePresence 里`, () => {
      const source = readFileSync(file, "utf8");
      const boundary = source.indexOf("<AnimatePresence>");
      const conditional = source.indexOf(`{${flag} && (`);
      const backdrop = source.indexOf("<motion.div {...anim.backdrop}");
      expect(boundary, "缺少 AnimatePresence 边界").toBeGreaterThan(-1);
      expect(conditional, "条件挂载不在边界之后").toBeGreaterThan(boundary);
      expect(backdrop, "退场主体不在条件挂载之后").toBeGreaterThan(conditional);
      expect(source.indexOf("</AnimatePresence>")).toBeGreaterThan(backdrop);
      // 老写法：`return open ? <motion.div …> : null`
      expect(source).not.toContain(`return ${flag} ? <motion.div`);
    });
  }
});
