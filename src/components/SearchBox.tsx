import { CONTENT_TRANSITION } from "@/lib/motion";
import { primaryModifierHeld, primarySearchShortcut } from "@/lib/utils";
import { blocksPageShortcuts, isConfirmLayerPresent } from "@/lib/modalLayers";
import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAppStore } from "@/stores/appStore";
import { parseSearchQuery } from "@/lib/searchQuery";
import { semanticSearch } from "@/lib/api/semantic";
import { isAiAvailable } from "@/lib/transforms/aiTransforms";
import { X } from "lucide-react";
import styles from "./TopBar.module.css";
import { useClickOutside } from "@/hooks/useClickOutside";

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
  useEffect(() => {
    const onFind = (event: KeyboardEvent) => {
      if (!primaryModifierHeld(event) || event.key.toLowerCase() !== "f" ||
          event.shiftKey || event.altKey || event.isComposing || blocksPageShortcuts() || isConfirmLayerPresent()) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, []);

  const clearBtnRef = useRef<HTMLButtonElement>(null);
  const debounceTimerRef = useRef<number | null>(null);
  const searchGeneration = useRef(0);
  const applyingSearch = useRef(false);
  useEffect(() => () => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    searchGeneration.current++;
  }, []);

  // Every input invalidates the old request, including the debounce window and clear.
  const applySearch = useCallback((value: string, generation: number) => {
    const parsed = parseSearchQuery(value);
    if (parsed.timeFilter !== "all") useAppStore.getState().setTimeFilter(parsed.timeFilter);
    applyingSearch.current = true;
    setSearchKeyword(parsed.keyword);
    applyingSearch.current = false;
    useAppStore.getState().setSemanticHits([]);
    const kw = parsed.keyword.trim();
    if (!kw || !isAiAvailable()) return;
    void semanticSearch(kw, 6).then(hits => {
      if (generation === searchGeneration.current && isAiAvailable()) useAppStore.getState().setSemanticHits(hits);
    }).catch(() => {
      if (generation === searchGeneration.current) useAppStore.getState().setSemanticHits([]);
    });
  }, [setSearchKeyword]);

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
        if (state.searchKeyword !== prevState.searchKeyword && !applyingSearch.current) {
          if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
          searchGeneration.current++;
          useAppStore.getState().setSemanticHits([]);
        }
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
  const hideHistory = useCallback(() => setShowHistory(false), []);
  useClickOutside(searchBoxRef, hideHistory, showHistory);

  // 防抖写入 store
  const scheduleSearch = useCallback((value: string) => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    const generation = ++searchGeneration.current;
    useAppStore.getState().setSemanticHits([]);
    if (!value) {
      applySearch("", generation);
      return;
    }
    debounceTimerRef.current = window.setTimeout(() => applySearch(value, generation), 200);
  }, [applySearch]);

  const handleSearchSubmit = useCallback((kw: string) => {
    if (inputRef.current) {
      inputRef.current.value = kw;
    }
    updateClearBtn();
    // 回车搜索不需要防抖，立即生效
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    applySearch(kw, ++searchGeneration.current);
    if (kw) {
      addSearchHistory(kw);
    }
    setShowHistory(false);
  }, [applySearch, addSearchHistory, updateClearBtn]);

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
          if (!(e.nativeEvent as InputEvent).isComposing) scheduleSearch(v);
        }}
        onCompositionStart={() => {
          if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
          searchGeneration.current++;
        }}
        onCompositionEnd={(e) => scheduleSearch(e.currentTarget.value)}
        onFocus={() => {
          setFocused(true);
          const v = inputRef.current?.value || "";
          setShowHistory(searchHistory.length > 0 && !v);
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            handleSearchSubmit((e.target as HTMLInputElement).value);
          }
        }}
        placeholder={`搜索剪贴板…  ${primarySearchShortcut()}`}
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
          applySearch("", ++searchGeneration.current);
          setShowHistory(searchHistory.length > 0);
          inputRef.current?.focus();
        }}
        className={styles.searchClear}
        aria-label="清空搜索"
      >
        <X size={12} />
      </button>
      <AnimatePresence>
        {showHistory && searchHistory.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -3, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -3, scale: 0.99 }}
            transition={CONTENT_TRANSITION}
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
            {/* 一行 = 两个并列的 button，而不是「整行 button 里嵌删除 button」：
                后者是无效 HTML（交互元素不能嵌套），浏览器会自己拆成兄弟节点，
                实际渲染结构跟代码对不上。原来整行是 <div onMouseDown>，键盘根本选不中。 */}
            {searchHistory.map((kw, i) => (
              <div key={i} className={styles.searchHistoryItem}>
                {/* preventDefault 必须保留：它拦的是「按下时搜索框失焦」，
                    不拦则点一下历史项输入框会先掉焦点闪一下；真正的搜索动作改为 onClick，
                    因为键盘按 Enter/Space 发的是 click、不是 mousedown。 */}
                <button
                  type="button"
                  className={styles.searchHistoryMain}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => handleSearchSubmit(kw)}
                >
                  <span className={styles.searchHistoryItemIcon} aria-hidden="true">🕐</span>
                  <span className={styles.searchHistoryText}>{kw}</span>
                </button>
                <button
                  type="button"
                  className={styles.searchHistoryRemove}
                  aria-label={`删除搜索记录 ${kw}`}
                  onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                  onClick={(e) => { e.stopPropagation(); removeSearchHistory(kw); }}
                >
                  <X size={10} aria-hidden="true" />
                </button>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
