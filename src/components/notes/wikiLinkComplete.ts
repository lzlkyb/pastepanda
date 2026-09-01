/**
 * `[[` 输入时的笔记标题候选（B1 #12）。
 *
 * 🔴 **仅提示，不解析**（D7）：它只帮你把标题敲完整，插进去的仍然只是普通字符。
 * 反链、悬停预览、点击跳转都归 C 阶段的 `note_links`。
 *
 * 标题只在**第一次真的输入 `[[` 时**拉一次，之后这个编辑器实例内不再拉：
 * 每个键程发一次 IPC 是不可接受的，而写笔记期间新增的标题少一两个无所谓。
 */
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";

/** 候选最多给多少条。再多也没人翻，而且会把 480px 的窗口盖满。 */
const MAX_OPTIONS = 20;

/**
 * 光标前那段是不是「刚输入 `[[` 或正在写第一个 `[[` 后的内容」。
 *
 * 返回匹配到的前缀起始位置（`[[` 之后）与已输入的关键词；不在这个形态里就返回 null。
 *
 * 两条边界值得写清楚：
 * - `]]` 已经闭合了就不再提示（否则光标在完整链接后面也会弹）；
 * - 关键词里不能含换行，因为一个跨行的 `[[` 基本是用户写到一半换行了。
 */
export function matchWikiPrefix(textBeforeCursor: string): { from: number; keyword: string } | null {
  const open = textBeforeCursor.lastIndexOf("[[");
  if (open < 0) return null;

  const keyword = textBeforeCursor.slice(open + 2);
  if (keyword.includes("\n") || keyword.includes("[")) return null;
  // 已经闭合的链接不再提示
  if (keyword.includes("]")) return null;

  return { from: open + 2, keyword };
}

/**
 * 筛选候选。大小写不敏感的包含匹配，**前缀命中的排前面**。
 *
 * 不做模糊匹配：笔记标题多是中文，模糊匹配在中文上基本等于随机排序。
 */
export function filterTitles(titles: string[], keyword: string): string[] {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return titles.slice(0, MAX_OPTIONS);

  const starts: string[] = [];
  const contains: string[] = [];
  for (const t of titles) {
    const low = t.toLowerCase();
    if (low.startsWith(kw)) starts.push(t);
    else if (low.includes(kw)) contains.push(t);
  }
  return [...starts, ...contains].slice(0, MAX_OPTIONS);
}

/**
 * 组装成 CodeMirror 扩展。
 *
 * `loadTitles` 由调用方提供（通常是一次 `noteList`）。它只会被调一次，
 * 失败也不重试——拿不到标题就不提示，**不能因此影响敲字**。
 */
export function wikiLinkCompletion(loadTitles: () => Promise<string[]>): Extension {
  let cache: string[] | null = null;
  let loading: Promise<string[]> | null = null;

  const titles = async (): Promise<string[]> => {
    if (cache) return cache;
    if (!loading) {
      loading = loadTitles()
        .then((list) => {
          cache = list;
          return list;
        })
        .catch(() => {
          cache = []; // 失败就永久不提示，不反复重试拖慢输入
          return [];
        });
    }
    return loading;
  };

  const source = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = ctx.state.sliceDoc(line.from, ctx.pos);
    const hit = matchWikiPrefix(before);
    if (!hit) return null;
    // 只敲了 `[[` 还没字时，不主动弹（explicit = 用户手动触发）
    if (!hit.keyword && !ctx.explicit) return null;

    const list = filterTitles(await titles(), hit.keyword);
    if (list.length === 0) return null;

    return {
      from: line.from + hit.from,
      options: list.map((t) => ({
        label: t,
        type: "text",
        // 补上右半边括号，省得用户再敲两下
        apply: `${t}]]`,
      })),
    };
  };

  return autocompletion({
    override: [source],
    // 不接管其它补全：笔记里只有这一种候选，开普通词补全只会碍事
    activateOnTyping: true,
    closeOnBlur: true,
  });
}
