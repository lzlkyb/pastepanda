import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAppStore } from "@/stores/appStore";
import { parseSearchQuery } from "@/lib/searchQuery";
import { semanticSearch } from "@/lib/api/semantic";
import { X } from "lucide-react";
import styles from "./TopBar.module.css";

export function SearchBox({ fill }: { fill?: boolean } = {}) {
  const setSearchKeyword = useAppStore((s) => s.setSearchKeyword);
  const searchHistory = useAppStore((s) => s.searchHistory);
  const addSearchHistory = useAppStore((s) => s.addSearchHistory);
  const removeSearchHistory = useAppStore((s) => s.removeSearchHistory);
  const clearSearchHistory = useAppStore((s) => s.clearSearchHistory);
  const theme = useAppStore((s) => s.config.theme);

  const [focused, setFocused] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // 非受控模式：清除按钮可见性用 ref 驱动，避免长按期间 state 更新
  const searchBoxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const clearBtnRef = useRef<HTMLButtonElement>(null);
  const debounceTimerRef = useRef<number | null>(null);

  // 更新清除按钮可见性（纯 DOM 操作，不触发 React 渲染）
  const updateClearBtn = useCallback(() => {
    if (clearBtnRef.current) {
      clearBtnRef.current.style.display = inputRef.current?.value ? "" : "none";
    }
  }, []);

  // 同步 store 外部变更（如搜索历史点击）到 input DOM
  // 仅当 store 值与 DOM 值不同时才同步，避免防抖回写覆盖光标位置
  useEffect(() => {
    return useAppStore.subscribe(
      (state, prevState) => {
        if (
          state.searchKeyword !== prevState.searchKeyword &&
          inputRef.current &&
          inputRef.current.value !== state.searchKeyword
        ) {
          inputRef.current.value = state.searchKeyword;
          updateClearBtn();
        }
      },
    );
  }, [updateClearBtn]);

  // 点击外部关闭搜索历史下拉
  useEffect(() => {
    if (!showHistory) return;
    const handler = (e: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setShowHistory(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showHistory]);

  // 防抖写入 store
  const scheduleSearch = useCallback((value: string) => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    if (!value) {
      setSearchKeyword("");
      useAppStore.getState().setSemanticHits([]);
      return;
    }
    debounceTimerRef.current = window.setTimeout(() => {
      // v6.4 NL 搜索：句首时间词（上周/今天/本月…）→ 顺带设置时间过滤，关键词原样保留
      const parsed = parseSearchQuery(value);
      if (parsed.timeFilter !== "all") {
        useAppStore.getState().setTimeFilter(parsed.timeFilter);
      }
      setSearchKeyword(parsed.keyword);
      // M5-2 语义搜索：失败（未开启/厂商不支持/预算）静默，自动退回关键词
      const kw = parsed.keyword.trim();
      if (kw) {
        void semanticSearch(kw, 6)
          .then((hits) => useAppStore.getState().setSemanticHits(hits))
          .catch(() => useAppStore.getState().setSemanticHits([]));
      } else {
        useAppStore.getState().setSemanticHits([]);
      }
    }, 200);
  }, [setSearchKeyword]);

  const handleSearchSubmit = useCallback((kw: string) => {
    if (inputRef.current) {
      inputRef.current.value = kw;
    }
    updateClearBtn();
    // 回车搜索不需要防抖，立即生效
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    // v6.4 NL 搜索：句首时间词解析（回车同样生效）
    const parsed = parseSearchQuery(kw);
    if (parsed.timeFilter !== "all") {
      useAppStore.getState().setTimeFilter(parsed.timeFilter);
    }
    setSearchKeyword(parsed.keyword);
    // M5-2 语义搜索（回车同路径）
    const semKw = parsed.keyword.trim();
    if (semKw) {
      void semanticSearch(semKw, 6)
        .then((hits) => useAppStore.getState().setSemanticHits(hits))
        .catch(() => useAppStore.getState().setSemanticHits([]));
    } else {
      useAppStore.getState().setSemanticHits([]);
    }
    if (kw) {
      addSearchHistory(kw);
    }
    setShowHistory(false);
  }, [setSearchKeyword, addSearchHistory, updateClearBtn]);

  return (
    <div
      ref={searchBoxRef}
      className={`${styles.searchBox}${fill ? ` ${styles.searchBoxFill}` : ""}${focused ? ` ${styles.focused}` : ""}${showHistory ? ` ${styles.hasHistory}` : ""}`}
      data-tauri-drag-region="false"
      style={{ position: "relative" }}
    >
      <span className={styles.searchIcon}>{theme === "blossom" ? "💗" : "🔍"}</span>
      <input
        ref={inputRef}
        type="text"
        defaultValue={useAppStore.getState().searchKeyword}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          updateClearBtn();
          // 审查：非空时收起历史下拉（此前只处理空值显示，输入关键词时下拉一直悬浮遮挡）
          setShowHistory(searchHistory.length > 0 && !v);
          scheduleSearch(v);
        }}
        onFocus={() => {
          setFocused(true);
          const v = inputRef.current?.value || "";
          setShowHistory(searchHistory.length > 0 && !v);
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            handleSearchSubmit((e.target as HTMLInputElement).value);
          }
        }}
        placeholder="搜索剪贴板...（输入即搜）"
        className={styles.searchInput}
        aria-label="搜索剪贴板内容"
        aria-description="支持拼音首字母搜索"
      />
      <button
        ref={clearBtnRef}
        style={{ display: inputRef.current?.value ? "" : "none" }}
        onClick={() => {
          if (inputRef.current) inputRef.current.value = "";
          updateClearBtn();
          if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
          setSearchKeyword("");
          useAppStore.getState().setSemanticHits([]);
          setShowHistory(searchHistory.length > 0);
        }}
        className={styles.searchClear}
      >
        <X size={12} />
      </button>
      <AnimatePresence>
        {showHistory && searchHistory.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 500, damping: 35 }}
            className={styles.searchHistoryDropdown}
          >
            <div className={styles.searchHistoryHeader}>
              <span>最近搜索</span>
              <button
                onClick={(e) => { e.stopPropagation(); clearSearchHistory(); setShowHistory(false); }}
                className={styles.searchHistoryClearAll}
              >
                清除全部
              </button>
            </div>
            {searchHistory.map((kw, i) => (
              <div
                key={i}
                className={styles.searchHistoryItem}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleSearchSubmit(kw);
                }}
              >
                <span className={styles.searchHistoryItemIcon}>🕐</span>
                <span className={styles.searchHistoryText}>{kw}</span>
                <button
                  className={styles.searchHistoryRemove}
                  onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); removeSearchHistory(kw); }}
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
