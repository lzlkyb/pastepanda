/**
 * 知识模式的布局档位（B1 #1，设计稿 §10）。
 *
 * **断点沿用项目现有的 600 / 800**（`src/styles/app.css` 已经在给 `.card-list` 用）。
 * 再引入第三套断点只会让以后改布局时没人知道该改哪一档。
 *
 * | 宽度        | 点一条笔记 |
 * |-------------|--------------|
 * | < 800px     | 弹窗 |
 * | ≥ 800px     | **第三栏** |
 *
 * ❗ 原本还有一个 `sidebarPinned`（≥600px 侧栏常驻），已删除：
 * 侧栏开合收口到 `appStore.sidebarOpen` 后，「常驻」退化成了「首次默认展开」，
 * 而那个判定已经在 store 的初值里（`prefersWideSidebar`）。
 * 留在这里只会成为第二份真相。
 *
 * 用 matchMedia 而不是监 resize：同 `usePrefersReducedMotion` 的现成范式，
 * 且 matchMedia 只在跳档时触发，拖窗口不会每帧 setState。
 */
import { useMediaQuery } from "./useMediaQuery";

/** 第三栏的门槛。 */
const EXTRA_WIDE = "(min-width: 800px)";

export interface KbLayout {
  /** ≥800px：第三栏可用，点笔记不再弹窗 */
  hasDetailPane: boolean;
}

export function useKbLayout(): KbLayout {
  const hasDetailPane = useMediaQuery(EXTRA_WIDE);
  return { hasDetailPane };
}
