/**
 * 「导出为 HTML（分享）」的编排层：渲染 → 组装 → 选路径 → 落盘。
 *
 * 样式来源是这里最关键的一处设计：直接拿 `MarkdownRenderer.module.css?inline`。
 * Vite 对 `?inline` 返回的是**已哈希类名**的 CSS 文本（实测 22686 字符，
 * 类名与组件里的 `styles.md` 同值），所以导出文件只要根节点带同一个类名，
 * 排版就与预览逐像素一致——不需要另写一份「导出专用样式」，也就不会有漂移。
 */
import { useCallback, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import mdCssText from "@/components/MarkdownRenderer.module.css?inline";
import mdStyles from "@/components/MarkdownRenderer.module.css";
import codeCssText from "@/styles/code-theme.css?inline";
import { buildHtmlDocument } from "@/lib/markdown/exportDoc";
import { EXPORT_RUNTIME } from "@/lib/markdown/exportRuntime";
import { makeDocId } from "@/lib/markdown/formFields";
import { renderMarkdownForExport } from "@/lib/markdown/exportRender";
import { errText } from "@/lib/utils";
import { useToast } from "@/components/Toast";

export interface ExportHtmlInput {
  text: string;
  baseDir: string | null;
  fileName: string;
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
function collectThemeVars(): Record<string, string> {
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

function stripExt(name: string): string {
  return name.replace(/\.(md|markdown|mdx)$/i, "") || "未命名文档";
}

export function useExportHtml(input: ExportHtmlInput) {
  const { toast } = useToast();
  const [exporting, setExporting] = useState(false);
  // state 更新是异步的，快速双击可能在重渲染前就进来第二次
  const busyRef = useRef(false);

  const exportHtml = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setExporting(true);
    try {
      const root = document.documentElement;
      const theme = root.getAttribute("data-theme") || "ocean";
      const appearance = root.getAttribute("data-appearance");

      const { html: bodyHtml, fields, warnings } = await renderMarkdownForExport(input.text, {
        baseDir: input.baseDir,
        theme,
      });

      if (!bodyHtml.trim()) {
        toast("文档是空的，没有可导出的内容", "error");
        return;
      }

      const title = stripExt(input.fileName);
      const doc = buildHtmlDocument({
        title,
        bodyHtml,
        css: `${mdCssText}\n${codeCssText}`,
        // 哈希类名缺失时退回 md 会让样式全丢，但至少不会崩；正常构建不会走到
        rootClass: mdStyles.md ?? "md",
        theme: { name: theme, appearance, vars: collectThemeVars() },
        docId: makeDocId(),
        fields,
        // 没有可填字段就不嵌任何脚本，纯阅读的导出保持零 JS
        runtimeJs: fields.length > 0 ? EXPORT_RUNTIME : undefined,
        sourceName: input.fileName,
      });

      const path = await saveDialog({
        defaultPath: `${title}.html`,
        filters: [{ name: "HTML 文件", extensions: ["html"] }],
      });
      if (!path) return;

      await writeTextFile(path, doc);
      if (warnings.length > 0) {
        toast(`已导出，但有 ${warnings.length} 项提示：${warnings[0]}`, "success");
      } else {
        toast("已导出到 " + path, "success");
      }
    } catch (e) {
      toast("导出失败：" + errText(e, "未知错误"), "error");
    } finally {
      busyRef.current = false;
      setExporting(false);
    }
  }, [input.text, input.baseDir, input.fileName, toast]);

  return { exportHtml, exporting };
}
