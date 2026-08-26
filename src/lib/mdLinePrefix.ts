/**
 * Markdown 行首块级前缀的识别与改写。
 *
 * 抽成纯函数是为了能单测 —— “选中五行点列表”这种行为的边界情况（空行、
 * 嵌套缩进、已有不同级别的标题）全在这里，放在组件里只能靠手点。
 */

/**
 * 已知的行首前缀“家族”，**顺序有意义**：先特殊后一般。
 *
 * ❌ 任务列表必须排在无序列表前面：`- [ ] x` 也匹配无序列表的模式，
 * 反过来的话点「任务列表」会只认出 `- `，变成 `- [ ] [ ] x`。
 */
const PREFIX_PATTERNS: RegExp[] = [
  /^(\s*)([-*+] \[[ xX]\] )/, // 任务列表（含已勾选）
  /^(\s*)([-*+] )/, // 无序列表
  /^(\s*)(\d+\. )/, // 有序列表
  /^(\s*)(#{1,6} )/, // 任意级别标题
  /^(\s*)(> ?)/, // 引用
];

export interface LinePrefixMatch {
  /** 前导缩进（嵌套列表要保留） */
  indent: string;
  /** 前缀本体，含尾部空格，如 "## " / "- [ ] " / "3. " */
  token: string;
}

/** 识别一行开头已有的块级前缀；没有则返回 null。 */
export function matchLinePrefix(text: string): LinePrefixMatch | null {
  for (const p of PREFIX_PATTERNS) {
    const m = p.exec(text);
    if (m) return { indent: m[1], token: m[2] };
  }
  return null;
}

export interface LinePrefixEdit {
  /** 本行要替换的长度（从行首算，= 缩进 + 旧前缀；无旧前缀时为 0） */
  replaceLen: number;
  /** 替换成的文本（缩进 + 新前缀；取消时只剩缩进） */
  insert: string;
}

/**
 * 算出一批行应该怎么改写。
 *
 * 语义（一条规则走到底，不搞特例）：
 * - 所有待改行都已经是**恰好目标前缀** → 整体取消（toggle off）
 * - 否则 → 去掉各自原有的同族前缀，换上目标前缀
 *
 * 这条规则自然得出各种直觉行为：
 * - `## 标题` 点标题 → 变纯文本（同前缀）
 * - `# 标题` 点标题 → 变 `## 标题`（同族不同级，替换）
 * - `- x` 点任务列表 → 变 `- [ ] x`
 * - `- [ ] x` 点无序列表 → 变 `- x`
 *
 * 空行不加前缀：选一段带空行的文字转列表时，否则会多出一堆空列表项。
 * 但整块都是空行时仍按“加”处理 —— 否则按钮点下去没任何反应。
 *
 * @param lines 选区覆盖的每一行原文
 * @param prefix 目标前缀，如 "- " / "## " / "1. "
 * @returns 与输入同长的数组；null = 这一行不动
 */
export function planLinePrefix(lines: string[], prefix: string): (LinePrefixEdit | null)[] {
  const matches = lines.map(matchLinePrefix);
  const editable = lines.map((t) => t.trim() !== "");
  const anyNonEmpty = editable.some(Boolean);
  // 整块全空行时降级为“每行都改”，保证按钮总有反馈
  const shouldEdit = (i: number) => (anyNonEmpty ? editable[i] : true);

  const idxs = lines.map((_, i) => i).filter(shouldEdit);
  const off = idxs.length > 0 && idxs.every((i) => matches[i]?.token === prefix);

  // 有序列表逐行递增：起始序号从目标前缀里解（"1. " → 1）。
  // ❌ 旧实现每行都插 "1. "：GFM 渲染时会自动编号所以预览看不出来，
  // 但源码里一串 "1." 在别的编辑器 / diff 里很难读。
  const ordered = /^\d+\.\s$/.test(prefix);
  const start = Number(/^(\d+)\./.exec(prefix)?.[1] ?? "1");

  let seq = 0;
  return lines.map((_, i) => {
    if (!shouldEdit(i)) return null;
    const m = matches[i];
    // ❌ 无旧前缀时也必须把缩进单独拿出来：直接在行首插前缀会得到
    // `-   子项`（前缀跑到了缩进前面），而正确的是 `  - 子项`。
    const indent = m?.indent ?? (/^\s*/.exec(lines[i])?.[0] ?? "");
    const replaceLen = m ? indent.length + m.token.length : indent.length;
    const nth = seq++;
    const token = off ? "" : ordered ? `${start + nth}. ` : prefix;
    return { replaceLen, insert: indent + token };
  });
}
