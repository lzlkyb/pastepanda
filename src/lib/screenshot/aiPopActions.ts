/**
 * 截图 AI 弹层的动作列表：排序与搜索（纯函数，可单测）。
 *
 * 为什么单独一个文件：弹层组件（AiPopover.tsx）本身已经有四态渲染 + 键盘 +
 * 几何，再塞排序逻辑就奔着 300 行上限去了（规则 7）。
 *
 * **打分一律走 aiActionScore**（规则 11.1）：本文件不许出现第二次
 * `scoreAiAction / scoreByContentTypes / tagBoost` 的拼装。ctx 由父组件构造
 * （后端本地分类 `ai_classify_text` + `analyzeContent`），这里只做纯计算；
 * 所以是「同一支函数、不同数据源」，而不是「同一套规则的第二次实现」。
 * 守卫单测见 `aiPopActions.test.ts`。
 */

import type { AiActionMeta } from "@/lib/api/ai";
import type { TransformContext } from "@/lib/transforms/types";
import { aiActionScore } from "@/lib/transforms/aiTransforms";

/** 进推荐段的最低分。与主窗口枢纽的推荐阈值同档（低于它的动作只在「全部」里出现） */
export const REC_MIN_SCORE = 0.5;
/** 推荐段最多几条。主窗口枢纽取前 3，这里不另开一套 */
export const REC_MAX = 3;

export interface AiPopList {
  /** 推荐段（已按分数降序，最多 {@link REC_MAX} 条） */
  rec: AiActionMeta[];
  /** 其余动作（保持分数降序；未展开时列表里只留一条「展开全部」入口） */
  rest: AiActionMeta[];
  /** 搜索态命中数（非搜索态为 null）——组头文案要用真实条数，不能写死 */
  matched: number | null;
}

/** 大小写不敏感的子串匹配：动作清单里既有中文标签也有 `toSlug` 这类英文说明 */
function hit(hay: string | undefined, needle: string): boolean {
  return !!hay && hay.toLowerCase().includes(needle);
}

/**
 * 排序 + 过滤。
 *
 * 搜索态**不分推荐段**：打了字就是要在这 23 条里找人，再把结果切成两层只会把
 * 命中的动作切到第二段去（用户看到的是「搜了却少了几条」）。
 * 搜索也不等 ctx：分类还没回来只影响「推荐不推荐」，不该让搜索框变成摆设。
 *
 * 排序用 `Array.prototype.sort`（V8 稳定）+ 只比分数：同分保持后端返回顺序，
 * 于是内置清单的固有次序就是打散键。
 */
export function buildAiPopList(
  actions: AiActionMeta[],
  ctx: TransformContext | null,
  query: string,
): AiPopList {
  const q = query.trim().toLowerCase();
  if (q) {
    const matched = actions.filter(
      (a) => hit(a.label, q) || hit(a.description, q) || hit(a.id, q),
    );
    return { rec: [], rest: matched, matched: matched.length };
  }
  // ctx 还没到（本地分类在飞 / 失败）：按后端清单原序平铺，不排推荐段
  if (!ctx) return { rec: [], rest: actions, matched: null };
  const scored = actions
    .map((a, i) => ({ a, i, s: aiActionScore(a.id, a.contentTypes ?? [], ctx) }))
    .sort((x, y) => y.s - x.s || x.i - y.i);
  // 只数「过线的」，但最多取 REC_MAX：内容很对路时推荐段也不该变成第二个全清单
  const qualified = scored.filter((x) => x.s >= REC_MIN_SCORE);
  const rec = qualified.slice(0, REC_MAX).map((x) => x.a);
  const rest = scored.slice(rec.length).map((x) => x.a);
  return { rec, rest, matched: null };
}
