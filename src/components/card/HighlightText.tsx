import { memo, useMemo } from "react";

/** 搜索关键词高亮组件 */
export const HighlightText = memo(function HighlightText({ text, highlight }: { text: string; highlight: string }) {
  // 限制搜索词长度，防止过长正则导致性能问题
  const safeHighlight = highlight ? highlight.trim().slice(0, 100) : "";
  // useMemo 缓存 RegExp，避免每次渲染重新编译。
  // 必须写在下面那个 early return 之前：highlight 会随搜索框在空/非空之间来回变
  // （调用处传 searchKeyword），原实现把 hook 放在 return 之后，同一个实例的 hooks
  // 数量会 0↔1 摩擦。实测当前形状下 React 恰好容忍（只有一个 hook 且无 state），
  // 但那是运气：再给它加一个 hook 就会报"Rendered fewer/more hooks than expected"。
  const regex = useMemo(() => {
    if (!safeHighlight) return null;
    const escaped = safeHighlight.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(${escaped})`, "i");
  }, [safeHighlight]);
  if (!regex) return <>{text}</>;
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? <mark key={i} className="search-highlight">{part}</mark> : <span key={i}>{part}</span>
      )}
    </>
  );
});
