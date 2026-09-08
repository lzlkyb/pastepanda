/**
 * 统一内容类型映射 — 唯一来源，Card/ContextMenu/EditDialog 共用。
 * content_type 由 Rust ContentClassifier 在插入时计算并持久化。
 *
 * 色彩部分归 `@/lib/palette` 管（规范：`docs/PastePanda-色彩规范.md`）。
 */
import { HUE, FALLBACK_HUES } from "@/lib/palette";

export type ContentType =
  | "text" | "link" | "email" | "phone" | "color" | "file_path"
  | "code" | "json" | "markdown" | "html" | "config" | "csv"
  | "shell" | "log" | "secret" | "number" | "image" | "file" | "diagram";

export interface ContentTypeMeta {
  /** 中文显示标签 */
  label: string;
  /** 图标颜色 (hex) */
  color: string;
  /** 是否使用等宽字体预览 */
  monospace: boolean;
}

/** content_type → 显示元信息。
 *
 * 🔴 颜色一律引 `HUE`（规范第 1 层），**不写裸 hex**。
 * 2026-09-08 改引用时一个色值都没变——它们本来就是 Tailwind 500 档，
 * 只是以前散写在这里、`TagEditor`、`tag.rs` 三处，靠人工同步。
 *
 * ❗ `text` 是灰，所以它**不能直接拿来给图标上色**——用了等于没上色。
 * 这正是 `noteIconColor()` 与 `Card.tsx` 都要对 `text` 回退到哈希的原因。
 */
export const CONTENT_TYPE_META: Record<ContentType, ContentTypeMeta> = {
  text:      { label: "文本",     color: HUE.gray,    monospace: false },
  link:      { label: "链接",     color: HUE.emerald, monospace: false },
  email:     { label: "邮箱",     color: HUE.blue,    monospace: false },
  phone:     { label: "电话",     color: HUE.amber,   monospace: false },
  color:     { label: "颜色",     color: HUE.pink,    monospace: false },
  file_path: { label: "路径",     color: HUE.cyan,    monospace: true },
  code:      { label: "代码",     color: HUE.violet,  monospace: true },
  json:      { label: "JSON",    color: HUE.orange,  monospace: true },
  markdown:  { label: "Markdown", color: HUE.indigo, monospace: false },
  html:      { label: "HTML",    color: HUE.red,     monospace: true },
  config:    { label: "配置",     color: HUE.teal,    monospace: true },
  csv:       { label: "表格",     color: HUE.lime,    monospace: true },
  shell:     { label: "命令",     color: HUE.purple,  monospace: true },
  log:       { label: "日志",     color: HUE.stone,   monospace: true },
  secret:    { label: "密钥",     color: HUE.redDeep, monospace: true },
  number:    { label: "数字",     color: HUE.sky,     monospace: true },
  image:     { label: "图片",     color: HUE.pink,    monospace: false },
  file:      { label: "文件",     color: HUE.cyan,    monospace: false },
  diagram:   { label: "流程图",   color: HUE.sky,     monospace: false },
};

/** 获取 content_type 的元信息（容错：未知类型回退到 text） */
export function getContentTypeMeta(contentType?: string): ContentTypeMeta {
  return CONTENT_TYPE_META[(contentType || "text") as ContentType] || CONTENT_TYPE_META.text;
}

/** 判断是否为代码类（用于语法高亮决策） */
export function isCodeLike(contentType?: string): boolean {
  return ["code", "json", "html", "config", "csv", "shell", "log"].includes(contentType || "");
}

/** 判断是否应遮罩显示（密钥类） */
export function isSecret(contentType?: string): boolean {
  return contentType === "secret";
}


/**
 * 把一段文本稳定地映到一个颜色。
 *
 * ❗ 原来是 `Card.tsx` 里的**私有**函数（连同 `PALETTE`）。搬到这里是因为
 * 知识库的行/卡片图标也要用它，而在那边再写一份就是第二份调色盘（规则 #11）：
 * 两份一旦分家，同一条内容在两个模式里就是不同颜色——而那正是本轮要消的问题。
 *
 * 哈希而不是随机：同一篇笔记每次渲染必须是同一个颜色，
 * 否则滚一下列表颜色全变，比没有颜色还糟。
 */
export function hashColor(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return FALLBACK_HUES[Math.abs(h) % FALLBACK_HUES.length];
}

/**
 * 笔记图标的颜色。
 *
 * 规则与记录模式（`Card.tsx`）逐条对齐：有类型就用类型色，
 * `text` 除外——它在表里的色是 `#6B7280`（灰），用了等于没上色，
 * 所以回退到哈希。记录模式当初就是为这个才引入 `hashColor` 的。
 *
 * ❗ `source_kind` 在**主列表里恒为空**：它不是 `notes` 表的列，
 * 而是 `note_list_deleted`（回收站）那条查询 `LEFT JOIN history` 算出来的。
 * 所以实际效果是：回收站按类型上色，主列表全走哈希。
 *
 * 🔴 **没给主列表补那个 join 是有意的**：真实库 26 篇里只有 2 篇是剪贴板转来的
 * （2026-09-08 实测）。为了 2 行的准确色，在主列表热路径上多一个 join——
 * 而那把 SQLite 锁与主界面共用——不划算。而且反直觉的是：全走哈希反而**更花**，
 * 因为那 24 篇手工笔记按类型全是 `text` = 灰。将来真需要再补 join。
 *
 * 取 `title || id` 而不是正文：标题改了颜色跟着变是可接受的，
 * 而拿整篇正文去哈希意味着**每改一个字颜色就跳**，那很吵；
 * 且长文笔记每行都要扫几万字符。无标题时用 id（永不变）而不是空串，
 * 否则所有无标题笔记会撑成同一个颜色。
 */
export function noteIconColor(note: { title?: string | null; id: string; source_kind?: string | null }): string {
  const kind = note.source_kind;
  if (kind && kind !== "text") return getContentTypeMeta(kind).color;
  return hashColor(note.title || note.id);
}
