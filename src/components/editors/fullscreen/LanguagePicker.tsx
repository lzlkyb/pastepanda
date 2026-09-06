/**
 * 代码语言选择器（工具栏 pill + 下拉弹层）。
 * 默认展示精选列表（后端可识别的 10 种语言 + 4 种配置格式 + 纯文本），
 * 输入搜索时在全量 language-data（130+ 语言）中按名称/别名过滤。
 */
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { ChevronDown, Search, Check } from "lucide-react";
import { languages } from "@codemirror/language-data";
import { COMMON_CODE_LANGS, COMMON_CONFIG_FMTS, LANG_COLORS } from "./languages";
import styles from "../FullscreenEditor.module.css";
import { useClickOutside } from "@/hooks/useClickOutside";

export function LanguagePicker({ value, onChange }: {
  value: string | null;
  onChange: (name: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 点击外部关闭
  const closePicker = useCallback(() => setOpen(false), []);
  useClickOutside(rootRef, closePicker, open);

  // 打开时清空搜索并聚焦输入框
  useEffect(() => {
    if (open) {
      setQuery("");
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  const pick = (name: string | null) => {
    onChange(name);
    setOpen(false);
  };

  // 搜索：全量 language-data 按名称/别名过滤（上限 40 条）
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return languages
      .filter((l) =>
        l.name.toLowerCase().includes(q) ||
        (l.alias ?? []).some((a) => a.toLowerCase().includes(q))
      )
      .slice(0, 40);
  }, [query]);

  const dotColor = (name: string | null) =>
    (name && LANG_COLORS[name]) || "var(--text-muted)";

  const renderItem = (name: string | null, label: string) => (
    <button
      key={name ?? "__plain"}
      className={`${styles.langItem} ${value === name ? styles.langItemActive : ""}`}
      onClick={() => pick(name)}
    >
      <span className={styles.langDot} style={{ background: dotColor(name) }} />
      <span className={styles.langName}>{label}</span>
      {value === name && <Check size={11} className={styles.langCheck} />}
    </button>
  );

  return (
    <div className={styles.langPicker} ref={rootRef}>
      <button
        className={`${styles.langPill} ${open ? styles.langPillOpen : ""}`}
        onClick={() => setOpen(!open)}
        title="切换代码语言"
      >
        <span className={styles.langDot} style={{ background: dotColor(value) }} />
        <span>{value ?? "纯文本"}</span>
        <ChevronDown size={11} />
      </button>

      {open && (
        <div className={styles.langPop}>
          <div className={styles.langSearch}>
            <Search size={11} />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
              placeholder="搜索 130+ 语言…"
            />
          </div>
          <div className={styles.langList}>
            {query.trim() ? (
              searchResults.length > 0 ? (
                searchResults.map((l) => renderItem(l.name, l.name))
              ) : (
                <div className={styles.langEmpty}>无匹配语言</div>
              )
            ) : (
              <>
                <div className={styles.langGroup}>常用语言</div>
                {COMMON_CODE_LANGS.map((n) => renderItem(n, n))}
                <div className={styles.langGroup}>配置格式</div>
                {COMMON_CONFIG_FMTS.map((n) => renderItem(n, n))}
                <div className={styles.langGroup}>其他</div>
                {renderItem(null, "纯文本")}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
