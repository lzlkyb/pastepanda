/**
 * 全屏编辑器类型注册表：组装各内容类型的 FullscreenTypeSpec。
 * 外壳（FullscreenEditor）按 init 数据里的 contentType 在此查表。
 */
import { lazy, type ComponentType } from "react";
import { PanelLeft, Columns2, Eye, Table, List } from "lucide-react";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { lintGutter } from "@codemirror/lint";
import type { FullscreenType, FullscreenTypeSpec, ExtensionCtx } from "./types";
import { MarkdownFormatBar } from "./MarkdownFormatBar";
import { CodeFormatBar } from "./CodeFormatBar";
import { JsonFormatBar, JsonPreview, jsonLinter } from "./JsonBody";
import { HtmlPreview } from "./HtmlPreview";
import { CsvTablePreview } from "./CsvTablePreview";
import { LogPreview } from "./LogPreview";

// Markdown 预览复用既有 MarkdownRenderer（命名导出 → lazy default 映射，
// marked + DOMPurify 约 71KB 走懒加载，不阻塞编辑器首屏）
const MarkdownRenderer = lazy(() =>
  import("@/components/MarkdownRenderer").then((m) => ({ default: m.MarkdownRenderer }))
);
const MarkdownPreview: ComponentType<{ text: string; lineNumbers?: boolean }> = ({ text, lineNumbers }) => (
  <MarkdownRenderer text={text} debounceMs={300} lineNumbers={lineNumbers} />
);

/** Markdown 专属：拦截图片粘贴/拖入，交给外壳的 insertPastedImages 保存并插入引用 */
function imagePasteExt(insertPastedImages: ExtensionCtx["insertPastedImages"]): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = Array.from(event.clipboardData?.files || []).filter((f) => f.type.startsWith("image/"));
      if (files.length > 0) {
        event.preventDefault();
        void insertPastedImages(files, view);
        return true;
      }
      return false;
    },
    drop(event, view) {
      const files = Array.from(event.dataTransfer?.files || []).filter((f) => f.type.startsWith("image/"));
      if (files.length > 0) {
        event.preventDefault();
        void insertPastedImages(files, view);
        return true;
      }
      return false;
    },
  });
}

/** 三态（编辑/分栏/预览）视图模式定义，markdown/html/json 共用 */
const TRI_MODES = [
  { key: "edit" as const, title: "仅编辑", Icon: PanelLeft },
  { key: "split" as const, title: "分屏", Icon: Columns2 },
  { key: "preview" as const, title: "仅预览", Icon: Eye },
];

export const FULLSCREEN_TYPES: Record<FullscreenType, FullscreenTypeSpec> = {
  markdown: {
    key: "markdown",
    icon: "M↓",
    label: "Markdown",
    defaultFileName: "未命名.md",
    fileFilter: { name: "Markdown", extensions: ["md", "markdown"] },
    language: (ctx) => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      imagePasteExt(ctx.insertPastedImages),
    ],
    modes: TRI_MODES,
    defaultMode: "split",
    FormatBar: MarkdownFormatBar,
    Preview: MarkdownPreview,
    previewSubLabel: "实时渲染",
    scrollSync: true,
  },

  json: {
    key: "json",
    icon: "{}",
    label: "JSON",
    defaultFileName: "未命名.json",
    fileFilter: { name: "JSON", extensions: ["json"] },
    language: () => [json(), jsonLinter, lintGutter()],
    modes: TRI_MODES,
    defaultMode: "split",
    FormatBar: JsonFormatBar,
    Preview: JsonPreview,
    previewSubLabel: "结构树 · 实时",
    previewFill: true,
  },

  html: {
    key: "html",
    icon: "<>",
    label: "HTML",
    defaultFileName: "未命名.html",
    fileFilter: { name: "HTML", extensions: ["html", "htm"] },
    language: () => html(),
    modes: TRI_MODES,
    defaultMode: "split",
    Preview: HtmlPreview,
    previewSubLabel: "沙箱渲染 · 已消毒",
    previewFill: true,
  },

  text: {
    key: "text",
    icon: "✏️",
    label: "纯文本",
    defaultFileName: "未命名.txt",
    fileFilter: { name: "所有文件", extensions: ["*"] },
    language: () => [],
    modes: [{ key: "edit" as const, title: "仅编辑", Icon: PanelLeft }],
    defaultMode: "edit",
  },

  csv: {
    key: "csv",
    icon: "📊",
    label: "表格",
    defaultFileName: "未命名.csv",
    fileFilter: { name: "CSV / TSV", extensions: ["csv", "tsv", "txt"] },
    language: () => [],
    modes: [
      { key: "edit" as const, title: "编辑源码", Icon: PanelLeft },
      { key: "preview" as const, title: "表格视图", Icon: Table },
    ],
    defaultMode: "preview",
    Preview: CsvTablePreview,
    previewSubLabel: "表格视图",
    previewFill: true,
  },

  log: {
    key: "log",
    icon: "☰",
    label: "日志",
    defaultFileName: "未命名.log",
    fileFilter: { name: "日志", extensions: ["log", "txt"] },
    language: () => [],
    modes: [
      { key: "edit" as const, title: "编辑源码", Icon: PanelLeft },
      { key: "split" as const, title: "分屏", Icon: Columns2 },
      { key: "preview" as const, title: "日志视图", Icon: List },
    ],
    defaultMode: "preview",
    Preview: LogPreview,
    previewSubLabel: "级别过滤 · 实时",
    previewFill: true,
  },

  code: {
    key: "code",
    icon: "</>",
    label: "代码",
    defaultFileName: "未命名.txt",
    fileFilter: { name: "所有文件", extensions: ["*"] },
    // 动态语言：不在此处挂载静态模式，外壳按 languageName 从 language-data 懒加载
    language: () => [],
    dynamicLanguage: true,
    modes: [{ key: "edit" as const, title: "仅编辑", Icon: PanelLeft }],
    defaultMode: "edit",
    FormatBar: CodeFormatBar,
  },

  // 流程图：实际走独立全屏窗口（DiagramFullscreen，绕开 CodeMirror），
  // 这里仅登记最小规格，避免 resolveFullscreenType 回退到 text。
  diagram: {
    key: "diagram",
    icon: "📊",
    label: "流程图",
    defaultFileName: "未命名.panda",
    fileFilter: { name: "PastePanda 流程图", extensions: ["panda"] },
    language: () => [],
    modes: [{ key: "edit" as const, title: "仅编辑", Icon: PanelLeft }],
    defaultMode: "edit",
  },
};

/** 走代码编辑器的内容类型（代码 / 配置文件 / 命令行） */
const CODE_CONTENT_TYPES = new Set(["code", "config", "shell", "sql"]);
/** 暂无专属编辑器、按纯文本处理的内容类型（避免误回退 markdown 语法模式） */
const TEXT_CONTENT_TYPES = new Set(["number", "link", "email", "phone", "file_path", "secret"]);

/**
 * 按 contentType 解析类型规格：
 * - 空值 → markdown（兼容既有 .md 文件关联）
 * - code/config/shell → code（动态语言模式）
 * - 已注册类型 → 对应规格；其余 → text
 */
export function resolveFullscreenType(contentType: string | null | undefined): FullscreenTypeSpec {
  if (!contentType) return FULLSCREEN_TYPES.markdown;
  if (CODE_CONTENT_TYPES.has(contentType)) return FULLSCREEN_TYPES.code;
  if (TEXT_CONTENT_TYPES.has(contentType)) return FULLSCREEN_TYPES.text;
  return FULLSCREEN_TYPES[contentType as FullscreenType] || FULLSCREEN_TYPES.text;
}
