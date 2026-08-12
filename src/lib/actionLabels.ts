/**
 * lib/actionLabels.ts —— 动作 id / 内容类型 → 中文名（自进化弹窗、快捷区等统一使用）。
 * 未知 id 兜底显示原 id（宁可丑，不错标）。
 */

export const ACTION_LABELS: Record<string, string> = {
  // AI 六大王牌
  "ai-translate": "翻译",
  "ai-summarize": "总结",
  "ai-rewrite": "改写语气",
  "ai-key-points": "提取要点",
  "ai-reply-draft": "回复草稿",
  "mask-sensitive": "粘贴脱敏",
  "url-summary": "链接摘要",
  "ai-explain-code": "代码解释",
  // 本地 / 常用变换
  upper: "转大写",
  lower: "转小写",
  strip: "清理空白",
  "json-insert": "JSON 生成",
  "sql-in": "生成 SQL",
  "sql-in-reverse": "SQL 转中文",
  "column-to-sql-in": "列转 SQL IN",
  "delimited-to-sql-in": "分隔符转 SQL IN",
  "query-result-to-sql": "查询结果转 SQL",
  "act-open-url": "打开链接",
  "act-mailto": "写信给邮箱",
  "act-lookup": "查词",
  "act-open-path": "打开路径",
};

/**
 * 内容类型 → 中文名。**展示层的单一数据源**，别处不要再手写三元表达式。
 *
 * key 必须与后端真实值一致：粗粒度 `type`（text/image/rich/file/doc）
 * 与细粒度 `content_type`（content_classifier.rs 产出）两套都要能查到。
 *
 * 修正记录（2026-08-11）：原来这里写的是 `"rich-text": "富文本"`，
 * 而后端存的值是 `rich`——那条映射从来没生效过，于是 AI 条直接把
 * 内部 id `rich` 显给用户看。其余类型当时也全部缺失，同样会露出原始 id。
 */
export const CONTENT_TYPE_LABELS: Record<string, string> = {
  // 粗粒度 type
  text: "文本",
  image: "图片",
  rich: "图文",
  file: "文件",
  doc: "文档",
  // 细粒度 content_type
  link: "链接",
  code: "代码",
  json: "JSON",
  markdown: "Markdown",
  html: "HTML",
  csv: "表格",
  config: "配置",
  shell: "命令",
  log: "日志",
  number: "数字",
  email: "邮箱",
  phone: "电话",
  file_path: "文件路径",
  color: "颜色",
  secret: "密钥",
};

/** 动作 id → 中文名（未知兜底原 id） */
export function actionLabel(id: string): string {
  return ACTION_LABELS[id] ?? id;
}

/** 内容类型 → 中文名（未知兜底原值） */
export function contentTypeLabel(t: string): string {
  if (!t) return "所有内容";
  return CONTENT_TYPE_LABELS[t] ?? t;
}
