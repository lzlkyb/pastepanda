import { useMemo } from "react";
import { diffLines, diffWords, type Change } from "diff";

export type DiffMode = "line" | "word";

export interface DiffLine {
  /** 行号（原侧），空行占位时为 null */
  lineNo: number | null;
  /** 行文本内容 */
  text: string;
  /** 状态：unchanged / added / removed / empty（占位对齐） */
  state: "unchanged" | "added" | "removed" | "empty";
  /** 词级高亮片段（仅 word 模式下有值） */
  wordParts?: { text: string; added?: boolean; removed?: boolean }[];
  /** 所属差异块索引（用于跳转） */
  diffBlock: number;
}

export interface DiffResult {
  left: DiffLine[];
  right: DiffLine[];
  added: number;
  removed: number;
  /** 差异块数量（用于跳转导航） */
  blockCount: number;
}

interface UseDiffOptions {
  oldText: string;
  newText: string;
  mode: DiffMode;
  ignoreWhitespace: boolean;
}

/**
 * 计算两段文本的 diff，返回左右对齐的行数组。
 * 使用 jsdiff 的 diffLines / diffWords。
 */
export function useDiff({ oldText, newText, mode, ignoreWhitespace }: UseDiffOptions): DiffResult {
  return useMemo(() => {
    const opts = ignoreWhitespace ? { ignoreWhitespace: true } : {};
    const changes: Change[] = mode === "line"
      ? diffLines(oldText, newText, opts)
      : diffLines(oldText, newText, opts);

    const left: DiffLine[] = [];
    const right: DiffLine[] = [];
    let leftNo = 0;
    let rightNo = 0;
    let added = 0;
    let removed = 0;
    let blockIdx = -1;
    let lastWasDiff = false;

    for (const part of changes) {
      const isDiff = part.added || part.removed;
      if (isDiff && !lastWasDiff) blockIdx++;
      lastWasDiff = isDiff;

      // 将 part.value 拆成行（保留末尾空行逻辑）
      const lines = part.value.split("\n");
      // diffLines 的 value 通常以 \n 结尾，最后一个元素是空串
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

      if (!part.added && !part.removed) {
        // unchanged
        for (const line of lines) {
          leftNo++;
          rightNo++;
          left.push({ lineNo: leftNo, text: line, state: "unchanged", diffBlock: blockIdx });
          right.push({ lineNo: rightNo, text: line, state: "unchanged", diffBlock: blockIdx });
        }
      } else if (part.removed) {
        removed += lines.length;
        for (const line of lines) {
          leftNo++;
          left.push({ lineNo: leftNo, text: line, state: "removed", diffBlock: blockIdx });
        }
      } else if (part.added) {
        added += lines.length;
        for (const line of lines) {
          rightNo++;
          right.push({ lineNo: rightNo, text: line, state: "added", diffBlock: blockIdx });
        }
      }
    }

    // 对齐：左右行数补齐（用 empty 占位）
    alignPanes(left, right);

    // 词级高亮（word 模式）
    if (mode === "word") {
      applyWordHighlight(left, right);
    }

    const blockCount = blockIdx + 1;
    return { left, right, added, removed, blockCount };
  }, [oldText, newText, mode, ignoreWhitespace]);
}

/** 对齐左右面板：在 removed 对面插入 empty 占位，反之亦然 */
function alignPanes(left: DiffLine[], right: DiffLine[]) {
  // 按 diffBlock 分组对齐
  let i = 0;
  let j = 0;
  const newLeft: DiffLine[] = [];
  const newRight: DiffLine[] = [];

  while (i < left.length || j < right.length) {
    const lBlock = i < left.length ? left[i].diffBlock : Infinity;
    const rBlock = j < right.length ? right[j].diffBlock : Infinity;

    if (lBlock === rBlock) {
      // 收集同一 block 的所有行
      const lLines: DiffLine[] = [];
      const rLines: DiffLine[] = [];
      while (i < left.length && left[i].diffBlock === lBlock) lLines.push(left[i++]);
      while (j < right.length && right[j].diffBlock === rBlock) rLines.push(right[j++]);

      const maxLen = Math.max(lLines.length, rLines.length);
      for (let k = 0; k < maxLen; k++) {
        if (k < lLines.length) {
          newLeft.push(lLines[k]);
        } else {
          newLeft.push({ lineNo: null, text: "", state: "empty", diffBlock: lBlock });
        }
        if (k < rLines.length) {
          newRight.push(rLines[k]);
        } else {
          newRight.push({ lineNo: null, text: "", state: "empty", diffBlock: rBlock });
        }
      }
    } else if (lBlock < rBlock) {
      newLeft.push(left[i++]);
      newRight.push({ lineNo: null, text: "", state: "empty", diffBlock: lBlock });
    } else {
      newLeft.push({ lineNo: null, text: "", state: "empty", diffBlock: rBlock });
      newRight.push(right[j++]);
    }
  }

  left.length = 0;
  right.length = 0;
  left.push(...newLeft);
  right.push(...newRight);
}

/** 对 removed/added 配对行做词级 diff 高亮 */
function applyWordHighlight(left: DiffLine[], right: DiffLine[]) {
  for (let i = 0; i < left.length; i++) {
    const l = left[i];
    const r = right[i];
    if (l.state === "removed" && r.state === "added") {
      const parts = diffWords(l.text, r.text);
      l.wordParts = [];
      r.wordParts = [];
      for (const p of parts) {
        if (p.added) {
          r.wordParts.push({ text: p.value, added: true });
        } else if (p.removed) {
          l.wordParts.push({ text: p.value, removed: true });
        } else {
          l.wordParts.push({ text: p.value });
          r.wordParts.push({ text: p.value });
        }
      }
    }
  }
}
