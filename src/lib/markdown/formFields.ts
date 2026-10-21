/**
 * 导出 HTML 的表单字段处理。
 *
 * 这里只做纯字符串运算（不碰 DOM），原因有两个：
 * ① 导出管线在 sanitize **之后** 才需要补 name，此时拿到的是一段可信 HTML 字符串，
 *    用正则可控且能在 node 环境直接单测；
 * ② 字段名必须**按文档顺序稳定**——业务人员填过的值靠 name 对齐，name 一变值就丢。
 *    顺序来源只能是文档顺序，不能来自 Map/对象遍历顺序。
 *
 * 🔴 红线：无 AI、无网络。纯字符串。
 */

/** 会被当作「可填字段」的控件标签。button/submit 不算。 */
const CONTROL_RE = /<(input|textarea|select)\b([^>]*)>/gi;

export type FieldKind = "text" | "textarea" | "select" | "checkbox" | "radio" | "other";

export interface FieldInfo {
  /** 字段名（写入值 JSON 的 key） */
  name: string;
  kind: FieldKind;
  /** 人读标签：placeholder → aria-label → name */
  label: string;
}

/** 从属性串里取某个属性的值（不带引号也能取到） */
function attr(attrs: string, key: string): string | null {
  const re = new RegExp(`(?:^|\\s)${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = attrs.match(re);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? "";
}

function hasAttr(attrs: string, key: string): boolean {
  return new RegExp(`(?:^|\\s)${key}(?:\\s*=|\\s|$)`, "i").test(attrs);
}

function kindOf(tag: string, attrs: string): FieldKind {
  const t = tag.toLowerCase();
  if (t === "textarea") return "textarea";
  if (t === "select") return "select";
  const type = (attr(attrs, "type") || "text").toLowerCase();
  if (type === "checkbox") return "checkbox";
  if (type === "radio") return "radio";
  if (type === "text" || type === "search" || type === "") return "text";
  return "other";
}

/**
 * 给缺 `name` 的控件按文档顺序补 `name="__f{n}"`，并汇总字段清单。
 *
 * - 任务列表的勾选框是**正文结构**不是表单字段：跳过（不补 `name`、不占 `__f{n}` 序号）。
 *   两个标记都要认：`data-task-i` 是预览侧写的（带源码定位），`data-pp-task` 是导出侧
 *   写的（见 exportRender，编号即文档顺序）。导出侧的可勾状态由内嵌运行时的
 *   localStorage 记，跟表单值走两条通道，混进来会让字段序号整体错位。
 * - 已被标记 `data-pp-skip` 的控件同样跳过（给「只想显示、不想入库」的控件留出口）。
 * - `input[type=submit|button|reset|image]` 不是字段。
 *
 * ⚠️ 已知边界：正则按 `>` 断标签，属性值里出现裸 `>` 会被截断。
 *   这种写法在 Markdown 手写场景里几乎不存在（DOMPurify 也会把危险值转义），
 *   换来的是「可以直接在 node 环境测」，值得。
 */
export function ensureFieldNames(html: string): { html: string; fields: FieldInfo[] } {
  const fields: FieldInfo[] = [];
  let seq = 0;

  const out = html.replace(CONTROL_RE, (whole, tag: string, attrs: string) => {
    const tagName = tag.toLowerCase();
    const type = (attr(attrs, "type") || "").toLowerCase();

    // 非字段控件原样返回
    if (hasAttr(attrs, "data-pp-skip")) return whole;
    if (hasAttr(attrs, "data-task-i") || hasAttr(attrs, "data-pp-task")) return whole;
    if (tagName === "input" && ["submit", "button", "reset", "image", "file"].includes(type)) return whole;

    let nextAttrs = attrs;
    let name = attr(attrs, "name");
    if (!name) {
      name = `__f${seq}`;
      nextAttrs = `${attrs} name="${name}"`;
    }
    seq += 1;

    const label = (attr(nextAttrs, "placeholder") || attr(nextAttrs, "aria-label") || name).trim();
    fields.push({ name, kind: kindOf(tagName, nextAttrs), label });
    return `<${tag}${nextAttrs}>`;
  });

  return { html: out, fields };
}

/** 文档指纹：写进导出文件后**永久固定**，用作 localStorage 的 key。
 *
 * 为什么随机而不按内容 hash：每次导出就是一份新表单（模板可能改过），
 * 拿到新文件的人应该从空白开始填；而「同一个文件重新打开」靠的是文件里
 * 已经烧死的这个 id。两件事拆开才不会互相干扰。
 */
export function makeDocId(now = Date.now(), rand = Math.random()): string {
  const r = Math.floor(rand * 0x7fffffff).toString(36);
  return `pp${now.toString(36)}${r}`;
}

/** 值序列化成可直接塞进 `<script type="application/json">` 的 JSON 字符串。
 *
 * 转义 `<` 与行分隔符是**必需**的：正文里贴过 `</script>` 会把标签提前截断，
 * 而 U+2028/2029 在旧引擎的 JSON 字面量里是非法换行。用 \\u 形式转义后，
 * JSON.parse 的结果逐字不变。
 */
export function serializeValues(values: Record<string, unknown>): string {
  return JSON.stringify(values)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
