/**
 * transforms/types.ts — 变换注册表的类型定义（纯类型，无运行时依赖）。
 *
 * 设计目标：把"复制源 → 识别 → 变换 → 交付"这条链路抽象成可插拔的 Transform。
 * 每个变换是一个无副作用对象：detect() 评估匹配度，run() 产出可复制的文本。
 * UI（变换枢纽 / 右键 / 编辑器结果条 / 全屏按钮）只消费注册表，不关心具体实现。
 *
 * 为保持逻辑层纯净（与 jsonToolbox / numberToolbox 一致），这里不引入 React/lucide，
 * 图标用语义键（icon 字段）表示，由 UI 层映射为具体组件。
 */

import type { ContentFeatures } from "./analyzer";

/** 变换分组，用于枢纽面板分类展示。`ai` 是唯一需要联网的一组 */
export type TransformGroup = "json" | "sql" | "web" | "text" | "log" | "doc" | "ai";

/** detect() 的输入上下文 */
export interface TransformContext {
  /** 剪贴板原文 */
  text: string;
  /** 后端粗分类：json | number | code | color | text | doc | rich */
  contentType: string;
  /**
   * 预分析特征集（Phase 1 产出）。
   * applicableTransforms() 会自动填充；直接构造 ctx 时可省略（兼容旧调用）。
   * detect() 优先读 features 里的预计算结果，避免重复解析。
   */
  features?: ContentFeatures;
  /**
   * P2 文档管线：doc/rich 条目的 CF_HTML 片段（item.content）。
   * 文档类变换（格式清洗 / 转 Markdown / 表格→GFM）从这里取 HTML 输入；
   * 纯文本变换不读此字段，向后兼容。
   */
  html?: string;
}

/** run() 返回的元信息（供 UI 提示，如"已复制 N 个值"） */
export interface TransformResultMeta {
  count?: number;
  [key: string]: unknown;
}

/** run() 的返回结构 */
export interface TransformResult {
  ok: boolean;
  /** 主产物（用于复制到剪贴板），ok=true 时有值 */
  output?: string;
  /** 失败原因或提示 */
  message?: string;
  meta?: TransformResultMeta;
}

/** 选项规格：供 UI 自动生成可选 chip（如引号风格、包裹格式） */
export interface TransformOptionSpec {
  key: string;
  label: string;
  values: { value: string; label: string }[];
  default?: string;
}

/**
 * 一个变换的完整定义。
 * opts 用宽松的 Record 类型，由各变换内部自行收窄，保证注册表同构。
 */
export interface Transform {
  /** 唯一标识，如 "sql-in" / "json-insert" */
  id: string;
  /** 展示名，如 "SQL IN" */
  label: string;
  /** 一句话描述，枢纽面板副标题用 */
  description?: string;
  /** 图标语义键（如 "database"），UI 层映射为 lucide 组件 */
  icon?: string;
  group: TransformGroup;
  /** 返回 0~1 的匹配度；0 表示不适用。多个变换可同时命中，按分数排序 */
  detect(ctx: TransformContext): number;
  /** 执行变换，返回可复制产物（支持异步：配置转换等调 Rust 侧的变换返回 Promise） */
  run(text: string, opts?: Record<string, unknown>): TransformResult | Promise<TransformResult>;
  /**
   * 可选：标记这是一个**需要联网且可能计费**的变换。
   *
   * UI 要据此把它与本地瞬时变换区分开——后者点下去就出结果，前者会把
   * 剪贴板内容发到外部服务并产生费用，不能长得一模一样。
   */
  remote?: boolean;
  /** 可选：声明支持的选项，供 UI 自动生成 chip */
  options?: TransformOptionSpec[];
  /**
   * 可选：按输入内容动态生成选项规格（优先级高于静态 options）。
   * 用于选项取决于具体数据的场景——如 SQL IN 的可选"字段"来自对象数组的实际字段，
   * 静态 options 无法表达。返回的规格可含按输入计算的 default。
   */
  optionsFor?(ctx: TransformContext): TransformOptionSpec[];
}
