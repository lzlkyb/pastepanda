/**
 * 全屏编辑器标签栏（纯展示）。
 *
 * 只负责「按给定数据渲染 + 把点击回传」，**不持有标签状态**——标签列表、活动项、
 * 关闭守卫统统在宿主（FullscreenEditor 的标签层）。这里唯一的内部状态是
 * 「左右两侧还能不能滚」，它纯粹由 DOM 尺寸决定。
 *
 * 「不适用就不出现」在本项目的延伸：单标签时不渲染标签栏（宿主裁决），
 * 因为 1 个标签的标签栏只是个多余的 34px 横条，而它的信息在工具栏里已经有了。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import styles from "./TabBar.module.css";

export interface TabItem {
  id: string;
  /** 显示用文件名（不含目录）。极长名走省略号，完整名由 title 兜底 */
  fileName: string;
  /** 类型图标字符（M↓ / {} / </> …），与工具栏 fileIcon 同一份来源 */
  icon: string;
  isDirty: boolean;
  /** 自动保存失败（红点取代橙点） */
  tabError: boolean;
}

interface TabBarProps {
  tabs: TabItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** 还能不能再开（false 时 + 按钮禁用并说明上限） */
  canAdd: boolean;
  maxTabs: number;
}

export function TabBar({ tabs, activeId, onSelect, onClose, onNew, canAdd, maxTabs }: TabBarProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  /** 同步两端是否还有未显示的内容。1px 容差避开亚像素布局造成的假溢出。 */
  const syncOverflow = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 1);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    syncOverflow();
    window.addEventListener("resize", syncOverflow);
    return () => window.removeEventListener("resize", syncOverflow);
  }, [syncOverflow, tabs.length, activeId]);

  // 活动标签滚入可见：Ctrl+Tab / Ctrl+1..9 切换后，被选中的标签可能还在视口外
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  /** 整屏步进（留 30% 重叠，避免「翻页后完全认不出上一屏的边缘项」） */
  const nudge = useCallback((dir: -1 | 1) => {
    const el = stripRef.current;
    if (!el) return;
    el.scrollBy?.({ left: dir * Math.max(120, el.clientWidth * 0.7), behavior: "smooth" });
  }, []);

  return (
    <div className={styles.tabBar} role="tablist" aria-label="打开的文档">
      <div className={styles.stripWrap}>
        <div className={styles.tabStrip} ref={stripRef} onScroll={syncOverflow}>
          {tabs.map((t) => (
            <div
              key={t.id}
              data-active={t.id === activeId}
              role="tab"
              aria-selected={t.id === activeId}
              tabIndex={t.id === activeId ? 0 : -1}
              className={cn(styles.tab, t.id === activeId && styles.active)}
              title={t.fileName}
              onClick={() => onSelect(t.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(t.id);
                }
              }}
              /* 中键关闭：浏览器标签的通用肌肉记忆，这里免费拿到 */
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(t.id);
                }
              }}
            >
              <span className={styles.tabIcon}>{t.icon}</span>
              <span className={styles.tabName}>{t.fileName}</span>
              {/* 脏点常驻（见 CSS 注释：不做悬停同位互换） */}
              {t.isDirty && (
                <span className={cn(styles.tabDot, t.tabError && styles.tabDotErr)} />
              )}
              <button
                type="button"
                className={styles.tabX}
                aria-label={`关闭 ${t.fileName}`}
                title="关闭 Ctrl+W"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
              >
                <X size={12} strokeWidth={2.2} />
              </button>
            </div>
          ))}
        </div>

        {/* 渐隐遮罩：挂在 .stripWrap（滚动视口）上。见 CSS 顶部注释的踩坑记录。 */}
        {canLeft && <div className={styles.fadeL} />}
        {canRight && <div className={styles.fadeR} />}
      </div>

      {canLeft && (
        /* ui-rule-ok: 左向箭头属规则里「全球公认的 ←→」例外（无需常驻文字） */
        <button type="button" className={styles.navBtn} title="向左滚动" onClick={() => nudge(-1)}>
          <ChevronLeft size={13} />
        </button>
      )}
      {canRight && (
        /* ui-rule-ok: 右向箭头属规则里「全球公认的 ←→」例外（无需常驻文字） */
        <button type="button" className={styles.navBtn} title="向右滚动" onClick={() => nudge(1)}>
          <ChevronRight size={13} />
        </button>
      )}

      <button
        type="button"
        className={styles.addBtn}
        title={canAdd ? "新建空白文档 Ctrl+T" : `最多同时打开 ${maxTabs} 个文档`}
        aria-label="新建文档"
        disabled={!canAdd}
        onClick={onNew}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
