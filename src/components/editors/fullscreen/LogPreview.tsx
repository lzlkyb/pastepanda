/**
 * 日志视图（D 方案 A · 徽章流）：全屏编辑器 log 类型的预览面板。
 * - 顶部级别芯片（带计数）点选过滤 + 搜索框实时筛选；
 * - 每行 [时间 · 级别徽章 · 消息] 等宽对齐，WARN/ERROR 整行着色 + 左侧色条；
 * - 无时间戳前缀的续行（堆栈）缩进归属上一条。
 * 解析走 lib/logParser（与 Rust 分类器同源正则）。
 */
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { parseLog, filterEntries, LEVEL_ORDER, type LogLevel } from "@/lib/logParser";
import styles from "../FullscreenEditor.module.css";

export function LogPreview({ text }: { text: string }) {
  /** null = 全部级别 */
  const [active, setActive] = useState<Set<LogLevel> | null>(null);
  const [keyword, setKeyword] = useState("");

  const parsed = useMemo(() => parseLog(text), [text]);
  const filtered = useMemo(
    () => filterEntries(parsed.entries, active, keyword),
    [parsed, active, keyword]
  );

  const toggleLevel = (lv: LogLevel) => {
    setActive((prev) => {
      if (!prev) return new Set([lv]);
      const next = new Set(prev);
      if (next.has(lv)) next.delete(lv);
      else next.add(lv);
      return next.size === 0 ? null : next;
    });
  };

  if (parsed.entries.length === 0) {
    return (
      <div className={styles.logEmpty}>
        未识别到日志行 — 可切换「编辑源码」视图查看原文
      </div>
    );
  }

  return (
    <div className={styles.logWrap}>
      {/* 过滤工具条 */}
      <div className={styles.logBar}>
        <button
          className={`${styles.lvChip} ${active === null ? styles.lvOn : ""}`}
          onClick={() => setActive(null)}
        >
          全部 <span className={styles.lvCnt}>{parsed.entries.length}</span>
        </button>
        {LEVEL_ORDER.filter((lv) => parsed.counts[lv]).map((lv) => (
          <button
            key={lv}
            className={`${styles.lvChip} ${active?.has(lv) ? styles.lvOn : ""}`}
            onClick={() => toggleLevel(lv)}
          >
            <span className={`${styles.lvDot} ${styles["lvDot" + lv]}`} />
            {lv} <span className={styles.lvCnt}>{parsed.counts[lv]}</span>
          </button>
        ))}
        <div className={styles.logSearch}>
          <Search size={12} />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索日志内容…"
            spellCheck={false}
          />
        </div>
        <span className={styles.logCount}>
          {filtered.length} / {parsed.entries.length} 条
        </span>
      </div>

      {/* 日志流 */}
      <div className={styles.logBody}>
        {filtered.map((e, i) => (
          <div key={i}>
            <div
              className={`${styles.logRow}${e.level === "WARN" ? ` ${styles.logWarn}` : ""}${
                e.level === "ERROR" || e.level === "FATAL" ? ` ${styles.logError}` : ""
              }`}
            >
              <span className={styles.logTime}>{e.time ?? ""}</span>
              {e.level ? (
                <span className={`${styles.logBadge} ${styles["logB" + e.level]}`}>{e.level}</span>
              ) : (
                <span className={styles.logBadgeGap} />
              )}
              <span className={styles.logMsg}>{e.msg}</span>
            </div>
            {e.cont.map((c, j) => (
              <div key={j} className={styles.logCont}>{c}</div>
            ))}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className={styles.logEmpty}>当前过滤条件下无匹配条目</div>
        )}
      </div>
    </div>
  );
}
