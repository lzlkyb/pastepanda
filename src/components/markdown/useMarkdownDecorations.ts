import { useEffect, type RefObject } from "react";
import { decorateTables } from "@/components/markdown/tableTools";

/**
 * 可勾选：摘掉 marked 默认写死的 `disabled`。
 * 只摘 `data-task-i !== "-1"`（源码定位可信）的那些；html 每次重渲染都会
 * 整体替换子树，所以要跟着 html 重跑。
 */
export function useEnableTaskCheckboxes(
  containerRef: RefObject<HTMLDivElement | null>,
  html: string,
  enabled: boolean,
): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !enabled) return;
    el.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-task-i]').forEach((box) => {
      if (box.dataset.taskI !== "-1") box.disabled = false;
    });
  }, [containerRef, html, enabled]);
}

/**
 * 表格装饰：包 wrapper + 右上角「复制表格」按钮。
 * 必须排在块号注入**之前**——反过来时 md-blknum 会被塞进 <table> 内部，
 * 而 table 自己是 overflow-x:auto 的横滚容器，left:-52px 的编号会被裁掉。
 * （组件侧调用顺序即约束。）
 */
export function useTableDecorate(
  containerRef: RefObject<HTMLDivElement | null>,
  html: string,
): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    decorateTables(el);
  }, [containerRef, html]);
}

/**
 * 块级行号注入：每个非 hr 顶层块插入 md-blknum 编号（点击闪烁见点击委托）。
 * dangerouslySetInnerHTML 重渲染会整体替换子树，故 html 变化后需重新注入；
 * 开关关闭时 html 可能未变（子树不替换），须主动清除残留编号
 */
export function useBlockNumbers(
  containerRef: RefObject<HTMLDivElement | null>,
  html: string,
  showLineNumbers: boolean,
): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.querySelectorAll(".md-blknum").forEach((s) => s.remove());
    if (!showLineNumbers) return;
    let n = 0;
    Array.from(el.children).forEach((child) => {
      if (child.tagName === "HR") return;
      n += 1;
      const span = document.createElement("span");
      span.className = "md-blknum";
      span.textContent = String(n);
      child.insertBefore(span, child.firstChild);
    });
  }, [containerRef, html, showLineNumbers]);
}
