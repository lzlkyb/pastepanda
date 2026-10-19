/**
 * 自绘缩放边带（2026-10-18）。
 *
 * `decorations(false)` 的窗在 Windows 上没有可靠的系统缩放边（webview 铺满客户区），
 * 所以命中区只能自己画：4 条 6px 贴边 + 4 个 12×12 角块。按下即调
 * `startResizeDragging`，之后的光标与尺寸都由系统接管，本组件不再参与。
 *
 * 最大化时整组由 CSS `[data-max] .rec-pv-edges{display:none}` 收起：
 * 最大化态下拖边没有意义，留着只会抢走边缘 6px 的点击。
 */
import type { PointerEvent as ReactPointerEvent } from "react";
import type { RecResizeDir } from "@/lib/api/rec";

const DIRS: RecResizeDir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

export function ResizeEdges({ onResize }: { onResize: (dir: RecResizeDir) => void }) {
  const down = (dir: RecResizeDir) => (event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    onResize(dir);
  };
  return (
    <div className="rec-pv-edges" aria-hidden="true">
      {DIRS.map((dir) => (
        <span key={dir} className={`rec-pv-edge ${dir}`} onPointerDown={down(dir)} />
      ))}
    </div>
  );
}
