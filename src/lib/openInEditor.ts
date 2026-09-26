/**
 * 「在全屏编辑器里打开一份文档」的**唯一入口**（claude.md 规则 11.1 收口）。
 *
 * 改造前有 11 处直接 `invoke("open_fullscreen_editor", {...})`，参数形状靠每处自己拼。
 * 失败形态是静默的：漏传 `language` 时 code 类型的全屏编辑器会退化成纯文本，
 * 界面上完全看不出为什么；漏传 `contentType` 则整份文档按 markdown 渲染。
 * 现在字段只在下面这一处定义，调用方只描述「打开什么」。
 */
import { invoke } from "@tauri-apps/api/core";

export interface OpenInEditorOptions {
  /** 来源剪贴板卡片 id（从卡片进入时有值，保存时回写该条记录） */
  sourceId?: string | null;
  /** 初始文本内容（从卡片进入时为卡片 text） */
  content?: string | null;
  /** 文件路径（从文件关联 / 文件详情进入时有值） */
  filePath?: string | null;
  /** 决定语言模式与视图形态；缺省由 Rust 侧回退 markdown */
  contentType?: string | null;
  /** 语言提示（如 "Rust"），code 类型据此懒加载 CodeMirror 语言模式 */
  language?: string | null;
}

/**
 * 打开（或复用）全屏编辑器窗口。
 *
 * **失败照旧 reject**（不做吞错）：本函数只收口**参数形状**，不改各调用点原有的
 * 错误语义 —— 它们各自有不同处置（editorBits 弹 toast、DocEditor 静默继续用弹窗、
 * 自由文本对比失败要留着模态），吞错会把那些分支变成永远不会走的死代码。
 *
 * 也不做「已有标签就切过去」的判断——那是前端标签层的职责（只有编辑器窗口自己
 * 知道现在开着哪些标签）。这里只负责把请求送到后端：窗口不存在时建窗、已存在时
 * 经 `md-editor-load` 事件推给前端标签层。
 */
export function openInEditor(opts: OpenInEditorOptions): Promise<void> {
  return invoke("open_fullscreen_editor", {
    sourceId: opts.sourceId ?? null,
    content: opts.content ?? null,
    filePath: opts.filePath ?? null,
    contentType: opts.contentType ?? null,
    language: opts.language ?? null,
  });
}
