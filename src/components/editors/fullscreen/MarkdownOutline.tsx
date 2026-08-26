/**
 * Markdown 大纲（目录）侧栏。
 *
 * 为什么自己扫而不复用预览的 DOM：大纲在**仅编辑**模式下也得能用，
 * 而那时候预览根本没渲染。直接从源文扫标题，两种模式一致。
 */

import { useMemo } from "react";
import styles from "./MarkdownOutline.module.css";

interface Heading {
  /** 1~6 */
  level: number;
  text: string;
  /** 1 基的行号，直接喂给 CodeMirror 的 doc.line() */
  line: number;
}

/**
 * 从 Markdown 源文扫出标题。
 *
 * ❌ 必须跳过围栏代码块：代码里的 `# 注释` / shell 提示符满地都是，
 * 不跳的话一份写满 bash 片段的文档大纲里全是垃圾。
 * 同时支持 ``` 与 ~~~ 两种围栏，且收尾围栏长度要 ≥ 开头（CommonMark 规则）。
 */
export function scanHeadings(src: string): Heading[] {
  const out: Heading[] = [];
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
    out.push({ level: h[1].length, text, line: i + 1 });
  }
  return out;
}

interface Props {
  text: string;
  /** 跳到源文第 N 行（1 基） */
  onJump: (line: number) => void;
}

export function MarkdownOutline({ text, onJump }: Props) {
  const headings = useMemo(() => scanHeadings(text), [text]);

  return (
    <div className={styles.panel}>
      <div className={styles.head}>大纲 · {headings.length}</div>
      {headings.length === 0 ? (
        <div className={styles.empty}>还没有标题。用 # 开头写一行就会出现在这里。</div>
      ) : (
        <div className={styles.list}>
          {headings.map((h) => (
            <button
              // 行号做 key：标题文本会重复（很多文档有多个「示例」），用文本会撞 key
              key={h.line}
              className={`${styles.item} ${styles[`lv${h.level}`]}`}
              onClick={() => onJump(h.line)}
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
