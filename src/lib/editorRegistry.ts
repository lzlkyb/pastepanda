/**
 * 编辑器注册表 — 方案 A 核心：按内容类型分派专用编辑器。
 *
 * 架构：
 *   resolveEditor(item) → EditorDefinition（判别联合）
 *   - shell 变体：ItemEditorDialog 共享外壳渲染（遮罩/动画/焦点陷阱/Esc/
 *     Ctrl+Enter/未保存确认/footer 按钮），主体经 registerActions 上报能力；
 *   - customShell 变体：组件自带完整弹窗（backdrop/header/footer），
 *     外壳仅负责挂载（图片/文件等富交互弹窗，footer 动作集与文本类差异大）。
 *
 * 分期路线：
 *   P1：TextEditor（通用文本/代码）+ MarkdownEditor ✅
 *   P2：JsonEditor（校验+格式化/压缩）+ HtmlEditor（沙箱渲染预览）✅
 *   P3：ImageEditor / FileEditor（迁入现有 ImagePreviewDialog / FileDetailDialog）✅
 *   P4：color / csv / secret 专用编辑器 ✅
 *   P5：link / file_path 动作化编辑器（URL 结构拆解 / 路径面包屑 + 系统动作）✅
 *   P6：number 数字工具箱（时间戳 / 进制 / 字节速览）✅
 */
import { lazy, type ComponentType } from "react";
import type { HistoryItem } from "@/stores/appStore";
import { isSqlLike, isSvgLike } from "@/lib/utils";

/** footer 可声明的动作按钮（save 恒显示，无需声明） */
export type FooterAction = "copy" | "paste" | "snippet";

/** 编辑器主体注册给外壳的能力（外壳驱动 footer 按钮 / 快捷键 / 关闭守卫） */
export interface EditorActions {
  /** 保存当前内容，返回是否成功（toast 由实现方负责，成功后外壳负责关闭） */
  save?: () => Promise<boolean>;
  /** 复制当前内容到剪贴板 */
  copy?: () => void;
  /** 粘贴当前内容到目标窗口 */
  paste?: () => void;
  /** 存入片段库 */
  addSnippet?: () => void;
  /** 是否有未保存修改（关闭守卫用） */
  isDirty?: () => boolean;
}

/** shell 变体编辑器主体契约 */
export interface EditorProps {
  item: HistoryItem;
  registerActions: (actions: EditorActions) => void;
}

/** customShell 变体编辑器契约（自带弹窗外壳） */
export interface CustomEditorProps {
  item: HistoryItem;
  onClose: () => void;
}

/** shell 变体：共享外壳 + 编辑器主体 */
export interface ShellEditorDefinition {
  customShell?: false;
  /** 编辑器主体组件（lazy 加载） */
  component: ComponentType<EditorProps>;
  /** dialog-box 宽度 class（如 "w420"） */
  width: string;
  /** 弹窗标题（含图标） */
  title: string;
  /** footer 显示的动作按钮（实现由主体经 registerActions 上报） */
  footer: FooterAction[];
}

/** customShell 变体：组件自带 backdrop/header/footer，外壳只挂载 */
export interface CustomShellEditorDefinition {
  customShell: true;
  component: ComponentType<CustomEditorProps>;
}

export type EditorDefinition = ShellEditorDefinition | CustomShellEditorDefinition;

const TextEditor = lazy(() =>
  import("@/components/editors/TextEditor").then((m) => ({ default: m.TextEditor }))
);
const MarkdownEditor = lazy(() =>
  import("@/components/editors/MarkdownEditor").then((m) => ({ default: m.MarkdownEditor }))
);
const JsonEditor = lazy(() =>
  import("@/components/editors/JsonEditor").then((m) => ({ default: m.JsonEditor }))
);
const HtmlEditor = lazy(() =>
  import("@/components/editors/HtmlEditor").then((m) => ({ default: m.HtmlEditor }))
);
const ColorEditor = lazy(() =>
  import("@/components/editors/ColorEditor").then((m) => ({ default: m.ColorEditor }))
);
const CsvEditor = lazy(() =>
  import("@/components/editors/CsvEditor").then((m) => ({ default: m.CsvEditor }))
);
const SecretEditor = lazy(() =>
  import("@/components/editors/SecretEditor").then((m) => ({ default: m.SecretEditor }))
);
const LinkEditor = lazy(() =>
  import("@/components/editors/LinkEditor").then((m) => ({ default: m.LinkEditor }))
);
const PathEditor = lazy(() =>
  import("@/components/editors/PathEditor").then((m) => ({ default: m.PathEditor }))
);
const NumberEditor = lazy(() =>
  import("@/components/editors/NumberEditor").then((m) => ({ default: m.NumberEditor }))
);
const CodeEditor = lazy(() =>
  import("@/components/editors/CodeEditor").then((m) => ({ default: m.CodeEditor }))
);
const SqlEditor = lazy(() =>
  import("@/components/editors/SqlEditor").then((m) => ({ default: m.SqlEditor }))
);
const LogEditor = lazy(() =>
  import("@/components/editors/LogEditor").then((m) => ({ default: m.LogEditor }))
);
const ImageEditor = lazy(() =>
  import("@/components/editors/ImageEditor").then((m) => ({ default: m.ImageEditor }))
);
const RichEditor = lazy(() =>
  import("@/components/editors/RichEditor").then((m) => ({ default: m.RichEditor }))
);
const DocEditor = lazy(() =>
  import("@/components/editors/DocEditor").then((m) => ({ default: m.DocEditor }))
);
const DiagramEditor = lazy(() =>
  import("@/components/editors/DiagramEditor").then((m) => ({ default: m.DiagramEditor }))
);
const FileEditor = lazy(() =>
  import("@/components/FileDetailDialog").then((m) => ({ default: m.FileDetailDialog }))
);
const ContactEditor = lazy(() =>
  import("@/components/editors/ContactEditor").then((m) => ({ default: m.ContactEditor }))
);
const ConfigEditor = lazy(() =>
  import("@/components/editors/ConfigEditor").then((m) => ({ default: m.ConfigEditor }))
);
const SvgEditor = lazy(() =>
  import("@/components/editors/SvgEditor").then((m) => ({ default: m.SvgEditor }))
);

/** content_type → 编辑器定义（未注册类型回退通用文本编辑器） */
const EDITOR_REGISTRY: Partial<Record<string, EditorDefinition>> = {
  markdown: { component: MarkdownEditor, width: "w420", title: "📝 编辑记录", footer: ["copy", "paste", "snippet"] },
  json: { component: JsonEditor, width: "w420", title: "🧩 编辑 JSON", footer: ["copy", "paste", "snippet"] },
  html: { component: HtmlEditor, width: "w420", title: "🌐 编辑 HTML", footer: ["copy", "paste", "snippet"] },
  color: { component: ColorEditor, width: "w420", title: "🎨 编辑颜色", footer: ["copy", "paste", "snippet"] },
  csv: { component: CsvEditor, width: "w420", title: "📊 编辑表格", footer: ["copy", "paste", "snippet"] },
  secret: { component: SecretEditor, width: "w420", title: "🔑 编辑密钥", footer: ["copy", "paste", "snippet"] },
  link: { component: LinkEditor, width: "w420", title: "🔗 编辑链接", footer: ["copy", "paste", "snippet"] },
  file_path: { component: PathEditor, width: "w420", title: "📁 编辑路径", footer: ["copy", "paste", "snippet"] },
  number: { component: NumberEditor, width: "w420", title: "🔢 编辑数字", footer: ["copy", "paste", "snippet"] },
  // 编辑器增量 P1：SQL 编辑器（CodeMirror 高亮 + 本地只读语法校验）
  sql: { component: SqlEditor, width: "w420", title: "🗄 编辑 SQL", footer: ["copy", "paste", "snippet"] },
  // Tier0：code/shell 专用编辑器（语言锁定 + 自动高亮 + 变换工具栏）
  code: { component: CodeEditor, width: "w420", title: "💻 编辑代码", footer: ["copy", "paste", "snippet"] },
  shell: { component: CodeEditor, width: "w420", title: "⌨️ 编辑命令", footer: ["copy", "paste", "snippet"] },
  // Tier2：配置结构化编辑器（表格视图解析 .env/ini/通用 key:value + 原文高亮双视图）
  config: { component: ConfigEditor, width: "w420", title: "⚙️ 编辑配置", footer: ["copy", "paste", "snippet"] },
  // Tier1：日志编辑器（复用 logParser.ts：级别过滤 + 关键字高亮 + 续行归属）
  log: { component: LogEditor, width: "w520", title: "📜 编辑日志", footer: ["copy", "paste", "snippet"] },
  // Tier1：联系人编辑器（接管 email/phone：校验 + 唤起 mailto:/tel: + 复制为 URI）
  email: { component: ContactEditor, width: "w420", title: "📧 编辑邮箱", footer: ["copy", "paste", "snippet"] },
  phone: { component: ContactEditor, width: "w420", title: "📞 编辑电话", footer: ["copy", "paste", "snippet"] },
  // Tier2：SVG 源码双向编辑器（分类器不产出 "svg"，由 resolveEditor 的 isSvgLike 特判路由）
  svg: { component: SvgEditor, width: "w420", title: "🖼 编辑 SVG", footer: ["copy", "paste", "snippet"] },
};

const DEFAULT_EDITOR: EditorDefinition = {
  component: TextEditor, width: "w420", title: "✏️ 编辑记录", footer: ["copy", "paste", "snippet"],
};

/** item.type → customShell 编辑器（图片/文件：富交互弹窗，自带外壳） */
const TYPE_EDITORS: Partial<Record<HistoryItem["type"], EditorDefinition>> = {
  image: { customShell: true, component: ImageEditor },
  file: { customShell: true, component: FileEditor },
  // 图文混排走 shell 变体：与文本类一样需要外壳的保存/未保存确认/Ctrl+Enter，
  // 不像图片/文件那样需要自带完整弹窗。snippet 不提供（片段库只存纯文本）。
  rich: { component: RichEditor, width: "w520", title: "🖼️📝 编辑图文", footer: ["copy", "paste"] },
  // P4：结构化文档三态预览（原文/清洗/Markdown），与 rich 同走 shell 变体
  doc: { component: DocEditor, width: "w520", title: "📄 编辑文档", footer: ["copy", "paste"] },
  // 流程图：拖拽画布为首要路径，走 shell 变体（与图文一致：外壳保保存/未保存确认/Ctrl+Enter），
  // 另提供「全屏」按钮跳到 OS 全屏窗口（DiagramFullscreen）。节点属性/连线在画布内完成。
  diagram: { component: DiagramEditor, width: "wDiagram", title: "📊 编辑流程图", footer: ["copy"] },
};

/** 按 item 的 type + content_type 分派编辑器（type 优先，文本类按 content_type） */
export function resolveEditor(item: HistoryItem): EditorDefinition {
  // type 必须先判：SQL / SVG 两个特判只针对文本类内容，插到 type 之前会把
  // doc（三态文档预览）/ rich（图文编辑）这类条目——只要 content_type 恰好是 code
  // 且正文里有两个 SQL 关键字——错误路由到 SqlEditor，丢掉它们专属的编辑形态。
  const byType = TYPE_EDITORS[item.type];
  if (byType) return byType;

  const ct = item.content_type || "";
  // 分类器把 SQL 归到 code，但值得用专用 SQL 编辑器（只读语法校验）。
  // 这样 SqlEditor 不再是从未可达的孤儿（分类器从不产出 "sql"）。
  if (ct === "code" && isSqlLike(item.text || "")) {
    return EDITOR_REGISTRY.sql!;
  }
  // 分类器不产出 "svg"：对 code/html/text 中以 <svg 开头的独立 SVG 文档特判路由（同 SQL 孤儿修复范式）。
  // 普通 HTML 文档/纯文本不以 <svg 开头，不会误判。
  if ((ct === "code" || ct === "html" || ct === "text") && isSvgLike(item.text || "")) {
    return EDITOR_REGISTRY.svg!;
  }
  return EDITOR_REGISTRY[ct] || DEFAULT_EDITOR;
}
