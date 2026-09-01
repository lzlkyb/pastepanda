/**
 * 字段视图的控件（B2 #9）：搜索行右侧三个小图标 + 浮层，下方一行 chips。
 *
 * **默认态零新增行高**：图标塞在已有的搜索行里，chips 行只在非默认时才渲染。
 * 现有注释自己写着「480px 宽的窗口里多一行就少两条笔记」。
 *
 * 浮层用**绝对定位而不是 portal**：查过 `KnowledgeView.module.css`——
 * `.searchRow` 已经是 `position: relative`，且从它到中栏根**没有任何 `overflow: hidden`**
 * （唯一的 `overflow-y: auto` 在下方列表那个兄弟节点上），所以浮层不会被裁。
 * portal + fixed 还得自己测位置（同 DeepCleanDialog 里那套），这里不需要。
 *
 * 两个面板（知识库 / 待沉淀区）共用本件：图标 + 浮层 + 关外部点击 + ESC
 * 这套行为写两份必定漏一条（规则 #11）。维度不同的部分靠 props 传。
 *
 * 🔴 红线：纯展示层，无 AI、不联网。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpDown, Rows3, SlidersHorizontal, X } from "lucide-react";
import type { Tri, ViewChip, ViewOption } from "@/lib/notes/viewOpts";
import styles from "./ViewControls.module.css";

/** 一个单选菜单的规格。 */
export interface MenuSpec {
  options: ViewOption[];
  value: string;
  onChange: (v: string) => void;
}

interface Props {
  sort: MenuSpec;
  group: MenuSpec;
  /** 筛选浮层的内容。两个面板的可筛字段完全不同，所以由调用方拼。 */
  filterPanel: React.ReactNode;
  /** 筛选是否已生效（控图标高亮）。 */
  filterActive: boolean;
}

/** 当前打开的是哪个浮层。 */
type Open = null | "sort" | "group" | "filter";

export function ViewControls({ sort, group, filterPanel, filterActive }: Props) {
  const [open, setOpen] = useState<Open>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点外面 / 敲 ESC 关浮层。mousedown 而不是 click：
  // 用 click 时，在列表上按住拖选再松手也会算一次外部点击，体验上反应滞后。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = useCallback((which: Exclude<Open, null>) => {
    setOpen((cur) => (cur === which ? null : which));
  }, []);

  const menu = (spec: MenuSpec, which: Exclude<Open, null>) => (
    <div className={styles.pop} role="menu">
      {spec.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="menuitemradio"
          aria-checked={spec.value === o.value}
          className={`${styles.popItem}${spec.value === o.value ? ` ${styles.popOn}` : ""}`}
          onClick={() => {
            spec.onChange(o.value);
            setOpen(null);
            void which;
          }}
        >
          <span>{o.label}</span>
          {o.hint && <span className={styles.popHint}>{o.hint}</span>}
        </button>
      ))}
    </div>
  );

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={`${styles.icon}${sort.value ? ` ${styles.iconOn}` : ""}`}
        title="排序"
        aria-label="排序"
        aria-expanded={open === "sort"}
        onClick={() => toggle("sort")}
      >
        <ArrowUpDown size={13} />
      </button>
      <button
        type="button"
        className={`${styles.icon}${group.value ? ` ${styles.iconOn}` : ""}`}
        title="分组"
        aria-label="分组"
        aria-expanded={open === "group"}
        onClick={() => toggle("group")}
      >
        <Rows3 size={13} />
      </button>
      <button
        type="button"
        className={`${styles.icon}${filterActive ? ` ${styles.iconOn}` : ""}`}
        title="筛选"
        aria-label="筛选"
        aria-expanded={open === "filter"}
        onClick={() => toggle("filter")}
      >
        <SlidersHorizontal size={13} />
      </button>

      {open === "sort" && menu(sort, "sort")}
      {open === "group" && menu(group, "group")}
      {open === "filter" && (
        <div className={`${styles.pop} ${styles.popWide}`}>{filterPanel}</div>
      )}
    </div>
  );
}

/**
 * 已生效选项的 chips 行。**chips 为空时不渲染任何东西**（连容器都不出），
 * 所以默认态不占任何高度。
 */
export function ViewChips({
  chips,
  onClearAll,
}: {
  chips: ViewChip[];
  onClearAll: () => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className={styles.chipRow}>
      {chips.map((c, i) => (
        <button
          key={`${c.label}-${i}`}
          type="button"
          className={styles.chip}
          onClick={c.onClear}
          title="去掉这个条件"
        >
          {c.label}
          <X size={10} />
        </button>
      ))}
      <button type="button" className={styles.clearAll} onClick={onClearAll}>
        全部清除
      </button>
    </div>
  );
}

/**
 * 三态筛选的一行（不筛 / 是 / 否）。两个面板的筛选浮层都用它。
 *
 * 三个按钮而不是一个循环切换的开关：循环切换里用户看不出现在是哪一态，
 * 也无法一步回到「不筛」。
 */
export function TriRow({
  label,
  value,
  yesText,
  noText,
  onChange,
}: {
  label: string;
  value: Tri;
  yesText: string;
  noText: string;
  onChange: (v: Tri) => void;
}) {
  const opts: { v: Tri; t: string }[] = [
    { v: "", t: "不筛" },
    { v: "yes", t: yesText },
    { v: "no", t: noText },
  ];
  return (
    <div className={styles.triRow}>
      <span className={styles.triLabel}>{label}</span>
      <div className={styles.triBtns}>
        {opts.map((o) => (
          <button
            key={o.v}
            type="button"
            className={`${styles.triBtn}${value === o.v ? ` ${styles.triOn}` : ""}`}
            onClick={() => onChange(o.v)}
          >
            {o.t}
          </button>
        ))}
      </div>
    </div>
  );
}
