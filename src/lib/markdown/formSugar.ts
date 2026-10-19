/**
 * `{{字段}}` 表单语法糖 —— 把 Markdown 里的占位符变成可填控件。
 *
 * 为什么要有这一层：原生 HTML 标签（`<input name="x">`）能表达一切，但写在正文里
 * 又长又吵，业务模板里一行一个字段会完全看不清结构。语法糖只解决「常见字段」，
 * 复杂控件（下拉、多行、日期、数字、勾选）也一并给到，剩下的仍可直接写 HTML。
 *
 * 语法：
 *   {{姓名}}            单行文本
 *   {{备注/多行}}        多行文本（rows=3）
 *   {{日期/日期}}        日期选择
 *   {{数量/数字}}        数字输入
 *   {{同意条款/勾选}}     复选框（文字就是字段名）
 *   {{状态|待处理|已完成}} 下拉（第一个 `|` 之后都是选项）
 *
 * 只在 **inline** 层匹配，所以代码块/行内代码里的 `{{...}}` 天然不受影响；
 * 也刻意不接受含 `<` `>` `{` `}` 换行的内容，避免误伤模板语法示例。
 */
import type { MarkedExtension, Tokens } from "marked";
import { escapeHtml } from "./html";

/** 字段名最大长度：太长的多半是模板语法而不是字段 */
const MAX_NAME = 40;

export interface FormSugarToken {
  type: "ppFormSugar";
  raw: string;
  /** 字段名（同时用作 name 与默认 placeholder） */
  head: string;
  /** 控件类型关键字（多行/日期/数字/勾选），空表示单行文本 */
  mode: string;
  /** 下拉选项（`|` 分隔） */
  options: string[];
}

function renderToken(token: FormSugarToken): string {
  const name = escapeHtml(token.head);
  const ph = escapeHtml(token.head);

  if (token.options.length > 0) {
    const opts = token.options
      .map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`)
      .join("");
    return (
      `<select class="md-fill" name="${name}">` +
      `<option value="">请选择</option>${opts}</select>`
    );
  }

  switch (token.mode) {
    case "多行":
    case "textarea":
      return `<textarea class="md-fill md-fill-area" name="${name}" rows="3" placeholder="${ph}"></textarea>`;
    case "日期":
    case "date":
      return `<input class="md-fill" type="date" name="${name}">`;
    case "数字":
    case "number":
      return `<input class="md-fill" type="number" name="${name}" placeholder="${ph}">`;
    case "勾选":
    case "check":
      return `<label class="md-fill-check"><input type="checkbox" name="${name}"> <span>${ph}</span></label>`;
    default:
      return `<input class="md-fill" type="text" name="${name}" placeholder="${ph}">`;
  }
}

/**
 * 解析 `{{...}}` 的内容。
 * 导出与渲染共用这一份，保证「预览里长什么样、导出就是什么样」。
 */
export function parseFormSugar(body: string): Omit<FormSugarToken, "type" | "raw"> | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  const segments = trimmed.split("|").map((s) => s.trim());
  let head = segments[0];
  const options = segments.slice(1).filter(Boolean);

  let mode = "";
  const slash = head.split("/");
  if (slash.length === 2) {
    head = slash[0].trim();
    mode = slash[1].trim();
  }
  if (!head || head.length > MAX_NAME) return null;
  return { head, mode, options };
}

/**
 * marked 扩展。必须包在 `extensions: [...]` 里 —— 直接 `marked.use(ext)` 会被
 * 当成 RendererObject（要求键是 renderer 的方法名），类型与运行时都不生效。
 */
export const FORM_SUGAR_EXT: MarkedExtension = {
  extensions: [
    {
      name: "ppFormSugar",
      level: "inline" as const,
      start(src: string): number | undefined {
        const i = src.indexOf("{{");
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string): FormSugarToken | undefined {
        const m = /^\{\{([^{}\n<>]{1,40})\}\}/.exec(src);
        if (!m) return undefined;
        const parsed = parseFormSugar(m[1]);
        if (!parsed) return undefined;
        return { type: "ppFormSugar", raw: m[0], ...parsed };
      },
      renderer(token: Tokens.Generic): string {
        return renderToken(token as unknown as FormSugarToken);
      },
    },
  ],
};
