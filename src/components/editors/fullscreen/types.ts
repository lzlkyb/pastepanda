/**
 * 全屏编辑器通用外壳 — 类型定义。
 *
 * 架构：FullscreenEditor（外壳）按内容类型消费 FullscreenTypeSpec，
 * 外壳 100% 复用（工具栏/保存/自动保存/主题跟随/关闭守卫/状态栏/查找替换/分栏拖拽），
 * 各类型仅差异：语言模式 / 视图形态 / 格式栏 / 预览面板。
 */
import type { ComponentType } from "react";
import type { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/** 支持全屏编辑的内容类型 */
export type FullscreenType = "markdown" | "json" | "html" | "text" | "csv" | "code" | "log";

/** 视图模式：仅编辑 / 分栏 / 仅预览（csv 的"预览"即表格视图） */
export type ViewMode = "edit" | "split" | "preview";

/**
 * 外壳传递给类型专属格式栏的能力桥。
 * 格式栏据此操作 CodeMirror 文档（外壳持有 view，格式栏无需自行管理）。
 */
export interface ShellBridge {
  /** 当前文档全文 */
  text: string;
  /** 整体替换文档（经 CodeMirror dispatch，自动触发脏标记/自动保存） */
  replaceDoc: (next: string) => void;
  /** 跳转到指定行并居中显示（1 起；JSON 错误徽章点击定位用） */
  gotoLine: (line: number) => void;
  /** 在选区前后包裹（如加粗 **|** ） */
  insertFormat: (before: string, after?: string) => void;
  /** 给当前行加前缀（如标题 ## ） */
  insertLinePrefix: (prefix: string) => void;
  /** 切换选区/当前行注释（跟随语言语法；代码类格式栏用） */
  toggleComment: () => void;
  /** 选区行增加缩进 */
  indentMore: () => void;
  /** 选区行减少缩进 */
  indentLess: () => void;
}

/** 语言模式工厂上下文：外壳把运行期能力注入给类型专属扩展 */
export interface ExtensionCtx {
  /** 图片粘贴/拖入处理（markdown 专属，保存并插入引用） */
  insertPastedImages: (files: File[], view: EditorView) => void;
}

/** 视图模式按钮定义（工具栏切换器按此渲染） */
export interface SpecMode {
  key: ViewMode;
  title: string;
  /** lucide 图标组件 */
  Icon: ComponentType<{ size?: number }>;
}

/** 类型规格：描述一个内容类型在全屏外壳中的全部差异点 */
export interface FullscreenTypeSpec {
  key: FullscreenType;
  /** 工具栏 fileIcon 字符 */
  icon: string;
  /** 状态栏类型标签 */
  label: string;
  /** 新建文档默认名 */
  defaultFileName: string;
  /** 打开/另存为对话框文件过滤 */
  fileFilter: { name: string; extensions: string[] };
  /** CodeMirror 语言模式（及类型专属扩展，如 markdown 的图片粘贴） */
  language: (ctx: ExtensionCtx) => Extension;
  /**
   * 动态语言模式（code 类型专用）：为 true 时外壳不挂载 spec.language，
   * 改为按运行期语言名（init.language / 用户手动选择）从 @codemirror/language-data
   * 懒加载对应模式，并在工具栏渲染语言选择器、状态栏显示当前语言。
   */
  dynamicLanguage?: boolean;
  /** 可用视图模式（按序渲染切换按钮） */
  modes: SpecMode[];
  /** 默认视图模式 */
  defaultMode: ViewMode;
  /** 类型专属格式栏（不传 = 无格式栏） */
  FormatBar?: ComponentType<{ bridge: ShellBridge }>;
  /** 预览面板组件（不传 = 无预览，仅编辑模式；bridge 可选，供需要跳转编辑区的预览使用；
   *  lineNumbers 行号模式开关，仅 markdown 预览消费，其余类型忽略） */
  Preview?: ComponentType<{ text: string; bridge?: ShellBridge; lineNumbers?: boolean }>;
  /** 预览面板副标签 */
  previewSubLabel?: string;
  /**
   * 预览面板是否铺满（true = 无内边距、容器不滚动，由预览组件自行填充/滚动，
   * 适用于 iframe / 表格；默认 false = 带内边距的滚动文本预览）。
   */
  previewFill?: boolean;
  /** 是否启用编辑区↔预览区滚动同步（仅 markdown 有意义） */
  scrollSync?: boolean;
}
