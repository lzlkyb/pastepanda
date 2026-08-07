/**
 * docPipeline/pdfRepair.ts — PDF 复制文本的断行修复（启发式，纯函数）。
 *
 * PDF 文本层只存字形坐标，复制时按坐标拼行，产生硬换行/断词/连字/页眉页脚混入。
 * 本模块用启发式规则修复"已复制到剪贴板的纯文本"——无 PDF 文件解析，无坐标信息，
 * 双栏乱序不可恢复（明确放弃）。
 *
 * 8 条规则（对应调研文档 4.4）：
 * 1. 段落保护：连续两个换行视为真实段落分隔，先占位；段内单换行合并。
 * 2. 合并条件：上行末尾非句末标点 + 下行首字符小写（英文加空格，中文不加）。
 * 3. 连字符还原：行尾 `-` 拼接下一行首词（无词典，直接拼，预览可手动改）。
 * 4. 连字修复：ﬁ/ﬂ/ﬀ/ﬃ/ﬄ → fi/fl/ff/ffi/ffl。
 * 5. 软连字符 U+00AD 清除。
 * 6. 页眉页脚：短行（≤40 字符）+ 位于片段首尾 + 匹配页码模式 → 弱过滤。
 * 7. 双栏乱序：不可恢复，跳过。
 * 8. 列表符号行保护换行（• / - / 数字. 开头不合并）。
 */

const LIGATURES: [RegExp, string][] = [
  [/\uFB03/g, "ffi"],
  [/\uFB04/g, "ffl"],
  [/\uFB00/g, "ff"],
  [/\uFB01/g, "fi"],
  [/\uFB02/g, "fl"],
];

const SOFT_HYPHEN = "\u00AD";

/** 句末标点（中英）——上行以这些结尾时不与下行合并 */
const SENTENCE_END = /[.!?。！？：；；…）)】】"」'』]/;

/** 列表项行首（不参与合并） */
const LIST_ITEM_RE = /^\s*(?:[•·●○◆■▪□☐\-*]|\d+[.)）]\s)/;

/** 页眉页脚弱模式（页码 / 期刊名） */
const HEADER_FOOTER_RE = /^\s*\d+\s*$|^\s*第\s*\d+\s*页|^\s*-+\s*\d+\s*-+/;

/**
 * 修复 PDF 复制文本的断行。
 * 输入是 CF_UNICODETEXT 纯文本（Acrobat 复制出来的），输出是修复后的文本。
 */
export function repairPdfText(text: string): string {
  if (!text.trim()) return text;

  // 规则 4+5：连字修复 + 软连字符清除
  let result = text.replace(new RegExp(SOFT_HYPHEN, "g"), "");
  for (const [re, replacement] of LIGATURES) {
    result = result.replace(re, replacement);
  }

  // 规则 1：按空行分段（连续 ≥2 个换行 = 真实段落分隔）
  const paragraphs = result.split(/\n\s*\n/);

  const repaired = paragraphs.map((para) => {
    const lines = para.split(/\r?\n/);
    if (lines.length <= 1) return para;

    // 规则 6：弱过滤首尾的页眉页脚
    const trimmed = lines.filter((l, i, arr) => {
      const isFirst = i === 0 || i === 1;
      const isLast = i === arr.length - 1 || i === arr.length - 2;
      if ((isFirst || isLast) && l.trim().length <= 40 && HEADER_FOOTER_RE.test(l.trim())) {
        return false;
      }
      return true;
    });

    const merged: string[] = [];
    for (const line of trimmed) {
      const prev = merged[merged.length - 1];
      if (!prev) {
        merged.push(line);
        continue;
      }

      // 规则 8：列表项不合并
      if (LIST_ITEM_RE.test(line) || LIST_ITEM_RE.test(prev)) {
        merged.push(line);
        continue;
      }

      const prevTrimmed = prev.trim();
      const lineTrimmed = line.trim();
      if (!prevTrimmed || !lineTrimmed) {
        merged.push(line);
        continue;
      }

      const prevEnd = prevTrimmed.slice(-1);
      const lineStart = lineTrimmed.slice(0, 1);

      // 规则 2：上行以句末标点结尾 → 不合并
      if (SENTENCE_END.test(prevEnd)) {
        merged.push(line);
        continue;
      }

      // 规则 3：连字符断词 — 行尾 `-` 直接拼接（去连字符）
      if (prevEnd === "-") {
        merged[merged.length - 1] = prevTrimmed.slice(0, -1) + lineTrimmed;
        continue;
      }

      // 规则 2：合并 — 中文不加空格，英文加空格
      const isChinese = /[\u4e00-\u9fff]/.test(prevEnd) || /[\u4e00-\u9fff]/.test(lineStart);
      merged[merged.length - 1] = prevTrimmed + (isChinese ? "" : " ") + lineTrimmed;
    }
    return merged.join("\n");
  });

  return repaired.join("\n\n");
}

/** 粗略判断文本是否"疑似 PDF 复制"（供变换枢纽 detect 用） */
export function looksLikePdfText(text: string): boolean {
  const lines = text.split(/\r?\n/);
  if (lines.length < 5) return false;
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length < 5) return false;
  // 多数行较短（< 80 字符）且不以句末标点结尾 → 疑似 PDF 硬换行
  const shortNonEnding = nonEmpty.filter(
    (l) => l.trim().length < 80 && !SENTENCE_END.test(l.trim().slice(-1))
  );
  return shortNonEnding.length / nonEmpty.length >= 0.6;
}
