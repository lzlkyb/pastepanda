/**
 * 往 input / textarea 的光标处插一段文本，并把光标停在插入内容之后。
 *
 * 收口两个调用点（规则 #11）：AI 自定义动作的「插入 {{内容}}」按钮、
 * 转笔记模板的变量按钮。两边都要「插在光标处而不是追加到末尾」——
 * 用户点变量按钮时，想插的位置几乎从来不是文末。
 *
 * 拿不到元素时退化成追加到末尾：那比什么都不插好。
 *
 * @returns 插入后的完整文本。调用方负责把它写回 state（本函数不碰 state）。
 */
export function insertAtCursor(
  el: HTMLTextAreaElement | HTMLInputElement | null,
  value: string,
  snippet: string,
): string {
  if (!el) return value + snippet;

  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? start;
  const next = value.slice(0, start) + snippet + value.slice(end);

  // 下一帧再设光标：此刻 value 还是旧的，setSelectionRange 会被 React 重渲染覆盖
  const caret = start + snippet.length;
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(caret, caret);
  });

  return next;
}
