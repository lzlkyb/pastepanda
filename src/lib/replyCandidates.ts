/**
 * 回复草稿（ai-reply-draft）多候选解析。
 *
 * 后端 prompt 要求模型一次给出 3 个不同语气的候选，每段以标题行开头：
 *   ---正式版---
 *   （正式、书面的回复）
 *   ---简洁版---
 *   （简洁直白的回复）
 *   ---轻松版---
 *   （轻松口语化的回复）
 *
 * 这里负责把模型的输出拆回候选数组。**解析失败必须回退成单候选**
 * （把整段原文当唯一候选）——模型不听话、截断、或用户在别处粘贴了普通文本时，
 * 结果照样能用，只是少了一个"挑选"的步骤。
 *
 * 实现按行扫描而非正则大匹配：标题行的判定是"整行 === ---标题---"，
 * 内容里的 ---- 装饰线（4 个连字符）天然不满足，不会被误切。
 */

export interface ReplyCandidate {
  /** 候选标题（如「正式版」）；无标题时为空串 */
  title: string;
  text: string;
}

/** 整行都是标题行才算：`---标题---`（允许首尾空白） */
const TITLE_RE = /^---(.+?)---\s*$/;

export function parseReplyCandidates(output: string): ReplyCandidate[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  const candidates: ReplyCandidate[] = [];
  let cur: { title: string; lines: string[] } | null = null;

  const flush = () => {
    if (!cur) return;
    const text = cur.lines.join("\n").trim();
    if (text) candidates.push({ title: cur.title, text });
    cur = null;
  };

  for (const rawLine of trimmed.split("\n")) {
    const line = rawLine.trim();
    const m = TITLE_RE.exec(line);
    if (m && line.startsWith("---")) {
      // 新的候选段
      flush();
      cur = { title: m[1].trim(), lines: [] };
    } else if (cur) {
      cur.lines.push(rawLine);
    }
  }
  flush();

  return candidates.length > 0 ? candidates : [{ title: "", text: trimmed }];
}
