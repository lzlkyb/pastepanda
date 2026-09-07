/**
 * `kbConflict` 的行为钉子（W4a）。
 *
 * 副本正文按 `sync::engine::save_conflict_copy` 那个格式串**逐字**拼，
 * 嵌的 markdown 按 `note_md.rs` 的 `to_markdown`。
 * 两边格式一旦漂开，这里会红 —— 这正是想要的：
 * 否则用户看到的是「横幅说是副本、点进去却说解不出」。
 */
import { describe, it, expect } from "vitest";
import {
  CONFLICT_MARK,
  isConflictCopy,
  parseConflictCopy,
  stripFrontmatter,
} from "@/lib/kbConflict";

const ORIGIN = "3f2b9c7a-1111-4222-8333-444455556666";

/** 按 `to_markdown` 拼一份带 frontmatter 的 markdown。 */
function md(content: string, updated: string): string {
  return `---
title: 周会纪要
created: 2026-09-01 09:00:00
updated: ${updated}
---

${content}`;
}

/** 按 `save_conflict_copy` 拼一份副本正文。`prose` 可插入额外说明。 */
function copyBody(embedded: string, opts: { side?: string; ms?: number; prose?: string } = {}) {
  const side = opts.side ?? "对端";
  const ms = opts.ms ?? 1757000000000;
  return `${CONFLICT_MARK} 这是一份**冲突副本**，来自**${side}**那一份（时间戳 ${ms}）。

两台机器在上次同步之后都改过《周会纪要》，后写胜保留了另一份。
这一份没有丢，但**也没有被自动合并**——请自己比对后处理，处理完删掉本篇。
${opts.prose ?? ""}
原笔记 id：\`${ORIGIN}\`

---

${embedded}
`;
}

describe("认出冲突副本", () => {
  it("只看正文标记，不看标题", () => {
    expect(isConflictCopy(copyBody(md("正文", "x")))).toBe(true);
    // 标题带「（冲突副本 …）」但正文没标记 → 不算（用户可以把标记删掉）
    expect(isConflictCopy("普通正文，标题里写了冲突副本也不算")).toBe(false);
  });
});

describe("解副本", () => {
  it("解出原笔记 id、来源与时间戳", () => {
    const p = parseConflictCopy(copyBody(md("正文", "2026-09-07 14:02:00")));
    expect(p).not.toBeNull();
    expect(p!.originId).toBe(ORIGIN);
    expect(p!.losingSide).toBe("对端");
    expect(p!.losingMs).toBe(1757000000000);
  });

  // 🔴 这一条是整个 W4a 的地基：不剥 frontmatter 的话，
  // created/updated 是本机时间字串，同一篇笔记在两台机器上必然不同，
  // 头几行永远是红的，真正的内容差异泡在噪声里。
  it("剥掉 frontmatter —— 只有时间戳不同的两份，内容应逐字相同", () => {
    const content = "# 周会纪要\n\n- 发版时间定在下周三\n- 验收人：张三";
    const mine = content;
    const theirs = parseConflictCopy(copyBody(md(content, "2026-09-07 13:47:00")))!.losingContent;
    expect(theirs).toBe(mine);
  });

  it("正文里的 markdown 分割线不会被吞掉", () => {
    const content = "上半段\n\n---\n\n下半段";
    const p = parseConflictCopy(copyBody(md(content, "x")))!;
    expect(p.losingContent).toBe(content);
  });

  // 分隔符必须从 id 那行**之后**找。从头找的话说明里出现 `---` 就切错了。
  it("说明里出现分割线也不会切错", () => {
    const content = "真正的正文";
    const p = parseConflictCopy(
      copyBody(md(content, "x"), { prose: "\n我自己加的一段\n\n---\n\n还有一段\n" }),
    )!;
    expect(p.originId).toBe(ORIGIN);
    expect(p.losingContent).toBe(content);
  });

  it("用户在中间插了段落也照样解得出", () => {
    const p = parseConflictCopy(
      copyBody(md("正文", "x"), { prose: "\n（我先记一句：这条等周一问过再定）\n" }),
    );
    expect(p!.originId).toBe(ORIGIN);
  });

  it("CRLF 也能解", () => {
    const body = copyBody(md("正文A", "x")).replace(/\n/g, "\r\n");
    const p = parseConflictCopy(body);
    expect(p).not.toBeNull();
    expect(p!.originId).toBe(ORIGIN);
    expect(p!.losingContent).toBe("正文A");
  });
});

// ❗ 解不出时必须返 null，让调用方如实降级（只给「手动拼」）而不是假装能对照。
describe("解不出就如实返 null", () => {
  it("没有「原笔记 id」那一行", () => {
    expect(parseConflictCopy(`${CONFLICT_MARK} 说明被改过了\n\n---\n\n正文`)).toBeNull();
  });

  it("有 id 但后面没有分隔符", () => {
    expect(
      parseConflictCopy(`${CONFLICT_MARK} 说明\n\n原笔记 id：\`${ORIGIN}\`\n\n正文没分隔符`),
    ).toBeNull();
  });
});

describe("剥 frontmatter 的降级口径", () => {
  it("没有 frontmatter 时原样返回", () => {
    expect(stripFrontmatter("直接就是正文")).toBe("直接就是正文");
  });

  // 与后端 `markdown_to_note` 一致：解不出就整文当正文，不报错。
  it("有开头没闭合时整文当正文", () => {
    const broken = "---\ntitle: 没闭合\n正文";
    expect(stripFrontmatter(broken)).toBe(broken);
  });

  it("空 frontmatter 也能剥", () => {
    expect(stripFrontmatter("---\n---\n\n正文")).toBe("正文");
  });
});
