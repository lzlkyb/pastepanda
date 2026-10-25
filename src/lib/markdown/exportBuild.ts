/**
 * 「可独立打开的单文件文档」组装器 —— 导出 HTML 与导出 PDF 共用（规则 #11 收口）。
 *
 * 从 useExportHtml.ts 抽出的**与落盘方式无关**那一段：渲染 → 收集主题变量 →
 * 拼 CSS → buildHtmlDocument。两个消费方只差最后一步：
 * - useExportHtml：saveDialog + writeTextFile（写 .html 文件）
 * - useExportPdf：隐藏 iframe + print()（调起系统打印对话框）
 * 组装逻辑只有这一份，两条路导出的排版才不会漂。
 *
 * KaTeX 样式：文档含公式时追加（数学公式没样式等于没导出），并把 woff2 字体
 * 内嵌为 data URI——导出文件的设计约束①是「单文件」，url(fonts/…) 相对引用
 * 到了别人电脑上全是死链；woff/ttf 回退源直接删掉（woff2 2016 年起全主流），
 * 体积只按「有数学的文档」付一次（约 300KB，与图片内联同一量级的取舍）。
 */
import mdCssText from "@/components/MarkdownRenderer.module.css?inline";
import mdStyles from "@/components/MarkdownRenderer.module.css";
import codeCssText from "@/styles/code-theme.css?inline";
import katexCssText from "katex/dist/katex.min.css?inline";
import { buildHtmlDocument } from "./exportDoc";
import { EXPORT_RUNTIME } from "./exportRuntime";
import { makeDocId } from "./formFields";
import { renderMarkdownForExport } from "./exportRender";

export interface StandaloneDocInput {
  text: string;
  baseDir: string | null;
  fileName: string;
}

export interface StandaloneDocResult {
  /** 组装完成的单文件 HTML；null = 文档为空（调用方各自提示） */
  doc: string | null;
  /** 文件名去掉 .md 扩展（对话框默认路径 / 打印页标题用它） */
  title: string;
  warnings: string[];
}

/** 从样式表里收集所有声明过的自定义属性名（含 media 等嵌套块） */
function collectVarNames(rules: CSSRuleList, out: Set<string>): void {
  for (const rule of Array.from(rules)) {
    const withStyle = rule as CSSStyleRule;
    const nested = (rule as CSSRule & { cssRules?: CSSRuleList }).cssRules;
    if (withStyle.style) {
      for (const prop of Array.from(withStyle.style)) {
        if (prop.startsWith("--")) out.add(prop);
      }
    }
    if (nested) collectVarNames(nested, out);
  }
}

/**
 * 把当前主题的 CSS 变量**解析成具体值**快照下来。
 *
 * 不做这一步，导出文件到了别人电脑上就是一片透明/黑字——`.md` 里到处是
 * `var(--text-primary)`，而变量定义在应用的 theme.css 里，不会跟着文件走。
 * 取 computed 值而不是声明值：`color-mix()`、`calc()` 在这里都已经算完。
 */
export function collectThemeVars(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const names = new Set<string>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // 跨源样式表取不到规则，跳过（应用自身都是同源）
    }
    if (rules) collectVarNames(rules, names);
  }
  const computed = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const name of names) {
    const value = computed.getPropertyValue(name).trim();
    if (value) vars[name] = value;
  }
  return vars;
}

/** KaTeX 导出样式（字体已内嵌）。只算一次，进程内缓存——字体文件不会变 */
let katexCssCache: Promise<string> | null = null;

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000; // 分块避免 String.fromCharCode 参数表溢出
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function katexExportCss(): Promise<string> {
  if (!katexCssCache) {
    katexCssCache = (async () => {
      // ① 删 woff/ttf 回退源（url(…) format("woff"/"truetype") 整段）
      let css = katexCssText
        .replace(/,url\([^)]*?\.woff\)\s*format\("woff"\)/g, "")
        .replace(/,url\([^)]*?\.ttf\)\s*format\("truetype"\)/g, "");
      // ② woff2 逐个取回内嵌；取不到就保留原 url（应用内打印 iframe 同源仍可解）
      const urls = [...css.matchAll(/url\(([^)]*\.woff2[^)]*)\)/g)];
      for (const m of urls) {
        try {
          const buf = await (await fetch(m[1].replace(/["']/g, ""))).arrayBuffer();
          css = css.split(m[0]).join(`url(data:font/woff2;base64,${bufToBase64(buf)})`);
        } catch {
          /* 保留原 url，字体退化为系统衬线 */
        }
      }
      return css;
    })();
  }
  return katexCssCache;
}

function stripExt(name: string): string {
  return name.replace(/\.(md|markdown|mdx)$/i, "") || "未命名文档";
}

/**
 * 渲染并组装单文件文档。只做组装——选路径、写盘、打印对话框都由调用方决定。
 */
export async function buildStandaloneDoc(input: StandaloneDocInput): Promise<StandaloneDocResult> {
  const { text, baseDir, fileName } = input;
  const root = document.documentElement;
  const theme = root.getAttribute("data-theme") || "ocean";
  const appearance = root.getAttribute("data-appearance");

  const { html: bodyHtml, fields, taskCount, mathCount, warnings } = await renderMarkdownForExport(
    text,
    { baseDir, theme },
  );
  if (!bodyHtml.trim()) return { doc: null, title: stripExt(fileName), warnings: [] };

  const title = stripExt(fileName);
  const css =
    `${mdCssText}\n${codeCssText}` + (mathCount > 0 ? `\n${await katexExportCss()}` : "");

  const doc = buildHtmlDocument({
    title,
    bodyHtml,
    css,
    // 哈希类名缺失时退回 md 会让样式全丢，但至少不会崩；正常构建不会走到
    rootClass: mdStyles.md ?? "md",
    theme: { name: theme, appearance, vars: collectThemeVars() },
    docId: makeDocId(),
    fields,
    taskCount,
    // 没有可填字段也没有可勾任务就不嵌任何脚本，纯阅读的导出保持零 JS
    runtimeJs: fields.length > 0 || taskCount > 0 ? EXPORT_RUNTIME : undefined,
    sourceName: fileName,
  });

  return { doc, title, warnings };
}
