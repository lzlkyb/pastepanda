import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 滚到附近才真正挂载子组件。
 *
 * 为什么需要它：设置页改成「一根长滚动 + 菜单跟随高亮」后，AI/MCP/帮助/关于
 * 也要排进这根滚动，意味着它们会**一打开设置就全部挂载**。
 *
 * 🔴 `McpTab` 不能这么干：它里的 `useMcpServer` 带 **5s 轮询**，而它当初从 GeneralTab
 * 搬出去做成独立 tab，一个明确目的就是「只有真去看 MCP 才挂载」（见 McpTab.tsx 头部注释）。
 * 直接摆进连续滚动里等于把那个优化撤销了——用户只是来调个主题也会开始轮询。
 *
 * rootMargin 给 240px：滑到之前就挂好，避免「滑到了才突然弹出一大块」。
 * 挂载后不再卸（shown 单向）：来回挂载/卸载会把面板里的一次性状态（展开项、输入框）洗掉。
 */
export function LazyMount({ minHeight = 160, children }: { minHeight?: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (shown) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) setShown(true); },
      { rootMargin: "240px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown]);

  // 未挂载时占一个最小高度，否则它在文档流里高度为 0，IntersectionObserver 会立即命中
  return <div ref={ref} style={shown ? undefined : { minHeight }}>{shown ? children : null}</div>;
}
