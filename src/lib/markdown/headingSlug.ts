/**
 * Markdown 标题 slug —— 大纲侧栏与预览渲染共用的唯一数据源（规则 #11）。
 *
 * 两处必须产出**完全相同**的 slug，否则大纲点跳和正文锚点会对不上：
 * - `MarkdownOutline.scanHeadings`：从源文扫标题，跳到编辑行 / 预览 DOM
 * - `MarkdownRenderer` 的 heading 渲染器：给 h1–h6 写 id，承接 `#锚点`
 *
 * 两边都按**文档顺序**遍历标题并调用 `assignUniqueSlugs`，重复标题
 * 依次得到 `示例` / `示例-1` / `示例-2`。
 */

export interface SlugHeading {
  /** 1~6 */
  level: number;
  /** 去掉 # 与尾部闭合 ### 后的标题文本 */
  text: string;
  /** 唯一 slug（含去重后缀） */
  slug: string;
}

/**
 * 单个标题文本 → base slug（尚未去重）。
 * - 保留中日韩等字母数字
 * - 拉丁字母转小写
 * - 空白/下划线 → `-`，去掉其余标点
 * - 连续 `-` 收成一个，掐头去尾
 * - 空结果回退 `section`（避免 id 为空）
 */
export function slugifyHeading(text: string): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "section";
}

/**
 * 在容器内按 id 查节点。
 * ❌ 不用 `CSS.escape`：部分测试/嵌入环境没有该 API；标题 slug 含中文，
 * 属性选择器 + 引号转义足够且可移植。
 */
export function queryByHeadingId(root: ParentNode, id: string): HTMLElement | null {
  const escaped = id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return root.querySelector<HTMLElement>(`[id="${escaped}"]`);
}

/**
 * 创建一次性 slug 分配器。大纲扫描与 marked heading 渲染器共用同一实现，
 * 保证同一文档顺序下两边产出的 id 一字不差。
 */
export function createSlugAllocator(): (text: string) => string {
  const used = new Set<string>();
  return (text: string) => {
    const base = slugifyHeading(text);
    let slug = base;
    let n = 0;
    while (used.has(slug)) {
      n += 1;
      slug = `${base}-${n}`;
    }
    used.add(slug);
    return slug;
  };
}

/**
 * 按文档顺序给标题列表分配唯一 slug。
 * 重复 base 时：第一次原样，其后追加 `-1`、`-2`…
 * 若去重后缀仍撞上已有 slug（极少见，如已有字面 `foo-1`），继续加到空闲为止。
 */
export function assignUniqueSlugs(headings: Array<{ level: number; text: string }>): SlugHeading[] {
  const next = createSlugAllocator();
  return headings.map((h) => ({
    level: h.level,
    text: h.text,
    slug: next(h.text),
  }));
}
