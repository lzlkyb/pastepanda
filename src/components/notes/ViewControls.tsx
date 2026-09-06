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
import { useCallback, useRef, useState } from "react";
import { ArrowUpDown, Rows3, SlidersHorizontal, X } from "lucide-react";
import type { Tri, ViewChip, ViewOption } from "@/lib/notes/viewOpts";
import { TagBadge } from "@/components/TagBadge";
import type { Tag } from "@/stores/appStore";
import styles from "./ViewControls.module.css";
import { useClickOutside } from "@/hooks/useClickOutside";
import { useDialogEscape } from "@/hooks/useDialogEscape";

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

  // 点外面 / 敲 Esc 关浮层，两者均走公共 hook（规则 #11）。
  //
  // ❗ Esc 走 `useDialogEscape` 而不是自己监：它是捕获期 + stopPropagation。
  //   原先的冒泡监听不阻断，关掉浮层的同时 App 那条全局 Esc 链还会接着跑（
  //   清多选、甚至隐藏整个窗口）——用户只想关个下拉。
  const closeMenu = useCallback(() => setOpen(null), []);
  useClickOutside(wrapRef, closeMenu, open !== null);
  useDialogEscape(closeMenu, open !== null);

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
 * 标签多选行（A1）。放在**现有的筛选浮层里**，不另开一个工具栏图标：
 * 标签本来就是一个筛选维度，而那一排图标已经有三个了。
 *
 * ❗ 多标签是 **AND**（必须全部命中）——后端 `push_note_filters` 就是这个口径，
 *   与记录模式的卡片筛选一致。并集会让「选了更多条件反而结果更多」。
 *
 * 用 `TagBadge` 的 `picker` 变体而不自己画：它是全应用唯一的标签渲染点（规则 #11），
 * 自己画一份就会丢掉颜色派生与 `source='auto'` 的🤖标识。
 */
export function TagPickRow({
  allTags,
  selected,
  onToggle,
}: {
  allTags: Tag[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  if (allTags.length === 0) {
    return (
      <div className={styles.triRow}>
        <span className={styles.triLabel}>标签</span>
        <span className={styles.tagEmpty}>还没有标签</span>
      </div>
    );
  }
  return (
    <div className={styles.tagRow}>
      <span className={styles.triLabel}>标签</span>
      {/* 限高 + 自己滚：标签多了会把整个筛选浮层顶到屏幕外 */}
      <div className={styles.tagList}>
        {allTags.map((t) => (
          <TagBadge
            key={t.id}
            tag={t}
            variant="picker"
            active={selected.includes(t.id)}
            onClick={() => onToggle(t.id)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 单选一行（N 个互斥选项）。给时间范围这种“不只三态”的筛选用（B4）。
 *
 * 不把 `TriRow` 改成通用的：那个名字与 `Tri` 类型强绑（它的 `yesText`/`noText`
 * 就是三态语义），改成泛型反而让调用处多一层拼选项的噪声。两个小组件更直白。
 */
export function PickRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ViewOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className={styles.triRow}>
      <span className={styles.triLabel}>{label}</span>
      <div className={styles.triBtns}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`${styles.triBtn}${value === o.value ? ` ${styles.triOn}` : ""}`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
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
