/**
 * 转笔记模板（B2 #8）。
 *
 * 钉的第一件事是**空模板 = 原样**——这是向后兼容的保证：
 * 加了这个功能不能改变没配过模板的用户的转笔记结果。
 * 其余钉的是那几个容错口径（未知占位符、脏 JSON、空来源）。
 */
import { describe, it, expect } from "vitest";
import type { HistoryItem } from "@/stores/appStore";
import {
  applyNoteTemplate,
  applyTemplateToDraft,
  buildTemplateVars,
  parseTemplateOverrides,
  pickTemplate,
} from "@/lib/notes/template";

function mkItem(over: Partial<HistoryItem> = {}): HistoryItem {
  return {
    id: "h1",
    text: "正文第一行\n第二行",
    time: "2026-09-01 14:32:07",
    type: "text",
    content: "",
    pinned: false,
    source: "Chrome",
    workspace: "default",
    ...over,
  };
}

const DRAFT = { title: "正文第一行", content: "正文第一行\n第二行" };

describe("空模板 = 不套（向后兼容）", () => {
  it("默认模板为空时原样返回", () => {
    expect(applyTemplateToDraft(DRAFT, mkItem(), "", {})).toEqual(DRAFT);
  });

  it("模板只有空白也算不套", () => {
    expect(applyTemplateToDraft(DRAFT, mkItem(), "   \n\n ", {})).toEqual(DRAFT);
  });
});

describe("变量替换", () => {
  it("常用变量都能替", () => {
    const vars = buildTemplateVars(mkItem({ tags: [{ id: "t1", name: "前端", color: "#888", source: "manual", created_at: "" }] }), DRAFT);
    const out = applyNoteTemplate("{{title}} | {{source}} | {{date}} | {{tags}}", vars);
    expect(out).toBe("正文第一行 | Chrome | 2026-09-01 | 前端");
  });

  it("占位符容忍内部空白与大小写", () => {
    const vars = buildTemplateVars(mkItem(), DRAFT);
    expect(applyNoteTemplate("{{ source }}/{{SOURCE}}/{{Source}}", vars)).toBe("Chrome/Chrome/Chrome");
  });

  it("**未知占位符原样保留**——正文里的 {{foo}} 不能被吃掉", () => {
    const vars = buildTemplateVars(mkItem(), DRAFT);
    expect(applyNoteTemplate("{{foo}} {{sorce}} {{source}}", vars)).toBe("{{foo}} {{sorce}} Chrome");
  });

  it("content_type 取的是中文标签，不是 `code` 这种内部值", () => {
    const vars = buildTemplateVars(mkItem({ content_type: "code" }), DRAFT);
    // 不硬编码具体文案（改了不应该让测试挂），只钉「不是内部值且非空」
    expect(vars.contentType).not.toBe("code");
    expect(vars.contentType.length).toBeGreaterThan(0);
  });
});

describe("origin 出处行", () => {
  it("有来源时写「来自 X · 时间」，只到分钟", () => {
    expect(buildTemplateVars(mkItem(), DRAFT).origin).toBe("来自 Chrome · 2026-09-01 14:32");
  });

  it("没来源时只写时间，**不留「来自 」尾巴**", () => {
    const o = buildTemplateVars(mkItem({ source: "" }), DRAFT).origin;
    expect(o).toBe("2026-09-01 14:32");
    expect(o).not.toContain("来自");
  });

  it("来源只有空白也算没来源", () => {
    expect(buildTemplateVars(mkItem({ source: "   " }), DRAFT).origin).toBe("2026-09-01 14:32");
  });
});

describe("pickTemplate：按 content_type 自动匹配", () => {
  it("有覆盖就用覆盖", () => {
    expect(pickTemplate("D", { code: "C" }, "code")).toBe("C");
  });

  it("没覆盖就用默认", () => {
    expect(pickTemplate("D", { code: "C" }, "url")).toBe("D");
  });

  it("content_type 缺失时用默认", () => {
    expect(pickTemplate("D", { code: "C" }, undefined)).toBe("D");
  });

  it("覆盖为空串视为「没配」而不是「配了个空模板」", () => {
    // 设置页里把输入框清空，意图是「不特殊对待这个类型」，不是「把正文清空」
    expect(pickTemplate("D", { code: "" }, "code")).toBe("D");
    expect(pickTemplate("D", { code: "  " }, "code")).toBe("D");
  });
});

describe("parseTemplateOverrides 容错", () => {
  it("空 / undefined → 空表", () => {
    expect(parseTemplateOverrides(undefined)).toEqual({});
    expect(parseTemplateOverrides("")).toEqual({});
    expect(parseTemplateOverrides("   ")).toEqual({});
  });

  it("脏 JSON 不报错、返空表（不能因为模板配置坏了就转不了笔记）", () => {
    expect(parseTemplateOverrides("{不是 json")).toEqual({});
    expect(parseTemplateOverrides("[1,2]")).toEqual({});
    expect(parseTemplateOverrides("null")).toEqual({});
  });

  it("非字符串的值被丢掉，其余保留", () => {
    expect(parseTemplateOverrides('{"code":"C","csv":123,"url":null}')).toEqual({ code: "C" });
  });
});

describe("只套正文，不套标题", () => {
  it("标题不受模板影响", () => {
    const r = applyTemplateToDraft(DRAFT, mkItem(), "> {{origin}}\n\n{{content}}", {});
    expect(r.title).toBe(DRAFT.title);
    expect(r.content).toBe("> 来自 Chrome · 2026-09-01 14:32\n\n正文第一行\n第二行");
  });

  it("按类型走覆盖模板", () => {
    const r = applyTemplateToDraft(DRAFT, mkItem({ content_type: "code" }), "D:{{content}}", {
      code: "代码：{{content}}",
    });
    expect(r.content).toBe("代码：正文第一行\n第二行");
  });
});
