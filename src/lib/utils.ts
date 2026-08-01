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
