/**
 * 标注元素的自增 id。
 *
 * 从 ScreenshotOverlay 抽出来是因为 useAutoMask 也要发 id，而"同一个会话里 id 不能撞"
 * 这件事必须由**唯一一个**计数器保证 —— 两个模块各自维护 idSeq 就会发出重复 id，
 * 后果是 undo/选中/删除按 id 匹配时张冠李戴。
 */

let idSeq = 1;

/** 取下一个标注 id（模块级单调递增，跨组件与 hook 共用同一个序列） */
export const nextId = (): number => idSeq++;
