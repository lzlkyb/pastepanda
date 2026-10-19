import { useEffect, useRef, type RefObject } from "react";

/**
 * 表单控件的**当前值**（预览内 `{{字段}}` 生成的 input/textarea/select）。
 *
 * 为什么需要它：预览是 `dangerouslySetInnerHTML`，正文一变（300ms 防抖后）整棵子树
 * 被替换，用户刚在 `{{姓名}}` 里敲的字会被 HTML 里的 `value` 打回去。
 * 这里把值留在 ref 里，重渲染后按 name 回填——「填了立刻丢」是比不可编辑更糟的体验。
 *
 * 注意：这些值**不会**写回 Markdown 源码。正文是模板，值是数据；混在一起会让
 * 下次导出带着上一次的填写内容，业务人员拿到一份已经填好的表单。
 */
export function useMarkdownFormValues(
  containerRef: RefObject<HTMLDivElement | null>,
  html: string,
): void {
  const formValuesRef = useRef<Record<string, string | boolean>>({});

  // 捕获：控件 input/change 时把值存进 ref（捕获期监听，冒泡前拿到）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onEdit = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement)) {
        return;
      }
      const name = t.getAttribute("name");
      if (!name) return;
      if (t instanceof HTMLInputElement && (t.type === "checkbox" || t.type === "radio")) {
        formValuesRef.current[name] = t.type === "radio" ? t.value : t.checked;
      } else {
        formValuesRef.current[name] = t.value;
      }
    };
    el.addEventListener("input", onEdit, true);
    el.addEventListener("change", onEdit, true);
    return () => {
      el.removeEventListener("input", onEdit, true);
      el.removeEventListener("change", onEdit, true);
    };
  }, [containerRef]);

  // 回填：html 重渲染（子树整体替换）后按 name 恢复已填的值
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const saved = formValuesRef.current;
    if (Object.keys(saved).length === 0) return;
    el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input[name], textarea[name], select[name]",
    ).forEach((node) => {
      const name = node.getAttribute("name");
      if (!name || !(name in saved)) return;
      const value = saved[name];
      if (node instanceof HTMLInputElement && (node.type === "checkbox" || node.type === "radio")) {
        node.checked = node.type === "radio" ? node.value === value : !!value;
      } else {
        node.value = String(value);
      }
    });
  }, [containerRef, html]);
}
