/**
 * ToolboxView.tsx — 「工具」模式主体区（D15 → P1 → T2）。
 *
 * P1：hero 双卡 / 筛选 / kbd / chev / 分组计数。
 * T2：分类 chips、Ctrl+F|`/` 聚焦、Enter 跑第一命中、最近用过一行、
 *     高频「常用」pin、按压 scale（CSS）、禁用 title 说清原因。
 *
 * 条目仍只来自 TOOLBOX_GROUPS；使用痕迹在 lib/toolboxUsage（只存 key）。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  TOOLBOX_GROUPS,
  filterGroupsByCategory,
  filterToolItems,
  toolboxCategoryLabels,
  toolsByKeys,
  type ToolHandlers,
  type ToolItem,
  type ToolKey,
} from "@/lib/toolbox";
import {
  bumpUsage,
  loadRecent,
  loadUsage,
  pinnedKeys,
  pushRecent,
  saveRecent,
  saveUsage,
} from "@/lib/toolboxUsage";
import styles from "./ToolboxView.module.css";

function ToolCard({
  tool,
  enabled,
  hero,
  pinned,
  onRun,
}: {
  tool: ToolItem;
  enabled: boolean;
  hero?: boolean;
  pinned?: boolean;
  onRun: () => void;
}) {
  return (
    <button
      type="button"
      className={hero ? styles.heroCard : styles.item}
      onClick={onRun}
      disabled={!enabled}
      title={
        enabled
          ? tool.desc
          : `${tool.name}：当前环境不可用——请先在设置中完成相关配置`
      }
    >
      <span className={styles.tile} data-hue={tool.hue} aria-hidden="true">
        {tool.icon}
      </span>
      <span className={styles.text}>
        <span className={styles.nameRow}>
          <span className={styles.name}>{tool.name}</span>
          {pinned ? <span className={styles.pin}>常用</span> : null}
          {tool.shortcut ? <kbd className={styles.kbd}>{tool.shortcut}</kbd> : null}
        </span>
        <span className={styles.desc}>{tool.desc}</span>
      </span>
      <span className={styles.chev} aria-hidden="true">
        ›
      </span>
    </button>
  );
}

export function ToolboxView({ handlers }: { handlers: ToolHandlers }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [recentKeys, setRecentKeys] = useState<ToolKey[]>(() => loadRecent());
  const [usage, setUsage] = useState(() => loadUsage());
  const searchRef = useRef<HTMLInputElement>(null);
  const q = query.trim();
  const cats = useMemo(() => toolboxCategoryLabels(), []);
  const pinned = useMemo(() => new Set(pinnedKeys(usage)), [usage]);

  /** Ctrl+F / `/` 聚焦筛选（与设置页同一心智；组件只在工具模式挂载） */
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (e.key === "/" && !inField && !mod) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const scopedGroups = useMemo(
    () => filterGroupsByCategory(TOOLBOX_GROUPS, category),
    [category],
  );

  const heroes = useMemo(
    () =>
      scopedGroups
        .flatMap((g) => g.items)
        .filter((t) => t.hero && filterToolItems([t], q).length > 0),
    [scopedGroups, q],
  );

  const groups = useMemo(
    () =>
      scopedGroups
        .map((g) => ({
          ...g,
          items: filterToolItems(g.items, q).filter((t) => !t.hero),
        }))
        .filter((g) => g.items.length > 0),
    [scopedGroups, q],
  );

  /** Enter 跑第一命中：hero 优先，再按分组顺序 */
  const firstHit = useMemo(
    () => heroes[0] ?? groups[0]?.items[0] ?? null,
    [heroes, groups],
  );

  const matched = useMemo(
    () => groups.reduce((n, g) => n + g.items.length, 0) + heroes.length,
    [groups, heroes],
  );

  /** 最近用过：有搜索词时藏起来，避免和命中结果抢注意力 */
  const recentTools = useMemo(
    () => (q ? [] : toolsByKeys(recentKeys)),
    [q, recentKeys],
  );

  const runTool = (tool: ToolItem) => {
    if (!handlers[tool.key]) return;
    const nextRecent = pushRecent(recentKeys, tool.key);
    setRecentKeys(nextRecent);
    saveRecent(nextRecent);
    const nextUsage = bumpUsage(usage, tool.key);
    setUsage(nextUsage);
    saveUsage(nextUsage);
    handlers[tool.key]?.();
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (firstHit && handlers[firstHit.key]) runTool(firstHit);
  };

  const card = (tool: ToolItem, hero?: boolean) => (
    <ToolCard
      key={tool.key}
      tool={tool}
      hero={hero}
      pinned={pinned.has(tool.key)}
      enabled={!!handlers[tool.key]}
      onRun={() => runTool(tool)}
    />
  );

  return (
    <div className={styles.wrap}>
      <div className={styles.searchWrap}>
        <input
          ref={searchRef}
          className={styles.search}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="筛选工具…  Ctrl+F"
          aria-label="筛选工具"
        />
        <div className={styles.chips} role="group" aria-label="工具分类">
          {cats.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={category === c}
              className={
                category === c ? `${styles.chip} ${styles.chipOn}` : styles.chip
              }
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {heroes.length === 0 && groups.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>
            {q ? `没有匹配「${q}」的工具` : `「${category}」下暂无工具`}
          </p>
          <p className={styles.emptyDesc}>试试名称、用途，或快捷键关键词。</p>
          <button
            type="button"
            className={styles.clearBtn}
            onClick={() => {
              setQuery("");
              setCategory("全部");
            }}
          >
            清除筛选
          </button>
        </div>
      ) : (
        <>
          {recentTools.length > 0 && (
            <>
              <div className={styles.section}>
                最近用过
                <span className={styles.cnt}>{recentTools.length}</span>
              </div>
              <div className={styles.recent} role="list">
                {recentTools.map((tool) => (
                  <button
                    key={tool.key}
                    type="button"
                    role="listitem"
                    className={styles.recentChip}
                    disabled={!handlers[tool.key]}
                    title={tool.desc}
                    onClick={() => runTool(tool)}
                  >
                    <span aria-hidden="true">{tool.icon}</span>
                    {tool.name}
                  </button>
                ))}
              </div>
            </>
          )}

          {heroes.length > 0 && (
            <>
              <div className={styles.section}>
                高频
                <span className={styles.cnt}>{heroes.length}</span>
              </div>
              <div className={styles.hero}>{heroes.map((t) => card(t, true))}</div>
            </>
          )}

          {groups.map((group) => (
            <div key={group.label}>
              <div className={styles.section}>
                {group.label}
                <span className={styles.cnt}>{group.items.length}</span>
                {q ? <span className={styles.secTotal}>匹配 {matched}</span> : null}
              </div>
              <div className={styles.grid}>
                {group.items.map((t) => card(t))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
