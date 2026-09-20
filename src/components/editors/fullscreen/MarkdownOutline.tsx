/**
 * Markdown 大纲（目录）侧栏。
 *
 * 为什么自己扫而不复用预览的 DOM：大纲在**仅编辑**模式下也得能用，
 * 而那时候预览根本没渲染。直接从源文扫标题，两种模式一致。
 *
 * slug 与 MarkdownRenderer 的 heading id 同源（`lib/markdown/headingSlug`），
 * 否则仅预览/分屏时按 id 找预览节点会对不上。
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { assignUniqueSlugs } from "@/lib/markdown/headingSlug";
import styles from "./MarkdownOutline.module.css";

export interface OutlineHeading {
  /** 1~6 */
  level: number;
  text: string;
  /** 1 基的行号，直接喂给 CodeMirror 的 doc.line() */
  line: number;
  /** 与预览 heading id 一致的唯一 slug */
  slug: string;
}

/**
 * 从 Markdown 源文扫出标题（含 slug）。
 *
 * ❌ 必须跳过围栏代码块：代码里的 `# 注释` / shell 提示符满地都是，
 * 不跳的话一份写满 bash 片段的文档大纲里全是垃圾。
 * 同时支持 ``` 与 ~~~ 两种围栏，且收尾围栏长度要 ≥ 开头（CommonMark 规则）。
 */
export function scanHeadings(src: string): OutlineHeading[] {
  const raw: Array<{ level: number; text: string; line: number }> = [];
  const lines = src.split("\n");
  let fence: { ch: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      const ch = f[1][0];
      const len = f[1].length;
      if (!fence) {
        fence = { ch, len };
        continue;
      }
      // 同类型且不短于开头的围栏才算收尾
      if (ch === fence.ch && len >= fence.len) fence = null;
      continue;
    }
    if (fence) continue;
    // ATX 标题：最多 3 个前导空格，# 后必须有空白（排掉 `#hashtag`）
    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (!h) continue;
    const text = h[2]
      .replace(/\s+#+\s*$/, "") // 去掉尾部闭合的 ###
      .trim();
    if (!text) continue;
    raw.push({ level: h[1].length, text, line: i + 1 });
  }
  return assignUniqueSlugs(raw).map((h, i) => ({ ...h, line: raw[i].line }));
}

interface Props {
  text: string;
  /** 跳转到某条标题（行号 + slug，宿主按视图模式分派） */
  onJump: (heading: OutlineHeading) => void;
}

/** 按压反馈时长（U2 快档） */
const PRESS_MS = 150;

export function MarkdownOutline({ text, onJump }: Props) {
  const headings = useMemo(() => scanHeadings(text), [text]);
  /** 点选态：与触发同一可见性域（规则 15），否则用户以为点了没反应 */
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  /** 刚点过的项：加 .itemPress 做 150ms 轻压，到点移除防连点堆积 */
  const [pressSlug, setPressSlug] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  /** 指示条几何：top/height 过渡 200ms（U2 标准档） */
  const [ind, setInd] = useState<{ top: number; height: number; on: boolean }>({
    top: 0,
    height: 0,
    on: false,
  });

  // 指示条跟随选中项：测量 offsetTop，避免每帧读布局
  useLayoutEffect(() => {
    if (!activeSlug) {
      setInd((p) => (p.on ? { ...p, on: false } : p));
      return;
    }
    const list = listRef.current;
    const el = itemRefs.current.get(activeSlug);
    if (!list || !el) return;
    const top = el.offsetTop + 4;
    const height = Math.max(18, el.offsetHeight - 8);
    setInd({ top, height, on: true });
  }, [activeSlug, headings]);

  return (
    <div className={styles.panel}>
      <div className={styles.head}>大纲 · {headings.length}</div>
      {headings.length === 0 ? (
        <div className={styles.empty}>还没有标题。用 # 开头写一行就会出现在这里。</div>
      ) : (
        <div className={styles.list} ref={listRef}>
          <div
            className={`${styles.indicator}${ind.on ? ` ${styles.indicatorOn}` : ""}`}
            style={{ top: ind.top, height: ind.height }}
            aria-hidden
          />
          {headings.map((h) => (
            <button
              // 行号做 key：标题文本会重复（很多文档有多个「示例」），用文本会撞 key
              key={h.line}
              type="button"
              ref={(el) => {
                if (el) itemRefs.current.set(h.slug, el);
                else itemRefs.current.delete(h.slug);
              }}
              className={`${styles.item} ${styles[`lv${h.level}`]}${
                activeSlug === h.slug ? ` ${styles.itemActive}` : ""
              }${pressSlug === h.slug ? ` ${styles.itemPress}` : ""}`}
              onClick={() => {
                setActiveSlug(h.slug);
                setPressSlug(h.slug);
                window.setTimeout(() => {
                  setPressSlug((cur) => (cur === h.slug ? null : cur));
                }, PRESS_MS);
                onJump(h);
              }}
              title={h.text}
            >
              {h.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
