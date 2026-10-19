import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ToolGroup } from "@/lib/toolbox";
import { useInterfaceMotion } from "@/components/MotionPolicy";
import styles from "../ToolboxView.module.css";

export function ToolboxCategories({ groups, category, onChange }: { groups: ToolGroup[]; category: string; onChange: (value: string) => void }) {
  const track = useRef<HTMLDivElement>(null), indicator = useRef<HTMLSpanElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const mode = useInterfaceMotion();
  const entries = ["全部", ...groups.map(group => group.label)];
  const update = useCallback(() => {
    const el = track.current, active = el?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    if (!el) return;
    setEdges(previous => {
      const next = { start: el.scrollLeft <= 2, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2 };
      return previous.start === next.start && previous.end === next.end ? previous : next;
    });
    if (active && indicator.current) {
      // Geometry belongs to the selected label; its width changes with window size.
      indicator.current.style.width = `${active.offsetWidth}px`;
      indicator.current.style.transform = `translateX(${active.offsetLeft}px)`;
    }
  }, []);
  useLayoutEffect(() => {
    const el = track.current;
    const active = el?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    if (el && active) {
      if (active.offsetLeft < el.scrollLeft) el.scrollLeft = active.offsetLeft;
      else if (active.offsetLeft + active.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = active.offsetLeft + active.offsetWidth - el.clientWidth;
    }
    update();
    const observer = new ResizeObserver(update);
    if (el) observer.observe(el);
    if (active) observer.observe(active);
    return () => observer.disconnect();
  }, [category, update]);
  const scroll = (direction: number) => track.current?.scrollBy({ left: direction * 180, behavior: mode === "full" ? "smooth" : "instant" });
  return <nav className={styles.categories} aria-label="工具用途分类" data-motion={mode}>
    <button type="button" className={styles.navArrow} aria-label="查看前面的分类" disabled={edges.start} onClick={() => scroll(-1)}><ChevronLeft size={16} /></button>
    <div className={styles.categoryTrack} ref={track} role="tablist" aria-label="工具分类" onScroll={update}>
      <span ref={indicator} className={styles.categoryIndicator} aria-hidden="true" />
      {entries.map((label, index) => <button type="button" key={label} role="tab" id={`toolbox-category-${index}`}
        aria-controls="toolbox-catalog" aria-selected={category === label} tabIndex={category === label ? 0 : -1}
        onClick={() => { if (category !== label) onChange(label); }} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : (index + (event.key === "ArrowRight" ? 1 : entries.length - 1)) % entries.length;
          onChange(entries[next]); track.current?.querySelector<HTMLButtonElement>(`#toolbox-category-${next}`)?.focus();
        }}>{label}<small>{label === "全部" ? groups.reduce((n, g) => n + g.items.length, 0) : groups.find(g => g.label === label)!.items.length}</small></button>)}
    </div>
    <button type="button" className={styles.navArrow} aria-label="查看后面的分类" disabled={edges.end} onClick={() => scroll(1)}><ChevronRight size={16} /></button>
  </nav>;
}
