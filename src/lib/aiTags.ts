/**
 * lib/aiTags.ts —— 把条目的**手工标签**拼成一串，作为 AI 动作的 `userTags` 选项传给后端。
 *
 * 为什么只取 manual：auto 标签是后端 `ContentClassifier` 自己产的，它在 `ai_run` 里
 * 已经从 labels 拿到了（还据此算出 content_type 与语言），再从前端传一遍是白费 token；
 * 而且 auto 标签里没有意图信息——“代码”告诉不了模型这段代码要干什么。
 *
 * **不在前端判开关**：`ai_tags_as_context` 的开关在后端（provider.rs）。
 * 前端无条件传——Tauri IPC 不出本机，不算出网；把“要不要真的发出去”的判断
 * 和出网闸放在同一处，才不会出现“有个调用点忘了判开关”这种遗漏。
 */

/** 与 stores 的 `Tag` 结构兼容的最小形状（本模块不依赖 store 类型） */
interface TagLike {
  name: string;
  source: "manual" | "auto";
}

/** 拼接上限：标签只是意图提示，不应该占据 prompt 的主体 */
const MAX_TAGS = 8;
const MAX_LEN = 120;

/**
 * 返回逗号分隔的手工标签名；没有手工标签则返回 undefined
 * （调用方据此决定要不要带上这个选项，避免传个空串进缓存 key）。
 */
export function manualTagsOpt(tags?: TagLike[] | null): string | undefined {
  if (!tags || tags.length === 0) return undefined;
  const names = tags
    .filter((t) => t.source === "manual")
    .map((t) => t.name.trim())
    .filter(Boolean)
    .slice(0, MAX_TAGS);
  if (names.length === 0) return undefined;
  const joined = names.join("、");
  return joined.length > MAX_LEN ? joined.slice(0, MAX_LEN) : joined;
}
