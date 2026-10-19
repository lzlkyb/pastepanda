import { useEffect, useState, type RefObject } from "react";
import { collectTopBlocks } from "@/lib/markdown/blockLocate";

/** 块编辑浮层状态：null = 关闭。raw 是打开瞬间那块的源码，也是写回侧的 expectRaw */
export type BlockEditing = { index: number; raw: string } | null;

/**
 * 块级就地编辑（全屏编辑器预览态，MarkCopy 思路：双击块 → 浮层改源码 → 写回）。
 *
 * - 给每个非 hr 顶层块挂 data-blk-i（与 blockLocate.collectTopBlocks 的口径一致：
 *   跳过 space（不产 DOM）与 hr）。原文件注释：必须在 decorateTables 之后 ——
 *   表格被包进 .md-tblwrap 后仍是 1 个顶层子元素，1:1 关系不变，但顺序上要等
 *   包装完成。（注意：原实现里本 effect 声明在 decorateTables 之前生效；
 *   重构只保序不改行为，组件侧调用顺序 = 原声明顺序。）
 * - 双击顶层块打开浮层。与单击委托分开 —— 双击会先触发两次 click，
 *   若混进单击链会让勾选/图片放大在双击时误触发。
 *
 * 返回 [editing, setEditing]：editing 供组件渲染 BlockEditOverlay，setEditing(null) 关闭。
 */
export function useBlockEditing(
  containerRef: RefObject<HTMLDivElement | null>,
  text: string,
  html: string,
  enabled: boolean,
): [BlockEditing, (next: BlockEditing) => void] {
  const [editing, setEditing] = useState<BlockEditing>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let n = 0;
    Array.from(el.children).forEach((child) => {
      if (child.tagName === "HR") return;
      if (enabled) (child as HTMLElement).dataset.blkI = String(n);
      else delete (child as HTMLElement).dataset.blkI;
      n += 1;
    });
  }, [containerRef, html, enabled]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !enabled) return;
    const onDblClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // 已有单击行为的元素不劫持：链接/图片/按钮/勾选框/块号
      if (target.closest("a, button, input, img, .md-blknum")) return;
      const blockEl = target.closest("[data-blk-i]") as HTMLElement | null;
      if (!blockEl || !el.contains(blockEl)) return;
      const idx = Number(blockEl.dataset.blkI);
      if (!Number.isInteger(idx) || idx < 0) return;
      // 双击瞬间重新定位：块列表必须完整，且 DOM 顶层块数与 lexer 侧一致
      // （html token 多根标签等结构异常时两侧会不等，退回只读比错位改块安全）
      const { blocks, complete } = collectTopBlocks(text);
      if (!complete) return;
      let domCount = 0;
      Array.from(el.children).forEach((c) => {
        if (c.tagName !== "HR") domCount += 1;
      });
      if (domCount !== blocks.length) return;
      const b = blocks[idx];
      if (!b) return;
      e.preventDefault();
      setEditing({ index: idx, raw: b.raw });
    };
    el.addEventListener("dblclick", onDblClick);
    return () => el.removeEventListener("dblclick", onDblClick);
  }, [containerRef, text, enabled]);

  return [editing, setEditing];
}
