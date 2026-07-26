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
const ImageEditor = lazy(() =>
  import("@/components/editors/ImageEditor").then((m) => ({ default: m.ImageEditor }))
);
const FileEditor = lazy(() =>
  import("@/components/FileDetailDialog").then((m) => ({ default: m.FileDetailDialog }))
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
};

const DEFAULT_EDITOR: EditorDefinition = {
  component: TextEditor, width: "w420", title: "✏️ 编辑记录", footer: ["copy", "paste", "snippet"],
};

/** item.type → customShell 编辑器（图片/文件：富交互弹窗，自带外壳） */
const TYPE_EDITORS: Partial<Record<HistoryItem["type"], EditorDefinition>> = {
  image: { customShell: true, component: ImageEditor },
  file: { customShell: true, component: FileEditor },
};

/** 按 item 的 type + content_type 分派编辑器（type 优先，文本类按 content_type） */
export function resolveEditor(item: HistoryItem): EditorDefinition {
  return TYPE_EDITORS[item.type] || EDITOR_REGISTRY[item.content_type || ""] || DEFAULT_EDITOR;
}
