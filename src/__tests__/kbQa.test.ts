/**
 * 问答载荷组装（B2 #10）的用例。
 *
 * 钉的两件事都是**错了不报错**的：
 * - `refs` 必须等于真正送出去的那几篇。把没送的也列进参考 = 告诉用户
 *   「模型看过这篇」，而模型没看到；
 * - 总长必须卡在 8000 以内。超了后端报「内容过长，请先截取需要处理的部分」——
 *   而在问答场景下用户根本没有「内容」可截。
 */
import { describe, it, expect } from "vitest";
import {
  buildQaPayload,
  citationIndexFromHref,
  linkifyCitations,
  retrievalQuery,
  CITATION_HREF_PREFIX,
  QA_HISTORY_ANSWER_CHARS,
  QA_MAX_PAYLOAD_CHARS,
  QA_MAX_QUESTION_CHARS,
  QA_PER_NOTE_CHARS,
  QA_TOP_K,
  type QaTurn,
} from "@/lib/notes/kbQa";
import type { Note } from "@/lib/api";

function mkNote(id: string, title: string, content: string): Note {
  return {
    id,
    history_id: null,
    title,
    content,
    created_at: "2026-09-01 10:00:00",
    updated_at: "2026-09-01 10:00:00",
    source_agent: null,
    tags: [],
  } as unknown as Note;
}

describe("buildQaPayload", () => {
  it("把问题拼进正文（而不是丢在 opts 里绕过出网闸）", () => {
    const { text } = buildQaPayload("部署流程？", [mkNote("1", "手册", "预发布")]);
    expect(text).toContain("部署流程？");
    expect(text).toContain("参考片段：");
    expect(text).toContain("[1] 手册");
  });

  it("最多只送 QA_TOP_K 篇", () => {
    const notes = Array.from({ length: QA_TOP_K + 3 }, (_, i) =>
      mkNote(String(i), `笔记${i}`, "正文"),
    );
    const { refs } = buildQaPayload("问题", notes);
    expect(refs).toHaveLength(QA_TOP_K);
  });

  it("过长正文被截，且 truncated 标出来（不静默）", () => {
    const long = "字".repeat(QA_PER_NOTE_CHARS + 500);
    const { text, refs } = buildQaPayload("问题", [mkNote("1", "长篇", long)]);
    expect(refs[0].truncated).toBe(true);
    // 送出去的正文不能超过每篇上限
    expect(text).not.toContain("字".repeat(QA_PER_NOTE_CHARS + 1));
  });

  it("没超长的不该被标成 truncated", () => {
    const { refs } = buildQaPayload("问题", [mkNote("1", "短篇", "一句话")]);
    expect(refs[0].truncated).toBe(false);
  });

  it("超预算时被丢掉的篇目不能出现在 refs 里", () => {
    // 每篇都顶满 1200 字，5 篇 = 6000+，加上头部会顶到预算
    const notes = Array.from({ length: QA_TOP_K }, (_, i) =>
      mkNote(String(i), `笔记${i}`, "字".repeat(QA_PER_NOTE_CHARS)),
    );
    const { text, refs } = buildQaPayload("字".repeat(QA_MAX_QUESTION_CHARS), notes);
    expect(text.length).toBeLessThanOrEqual(QA_MAX_PAYLOAD_CHARS);
    // refs 里的每一篇都得真的在载荷里
    for (const r of refs) {
      expect(text).toContain(r.title);
    }
    // 而没进载荷的那几篇也不能在 refs 里
    expect(refs.length).toBeLessThanOrEqual(notes.length);
  });

  it("过长的问题当场截，不拖到后端报错", () => {
    const q = "问".repeat(QA_MAX_QUESTION_CHARS + 200);
    const { text } = buildQaPayload(q, [mkNote("1", "t", "c")]);
    expect(text).toContain("问".repeat(QA_MAX_QUESTION_CHARS));
    expect(text).not.toContain("问".repeat(QA_MAX_QUESTION_CHARS + 1));
  });
});

function mkTurn(question: string, answer: string): QaTurn {
  return { question, answer, refs: [], cached: false, truncated: false };
}

describe("多轮追问的载荷（B2 #10b）", () => {
  it("带上上一轮，且明说它不是本次的资料", () => {
    const prev = mkTurn("部署流程？", "先发预发布。");
    const { text } = buildQaPayload("那回滚呢？", [mkNote("1", "回滚预案", "步骤…")], prev);
    expect(text).toContain("上一轮问答");
    expect(text).toContain("部署流程？");
    expect(text).toContain("那回滚呢？");
    // 关键：必须明说历史不是依据，否则模型会拿上一轮的结论当事实再用一次
    expect(text).toContain("不是**本次的资料");
  });

  it("上一轮的回答只带前 N 字（不能把片段额度吃完）", () => {
    const long = "答".repeat(QA_HISTORY_ANSWER_CHARS + 300);
    const { text } = buildQaPayload("追问", [mkNote("1", "t", "c")], mkTurn("旧问", long));
    expect(text).toContain("答".repeat(QA_HISTORY_ANSWER_CHARS));
    expect(text).not.toContain("答".repeat(QA_HISTORY_ANSWER_CHARS + 1));
  });

  it("预算优先级：历史先占，放不下时少送片段", () => {
    const notes = Array.from({ length: QA_TOP_K }, (_, i) =>
      mkNote(String(i), `笔记${i}`, "字".repeat(QA_PER_NOTE_CHARS)),
    );
    const prev = mkTurn("旧问".repeat(50), "答".repeat(QA_HISTORY_ANSWER_CHARS));
    const withPrev = buildQaPayload("字".repeat(QA_MAX_QUESTION_CHARS), notes, prev);
    const noPrev = buildQaPayload("字".repeat(QA_MAX_QUESTION_CHARS), notes);
    expect(withPrev.text.length).toBeLessThanOrEqual(QA_MAX_PAYLOAD_CHARS);
    // 带了历史之后片段只能更少或相等——不能反而更多，也不能把历史砍掉
    expect(withPrev.refs.length).toBeLessThanOrEqual(noPrev.refs.length);
    expect(withPrev.text).toContain("上一轮问答");
  });
});

describe("检索词", () => {
  it("追问时拼上上一问——代词句单独抽不出词", () => {
    expect(retrievalQuery("那回滚呢？", "部署流程？")).toBe("部署流程？ 那回滚呢？");
  });
  it("首轮就是问题本身", () => {
    expect(retrievalQuery("部署流程？")).toBe("部署流程？");
  });
});

describe("引用 chip（B2 #10b）", () => {
  it("有效编号转成 markdown 链接", () => {
    const out = linkifyCitations("先发预发布 [1]，再切正式 [2]。", 2);
    expect(out).toContain(`[1](${CITATION_HREF_PREFIX}1)`);
    expect(out).toContain(`[2](${CITATION_HREF_PREFIX}2)`);
  });

  it("越界编号**原样当文本**，不转链接", () => {
    // 渲染成 chip 却点不动，比根本没 chip 更差
    const out = linkifyCitations("据 [9] 所述…", 5);
    expect(out).toBe("据 [9] 所述…");
    expect(linkifyCitations("数组下标 [0]", 5)).toBe("数组下标 [0]");
  });

  it("一篇参考也没时不动任何东西", () => {
    expect(linkifyCitations("看 [1]", 0)).toBe("看 [1]");
  });

  it("不动代码块里的内容", () => {
    const md = "正文 [1]\n\n```js\nconst a = arr[1];\n```\n行内 `x[1]` 也不动";
    const out = linkifyCitations(md, 2);
    expect(out).toContain(`正文 [1](${CITATION_HREF_PREFIX}1)`);
    expect(out).toContain("const a = arr[1];");
    expect(out).toContain("`x[1]`");
  });

  it("href 反解：只认引用链接", () => {
    expect(citationIndexFromHref(`${CITATION_HREF_PREFIX}3`)).toBe(3);
    expect(citationIndexFromHref("https://example.com")).toBeNull();
    expect(citationIndexFromHref("#other")).toBeNull();
    expect(citationIndexFromHref(null)).toBeNull();
  });
});
