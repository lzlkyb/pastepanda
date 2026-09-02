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

/**
 * 强制用指定语言高亮（编辑器内手动锁定语法语言时用）。
 * lang 必须是 LANG_NAMES 内的小写名（如 "python"/"sql"），否则退化为纯文本（仍可见）。
 * 复用模块内 getHighlighter / THEME_MAP，不新增 Shiki 实例。
 */
export async function highlightCodeForced(text: string, lang: string): Promise<HighlightResult> {
  if (!text) return { html: "", language: lang, relevance: 0 };
  const normalized = (lang || "").toLowerCase();
  if (!(LANG_NAMES as readonly string[]).includes(normalized)) {
    return { html: "", language: "plain", relevance: 0 };
  }
  try {
    const h = await getHighlighter();
    const shikiLang = normalized === "xml" ? "html" : normalized;
    const themeEntries = Object.entries(THEME_MAP) as [ThemeKey, string][];
    const themes: Record<string, string> = {};
    for (const [appTheme, shikiTheme] of themeEntries) themes[appTheme] = shikiTheme;
    const result = h.codeToHtml(text, { lang: shikiLang, themes, defaultColor: false });
    const inner = result.replace(/^<pre[^>]*><code[^>]*>/, "").replace(/<\/code><\/pre>$/, "");
    return { html: inner, language: normalized, relevance: 999 };
  } catch {
    return { html: "", language: "plain", relevance: 0 };
  }
}

/**
 * 判断一段文本是否像 SQL（用于把分类为 code 的 SQL 片段路由到专用 SQL 编辑器）。
 * 保守判据：出现 ≥2 个 SQL 关键字，或含主关键字且有分号/换行。
 */
export function isSqlLike(text: string): boolean {
  const t = (text || "").trim();
  if (t.length < 8) return false;
  const SQL_KW = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH|FROM|WHERE|JOIN|TABLE|INDEX|VALUES|INTO|SET)\b/gi;
  const matches = (t.match(SQL_KW) || []).length;
  return matches >= 2;
}

/** 判断文本是否为独立 SVG 文档（trim 后以 <svg 开头，词边界；用于路由到 SVG 编辑器） */
export function isSvgLike(text: string): boolean {
  return /^<svg[\s>]/i.test((text || "").trimStart());
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

/** 紧凑计数：上万不写全，1234 → `1.2k`。
 *
 * 收口缘由（规则 #11）：原本只存在于 `DocEditor.tsx` 里的一个局部箭头函数，
 * 笔记行的字数条要的是同一个格式。两份数字格式化必定会分岔（一边改阀值、
 * 一边改小数位），而分岐后双方看上去都「没错」，根本不会有人发现。 */
export function fmtCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
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

/**
 * 从图片条目的占位文本（如 `[图片] 554x265`）提取尺寸。
 * 匹配失败返回 null（非图片占位、格式异常都视为无尺寸信息）。
 * 收口缘由（规则 #11）：占位格式由后端 clipboard_monitor 写入，
 * 需要显示尺寸的调用点（主窗口卡片，后续托盘弹窗等）统一走这里，不各自解析。
 */
export function parseImagePlaceholderSize(text: string): { width: number; height: number } | null {
  const m = /^\[图片\]\s*(\d+)\s*[xX×]\s*(\d+)/.exec((text || "").trim());
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** 图片卡片 OCR 状态（由 useCardOcr 产出，后端回填的 ocr_text 不属于此状态）。 */
export type ImageOcrState = {
  /** idle=未发起（排队中）；ocr=识别中；done=已出结果；fail=识别失败 */
  status: "idle" | "ocr" | "done" | "fail";
  /** 识别文本；仅 status=done 时有意义（空串=识别过但无文字） */
  text?: string;
};

/** 图片卡片标题/副行显示所需的最小输入（Card.tsx 的 item 子集）。 */
export interface ImageCardDisplayInput {
  type: string;
  text: string;
  content: string;
  ocr_text?: string;
}

export interface ImageCardDisplay {
  /** 卡片标题（cardTitle）最终文本 */
  title: string;
  /** 副行尺寸徽标文本（如 "554×265"），无尺寸信息时为 undefined */
  sizeText?: string;
  /** OCR 徽标文本（如 "已识别 48 字"），仅识别成功且有文字时出现 */
  ocrLabel?: string;
}

/**
 * 图片卡片显示决策（纯函数，供 Card.tsx 渲染 + 单测）。
 *
 * 状态优先级（与后端持久化语义严格对应）：
 * 1. 有 OCR 文本（后端回填 ocr_text 非空，或前端识别完成非空）→ 标题=OCR 文本
 * 2. 识别过但无文字（ocr_text === "" 或前端识别完成空串）→ 标题="未识别到文字"
 * 3. 正在识别 → 标题="识别图片文字中…"
 * 4. 其余（未识别/失败/无路径）→ 标题=文件名（content basename），回退「图片」
 *
 * 尺寸从占位文本 `[图片] WxH` 提取，独立于 OCR 状态——没有 OCR 结果也显示。
 */
export function resolveImageCardDisplay(item: ImageCardDisplayInput, ocrState?: ImageOcrState): ImageCardDisplay {
  const size = parseImagePlaceholderSize(item.text || "");
  const sizeText = size ? `${size.width}×${size.height}` : undefined;

  // 后端 Rust Option::None 序列化为 null（不是字段缺失），必须同时排除 null 与 undefined。
  // 后端回填（含空串）是持久化权威；前端状态只在后端没给（新条目）时兜底。
  const ocrText = item.ocr_text != null ? item.ocr_text : ocrState?.status === "done" ? ocrState.text : undefined;

  // 与 Card.tsx 原 title 逻辑同口径的 500 字符截断：OCR 全文可能很长，
  // 超长文本进 DOM / 高亮 split 会拖垮列表（M24 同类问题）。
  const clamp = (t: string) => {
    const flat = t.slice(0, 501).replace(/\r?\n/g, " ").trim();
    return flat.length > 500 ? flat.slice(0, 500) + "…" : flat;
  };

  if (ocrText !== undefined && ocrText !== "") {
    return { title: clamp(ocrText), sizeText, ocrLabel: `已识别 ${ocrText.length} 字` };
  }
  if (ocrText === "") {
    return { title: "未识别到文字", sizeText };
  }
  if (ocrState?.status === "ocr") {
    return { title: "识别图片文字中…", sizeText };
  }
  const name = (item.content || "").split(/[/\\]/).pop();
  return { title: name || "图片", sizeText };
}

/**
 * 获取图片条目的**完整** OCR 文本（复制用，非截断标题）。
 *
 * 与 resolveImageCardDisplay 同源同判据：后端回填（item.ocr_text）优先，
 * 前端实时识别结果（ocrState）兜底；两者都无或为 null → 返回 null（无文字）。
 * 空串表示「识别过但无文字」，同样返回 null——没有可复制的内容。
 *
 * 收口缘由（规则 #11）：Popover「复制文字」按钮与右键「复制识别文字」项
 * 必须复制同一份完整文本，禁止各自取截断标题或各写判断。
 */
export function getImageOcrFullText(
  item: ImageCardDisplayInput,
  ocrState?: ImageOcrState,
): string | null {
  // 同 resolveImageCardDisplay 的合并逻辑；!= null 兼容后端序列化的 null
  const text = item.ocr_text != null ? item.ocr_text : ocrState?.status === "done" ? ocrState.text : undefined;
  if (text === undefined || text === "") return null;
  return text;
}



/**
 * 派发一条失败提示（规则 #11 收口；规则 15.3「静默失败比报错难查一个量级」）。
 *
 * `lib/api/*` 不是组件、拿不到 `useToast()`，项目既有做法是直接派发
 * `app-toast` 窗口事件（主窗 App.tsx 监听）。这里把那一行收成函数，
 * 让新增的失败提示文案格式一致、以后要加节流也只改一处。
 *
 * **只用于用户主动触发的操作失败**。后台读取（获取标签 / 统计 / 缩略图等）
 * 失败不要用它——用户没要求过的事情失败了还弹提示，只是噪音。
 *
 * 注：既有 45 处内联的 `app-toast` 派发未一并迁移（行为完全相同，
 * 属于独立的整理工作，不在本次改动范围）。
 *
 * @param action 用户能看懂的动作描述，如「添加标签」；不要用内部函数名
 * @param err    原始错误，仅取 message 追加在后面，便于用户复述给维护者
 */
export function toastActionFailed(action: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err != null ? String(err) : "";
  const message = detail ? `${action}失败：${detail}` : `${action}失败`;
  window.dispatchEvent(new CustomEvent("app-toast", { detail: { message, type: "error" } }));
}
