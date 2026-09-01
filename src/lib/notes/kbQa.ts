/**
 * kbQa.ts —— 知识库问答（B2 #10 / #10b）的纯逻辑：载荷组装、预算、检索词、引用解析。
 *
 * 🔴 **格式约定与后端 `ai-kb-qa` 的 prompt 分支成对**
 * （`src-tauri/src/ai/actions.rs`）：那边靠「问题：」「参考片段：」「上一轮问答」
 * 三个锚点分清哪是问题、哪是资料、哪是上下文。**改这里得一起改那边。**
 *
 * # 为何问题必须拼进正文而不能走 `opts`
 *
 * `ai_run` 的出网闸只扫 `text`（probe = text + 标签名）。问题走 `opts`
 * 就**绕过了那道门**——用户在问题里打一个手机号或一把 Key 会静默出网，
 * 不报错也不提示。代价只是占长度额度，值得。
 *
 * # 预算为何在这里卡而不是等后端报错
 *
 * `ai::actions::MAX_INPUT_CHARS = 8000`，超了后端报「内容过长（…），请先截取
 * 需要处理的部分」——这句话在问答场景下**根本无法执行**（用户手里没有「内容」可截）。
 */
import type { Note } from "@/lib/api";

/** 一次问答最多送几篇笔记。再多就是把噪声当依据 */
export const QA_TOP_K = 5;

/** 每篇正文最多送多少字。5×1200 = 6000，留余量给问题、历史与后端模板 */
export const QA_PER_NOTE_CHARS = 1200;

/** 问题上限。超长当场截，不到后端才报 */
export const QA_MAX_QUESTION_CHARS = 500;

/**
 * 带进下一轮的「上一轮回答」最多多少字（B2 #10b 多轮追问）。
 *
 * 只带**上一轮**、且回答只带前这么多字：带全部历史的话，第三轮就把
 * 片段额度吃完了——而**片段才是依据**，历史只是用来让模型看懂代词句。
 * 超过两轮的上下文管理属于 C 阶段。
 */
export const QA_HISTORY_ANSWER_CHARS = 400;

/**
 * 整个载荷的上限。比 `MAX_INPUT_CHARS`（8000）留出一千字余量：
 * 后端的 prompt 分支还要在外面再包一段规则文字，那一段也算在 8000 里。
 */
export const QA_MAX_PAYLOAD_CHARS = 7000;

/** 引用 chip 的 href 前缀。面板靠它做事件委托，CSS 靠它上样式 */
export const CITATION_HREF_PREFIX = "#kbqa-ref-";

/** 一条参考来源。 */
export interface QaRef {
  id: string;
  title: string;
  /** 正文被截过。必须在界面上显示，不能静默（规则 #15.3） */
  truncated: boolean;
}

/** 一轮已完成的问答。**只存内存**，关面板就没（不建表、不落库） */
export interface QaTurn {
  question: string;
  answer: string;
  refs: QaRef[];
  /** 命中缓存（本次没计费）。缓存键含载荷，所以笔记一改就自动失效 */
  cached: boolean;
  /** 回答撞上 token 上限被截。必须说，否则用户把「断在半句」当成模型水平差 */
  truncated: boolean;
}

export interface QaPayload {
  /** 直接作为 `ai_run` 的 `text` 传出去 */
  text: string;
  /**
   * **真正送出去的**那几篇——不是检索到的那几篇。
   *
   * 超预算被丢掉的不能列在参考里：界面把它标成「参考」等于告诉用户
   * 「模型看过这篇」，而模型根本没看到。
   */
  refs: QaRef[];
}

/**
 * 拼检索词（B2 #10b）。
 *
 * 🔴 **追问必须重新检索，不能沿用上一轮的 5 篇。**
 * 「部署流程？」→「那回滚呢？」：回滚预案那篇很可能不在上一轮的 5 篇里，
 * 沿用旧片段就会回「知识库中没有相关笔记」——**而库里明明有**。
 *
 * 带上上一问是因为追问往往是代词句（「那回滚呢」），单独抽词几乎抽不出东西。
 */
export function retrievalQuery(question: string, prevQuestion?: string): string {
  const q = question.trim();
  const p = (prevQuestion ?? "").trim();
  return p ? `${p} ${q}` : q;
}

/**
 * 把回答里的 `[n]` 变成 markdown 链接，交给 `MarkdownRenderer` 渲染成 anchor（B2 #10b）。
 *
 * 为何这么做：`MarkdownRenderer` 不碰 `<a>`，所以把 `[1]` 预处理成
 * `[1](#kbqa-ref-1)` 就能白拿一个可点元素，**零改动渲染器**；
 * 点击由面板在容器上做事件委托拦下（并 preventDefault）。
 *
 * 🔴 **越界的编号不转链接**（如 `[9]` 但只送了 5 篇）：原样当文本留着。
 * 渲染成 chip 却点不动，比根本没 chip 更差；而参考列表本来就是「送了哪几篇」的权威源。
 *
 * 也不动代码块内的内容：`[0]` 这种数组下标在代码里很常见，而 0 本来就越界，
 * 再加上反引号围栏里不做替换，误伤面很小。
 */
export function linkifyCitations(text: string, refCount: number): string {
  if (refCount <= 0) return text;
  // 按反引号围栏 / 行内代码切开，只在偶数段（非代码）里替换
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // 代码段原样不动
      return part.replace(/\[(\d{1,2})\]/g, (whole, d: string) => {
        const n = Number(d);
        if (n < 1 || n > refCount) return whole; // 越界 → 当普通文本
        return `[${n}](${CITATION_HREF_PREFIX}${n})`;
      });
    })
    .join("");
}

/** 从 chip 的 href 里取出序号（1-based）；不是引用链接就返 null。 */
export function citationIndexFromHref(href: string | null): number | null {
  if (!href || !href.startsWith(CITATION_HREF_PREFIX)) return null;
  const n = Number(href.slice(CITATION_HREF_PREFIX.length));
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * 把「问题 + 检索到的笔记（+ 上一轮）」拼成一份载荷。
 *
 * 编号既是给模型分隔片段用的，也是引用号：后端 prompt 要求模型在事实句末标 `[n]`，
 * 前端再用 {@link linkifyCitations} 把它变成可点 chip。
 *
 * **预算优先级：历史 › 片段数量。** 历史先占，放不下时少送一篇片段——
 * 因为丢了历史会让模型看不懂「那回滚呢」指的是什么，而少一篇片段只是少一份参考。
 */
export function buildQaPayload(question: string, notes: Note[], prev?: QaTurn): QaPayload {
  const q = question.trim().slice(0, QA_MAX_QUESTION_CHARS);

  let head = "";
  if (prev) {
    const prevA = prev.answer.trim().slice(0, QA_HISTORY_ANSWER_CHARS);
    head +=
      `上一轮问答（仅用于看懂本次追问的指代，**不是**本次的资料）：\n` +
      `问：${prev.question.trim()}\n答：${prevA}\n\n`;
  }
  head += `问题：${q}\n\n参考片段：\n`;

  const refs: QaRef[] = [];
  const parts: string[] = [];
  let used = head.length;

  for (const n of notes.slice(0, QA_TOP_K)) {
    const body = (n.content ?? "").trim();
    const truncated = body.length > QA_PER_NOTE_CHARS;
    const clipped = truncated ? body.slice(0, QA_PER_NOTE_CHARS) : body;
    const block = `[${refs.length + 1}] ${n.title}\n${clipped}\n\n`;
    // 放不下就停（而不是继续试下一篇）：片段是按相关度降序的，
    // 跳过一篇去取更不相关的短篇，只会让送出去的资料更差。
    if (used + block.length > QA_MAX_PAYLOAD_CHARS) break;
    used += block.length;
    parts.push(block);
    refs.push({ id: n.id, title: n.title, truncated });
  }

  return { text: head + parts.join(""), refs };
}
