import { invoke } from "@tauri-apps/api/core";
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** 合并 Tailwind 类名，自动去重和解决冲突 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 相对时间格式化 */
export function relativeTime(timeStr: string): string {
  if (!timeStr) return "";
  const now = new Date();
  const date = new Date(timeStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin}分钟前`;
  if (diffHour < 24) return `${diffHour}小时前`;
  if (diffDay === 1) return "昨天";
  if (diffDay < 7) return `${diffDay}天前`;

  const month = date.getMonth() + 1;
  const day = date.getDate();
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  const weekday = weekdays[date.getDay()];
  return `${month}月${day}日 周${weekday}`;
}

/** 截断文本 */
export function truncate(text: string, maxLen: number): string {
  if (!text) return "";
  const cleaned = text.replace(/\r/g, " ").replace(/\n/g, " ");
  // 按 Unicode 码点切分，避免 UTF-16 代理对（如 emoji）被从中间切断产生孤立代理项
  const codePoints = Array.from(cleaned);
  return codePoints.length > maxLen ? codePoints.slice(0, maxLen).join("") + "..." : cleaned;
}

/** 剥离 HTML 标签，返回纯文本 */
export function stripHtml(text: string): string {
  try {
    const doc = new DOMParser().parseFromString(text, "text/html");
    return (doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    // 兜底：正则剥离
    return text.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();
  }
}

/** 类型图标配置 — SVG 路径数据 */
export const TYPE_ICONS: Record<string, { svgPath: string; color: string }> = {
  text:    { svgPath: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", color: "#9E9E9E" },
  link:    { svgPath: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71", color: "#07C160" },
  email:   { svgPath: "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z", color: "#007AFF" },
  code:    { svgPath: "M16 18l6-6-6-6M8 6l-6 6 6 6", color: "#5856D6" },
  phone:   { svgPath: "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z", color: "#FF9500" },
  image:   { svgPath: "M3 3h18v18H3V3zm0 0l13 10-5 4-3-2-5 4", color: "#FF9500" },
  file:    { svgPath: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm0 0v6h6", color: "#FFCC00" },
};

// ==================== 代码高亮 ====================
// 策略：highlight.js 做语言检测 + Shiki 做语法高亮渲染
// hljs.highlightAuto 的 relevance 计分机制检测语言，Shiki 的 TextMate 引擎渲染精准高亮

import type { HighlighterCore } from "shiki/core";
import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import type { ThemeKey } from "./theme";

/** 支持的语言列表（hljs 和 Shiki 共用） */
const LANG_NAMES = [
  "python", "javascript", "typescript", "rust", "go", "java",
  "cpp", "c", "sql", "bash", "json", "xml", "yaml", "css", "markdown",
] as const;

/** 语言名称 → 显示标签映射 */
const LANG_LABELS: Record<string, string> = {
  python: "Python", javascript: "JavaScript", typescript: "TypeScript",
  rust: "Rust", go: "Go", java: "Java", cpp: "C++", c: "C",
  sql: "SQL", bash: "Bash", json: "JSON", xml: "XML/HTML",
  yaml: "YAML", css: "CSS", markdown: "Markdown",
};

export interface HighlightResult {
  html: string;
  language: string;
  relevance: number;
}

// ---- hljs 检测器（只做语言检测，不做高亮） ----

let hljsCore: typeof import("highlight.js/lib/core").default | null = null;
let hljsReady = false;

async function getHljsDetector() {
  if (!hljsCore) {
    hljsCore = (await import("highlight.js/lib/core")).default;
  }
  if (!hljsReady) {
    const langModules = await Promise.all([
      import("highlight.js/lib/languages/python"),
      import("highlight.js/lib/languages/javascript"),
      import("highlight.js/lib/languages/typescript"),
      import("highlight.js/lib/languages/rust"),
      import("highlight.js/lib/languages/go"),
      import("highlight.js/lib/languages/java"),
      import("highlight.js/lib/languages/cpp"),
      import("highlight.js/lib/languages/c"),
      import("highlight.js/lib/languages/sql"),
      import("highlight.js/lib/languages/bash"),
      import("highlight.js/lib/languages/json"),
      import("highlight.js/lib/languages/xml"),
      import("highlight.js/lib/languages/yaml"),
      import("highlight.js/lib/languages/css"),
      import("highlight.js/lib/languages/markdown"),
    ]);
    LANG_NAMES.forEach((name, i) => hljsCore!.registerLanguage(name, langModules[i].default));
    hljsReady = true;
  }
  return hljsCore;
}

// ---- Shiki 高亮器（只做渲染） ----

/** 软件主题 → Shiki 主题映射（每个软件主题对应一个独立 Shiki 主题） */
const THEME_MAP: Record<string, string> = {
  ocean: "github-light-default",
  forest: "everforest-light",
  blossom: "rose-pine-dawn",
  dawn: "catppuccin-latte",
  midnight: "github-dark-default",
};

let highlighter: HighlighterCore | null = null;
let highlighterInitPromise: Promise<HighlighterCore> | null = null;

async function getHighlighter(): Promise<HighlighterCore> {
  if (highlighter) return highlighter;
  if (!highlighterInitPromise) {
    highlighterInitPromise = (async () => {
      const h = await createHighlighterCore({
        themes: [
          import("shiki/themes/github-light-default.mjs"),
          import("shiki/themes/everforest-light.mjs"),
          import("shiki/themes/rose-pine-dawn.mjs"),
          import("shiki/themes/catppuccin-latte.mjs"),
          import("shiki/themes/github-dark-default.mjs"),
        ],
        langs: [
          import("shiki/langs/python.mjs"),
          import("shiki/langs/javascript.mjs"),
          import("shiki/langs/typescript.mjs"),
          import("shiki/langs/rust.mjs"),
          import("shiki/langs/go.mjs"),
          import("shiki/langs/java.mjs"),
          import("shiki/langs/cpp.mjs"),
          import("shiki/langs/c.mjs"),
          import("shiki/langs/sql.mjs"),
          import("shiki/langs/bash.mjs"),
          import("shiki/langs/json.mjs"),
          import("shiki/langs/xml.mjs"),
          import("shiki/langs/yaml.mjs"),
          import("shiki/langs/css.mjs"),
          import("shiki/langs/markdown.mjs"),
        ],
        engine: createOnigurumaEngine(() => import("shiki/wasm")),
      });
      return h;
    })();
  }
  highlighter = await highlighterInitPromise;
  return highlighter;
}

/** 错误日志关键词 */
const ERROR_KEYWORDS = /\b(ERROR|FATAL|Exception|Traceback|panic|stack trace|WARN)\b/i;

/**
 * 高亮代码并返回结构化结果
 * hljs.highlightAuto 检测语言 → Shiki.codeToHtml 渲染高亮
 */
export async function highlightCode(text: string): Promise<HighlightResult> {
  if (!text || text.length > 5000) {
    return { html: "", language: "plain", relevance: 0 };
  }

  try {
    // 错误日志检测
    const errorMatches = (text.match(ERROR_KEYWORDS) || []).length;
    if (errorMatches >= 2 && text.length < 500) {
      return { html: "", language: "errorlog", relevance: 0 };
    }

    // 1. hljs 检测语言
    const hljs = await getHljsDetector();
    const detectResult = hljs.highlightAuto(text, [...LANG_NAMES]);
    const lang = detectResult.language || "plain";
    const relevance = detectResult.relevance || 0;

    // 低置信度 → 不显示高亮
    if (relevance < 3 || lang === "plain") {
      return { html: "", language: "plain", relevance: 0 };
    }

    // 2. Shiki 用检测到的语言做高亮（多主题：6 个软件主题各对应独立 Shiki 主题）
    const h = await getHighlighter();
    // Shiki 用 "html" 而 hljs 用 "xml"，做映射
    const shikiLang = lang === "xml" ? "html" : lang;
    // 构建多主题对象：每个软件主题 key → Shiki 主题名
    const themeEntries = Object.entries(THEME_MAP) as [ThemeKey, string][];
    const themes: Record<string, string> = {};
    for (const [appTheme, shikiTheme] of themeEntries) {
      themes[appTheme] = shikiTheme;
    }
    const result = h.codeToHtml(text, {
      lang: shikiLang,
      themes,
      defaultColor: false, // 为所有主题生成 CSS 变量，由 data-theme + CSS 规则控制显示
    });
    // 提取 <pre> 内部 HTML（去掉外层 pre/code 标签）
    const inner = result.replace(/^<pre[^>]*><code[^>]*>/, "").replace(/<\/code><\/pre>$/, "");

    if (inner.includes("<span")) {
      return { html: inner, language: lang, relevance };
    }
    return { html: "", language: lang, relevance };
  } catch {
    return { html: "", language: "plain", relevance: 0 };
  }
}

/**
 * 单 token 的**标识符 / 路径 / 单号**形态——不是自然语言句子。
 *
 * 用户剪贴板里大量内容是 `itemVO` / `MODULEID` / `receivablebill_his.xml` /
 * `C0805041350000005382` 这类东西。它们既不能翻译（没有语义）、也不能润色
 * （没有错别字）、更没有要点可提，所以所有面向散文的 AI 动作都应该避开它们。
 *
 * 判据核心是“**单 token**”：自然语言哪怕很短也有空白分隔（"hello world"），
 * 没有空白的一串字符不是句子。单个纯小写词不算——那可能真是个外文词。
 *
 * 放在 utils 而不是 aiTransforms（规则 #11 单一数据源）：打分要用它，
 * `aiQuick` 的短文本兜底也要用它——兜底是硬编码 push、**完全绕过打分**，
 * 不共用同一个判据的话，打分刚排除的标识符会被兜底原样塞回来（实测过）。
 */
export function looksLikeIdentifier(text: string): boolean {
  const t = text.trim();
  // 有空白 = 成句，不在此列
  if (!t || /\s/.test(t)) return false;
  // 下划线 / 路径分隔 / 扩展名 / 命名空间
  if (/[_/\\.:#@]/.test(t)) return true;
  // 含数字：单据号、编码、版本号
  if (/\d/.test(t)) return true;
  // 全大写：常量名 SYSTEMCODE
  if (/^[A-Z]+$/.test(t)) return true;
  // 驼峰：itemVO / INCCForHHOrSSService
  return /[a-z][A-Z]/.test(t);
}

/** 根据语言名获取显示标签 */
export function getLangLabel(language: string): string {
  return LANG_LABELS[language] || (language === "errorlog" ? "错误日志" : "文本");
}

/**
 * 同步高亮（用于已知语言的情况）
 * Shiki 不支持同步调用，返回转义后的纯文本
 */
export function highlightCodeSync(text: string, _language: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ==================== 来源名称清洗 ====================

// 已迁移至 src/lib/source-mappings.ts，此处保留兼容重导出
export { cleanSourceName, getSourceIcon } from "./source-mappings";

// ==================== AI 用量估算 ====================

/**
 * 粗略估算一段文本大约占多少 token。
 *
 * 用途：变换卡在“还没发送”时告诉用户这次大概多大体量，好判断要不要真发。
 *
 * 算法：CJK（中日韩）按 1.5 token/字，其余字符按 4 字符/token。
 *
 * **这只是量级参考，不是准确值**：真实分词由各家 tokenizer 决定，
 * 同一段中文在不同服务商下可以差到 ±50%（DeepSeek/通义这类中文词表明显更省）。
 * 所以**展示时必须带“≈”**，不能拿它去算钱。
 *
 * 用 for...of 而不是下标遍历：后者会把 emoji 等代理对拆成两个“字符”。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[一-鿿぀-ヿ가-힯]/.test(ch)) cjk++;
    else other++;
  }
  return Math.max(1, Math.round(cjk * 1.5 + other / 4));
}

/** 字数（按**码点**数，emoji 算 1 个）。与 estimateTokens 配套展示。
 *  不用 text.length：它数的是 UTF-16 代码单元，一个 emoji 会被算成 2。 */
export function countChars(text: string): number {
  return text ? [...text].length : 0;
}

/**
 * 把 catch 到的未知错误转成可展示文案。
 *
 * Tauri 的 invoke 失败时抛的是**字符串**（Rust 端 `Err(String)`），
 * 而前端自己的异常抛的是 Error，两者得分开取：
 * 直接 String(e) 会把 Error 变成 "Error: xxx"，把普通对象变成 "[object Object]"。
 */
export function errText(e: unknown, fallback: string): string {
  if (typeof e === "string" && e.trim()) return e;
  if (e instanceof Error && e.message) return e.message;
  const s = e == null ? "" : String(e);
  return s && s !== "[object Object]" ? s : fallback;
}

/**
 * 解析 file / image 条目的 `content` 字段为路径数组。
 *
 * `content` 的存法不止一种（历史原因）：JSON 数组、JSON 单字符串、
 * 裸路径、换行分隔的多路径都可能，所以四种都得接。
 *
 * 收口缘由（规则 #11）：之前共存三份实现且**行为不一致**——
 * pasteTransform 那份 JSON 解析失败后按换行切分，Card 那两份直接把整个
 * content 当单路径，于是同一条多文件记录在不同地方能解出不同的个数。
 * 这里取并集：先 JSON，再按换行切，每项 trim 后去空。
 */
export function parseFilePaths(content: string): string[] {
  if (!content) return [];
  try {
    const parsed: unknown = JSON.parse(content);
    if (Array.isArray(parsed)) {
      // 只收字符串项：Card 那份用的是 map(String)，会把数字/null 变成
      // "1"/"null" 当成路径交下去。丢掉非字符串才是对的。
      return parsed.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter(Boolean);
    }
    if (typeof parsed === "string" && parsed.trim()) return [parsed.trim()];
  } catch {
    /* 不是 JSON，当纯路径处理 */
  }
  return content
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * 复制文本到剪贴板。
 *
 * 优先用 `navigator.clipboard.writeText`（需安全上下文 + 用户手势）；
 * 失败（如子窗口失焦、非聚焦态）兜底走 Tauri 原生 `copy_only` 命令
 * （src-tauri/src/commands/paste.rs，参数名 text）。
 *
 * 返回是否成功，便于调用方做内联反馈（如 toast 内的「已复制 ✓」）。
 * 收口缘由（规则 #11）：全项目 40+ 处内联 `navigator.clipboard` 散落，
 * 统一经此函数，避免重复且保证兜底一致。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      await invoke("copy_only", { text });
      return true;
    } catch {
      return false;
    }
  }
}

/** OCR 文本里可被"识别即操作"的实体类型。 */
export type OcrEntityType = "url" | "phone" | "email";

export interface OcrEntity {
  type: OcrEntityType;
  value: string;
  start: number;
  end: number;
}

/**
 * 从文本中提取 URL / 手机号 / 邮箱（本地正则，零出网，符合隐私红线）。
 *
 * 仅用保守规则避免误判：
 * - URL: `https?://` 起手
 * - 手机号: 大陆 11 位 `1[3-9]\d{9}`（前后非数字）
 * - 邮箱: 标准 `name@host.tld`
 * 不识别纯连续数字串（发票号/订单号等），避免把普通数字当电话。
 *
 * 多规则命中时按 start 排序并去重叠（URL 里的数字不会被判成电话）。
 */
export function extractEntities(text: string): OcrEntity[] {
  const raw: OcrEntity[] = [];
  const collect = (type: OcrEntityType, re: RegExp) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      raw.push({ type, value: m[0], start: m.index, end: m.index + m[0].length });
    }
  };
  collect("url", /https?:\/\/[^\s]+/gi);
  collect("email", /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
  collect("phone", /(?<!\d)1[3-9]\d{9}(?!\d)/g);
  collect("phone", /(?<!\d)0\d{2,3}[\s-]\d{7,8}(?!\d)/g);

  raw.sort((a, b) => a.start - b.start || a.end - b.end);
  const out: OcrEntity[] = [];
  let lastEnd = -1;
  for (const e of raw) {
    if (e.start >= lastEnd) {
      out.push(e);
      lastEnd = e.end;
    }
  }
  return out;
}

