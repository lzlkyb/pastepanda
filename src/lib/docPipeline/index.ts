/**
 * docPipeline/index.ts — 文档内容处理管线统一出口。
 *
 * 四个纯函数模块：清洗 / 转 Markdown / 表格 / PDF 修复。
 * 被变换枢纽（docTransforms.ts）和未来的 DocEditor 三态预览消费。
 */

export { sanitizeDocHtml } from "./sanitizeDoc";
export { htmlToMarkdown } from "./htmlToMarkdown";
export { hasMergedCells, htmlTableToGfm, htmlAllTablesToGfm } from "./tables";
export { repairPdfText, looksLikePdfText } from "./pdfRepair";
