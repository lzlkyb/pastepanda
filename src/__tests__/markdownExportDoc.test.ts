/**
 * 导出 HTML 的纯函数守卫。
 *
 * 这里钉的是「导出文件能不能独立活下来」的那些不变量—— theme 变量必须快照、
 * `</script>` 必须转义、字段 name 必须稳定。任何一条坏了，产物在别人电脑上
 * 都是坏的，而且本地看不出来（自己机器上变量还在、脚本也没被截断）。
 *
 * 每条都做过防假绿：见文件末尾「变异核对」注释。
 */
import { describe, it, expect } from "vitest";
import {
  ensureFieldNames,
  makeDocId,
  serializeValues,
} from "@/lib/markdown/formFields";
import { parseFormSugar } from "@/lib/markdown/formSugar";
import {
  buildHtmlDocument,
  cssVarsBlock,
  escapeInlineScript,
} from "@/lib/markdown/exportDoc";
import { EXPORT_RUNTIME } from "@/lib/markdown/exportRuntime";

const THEME = {
  name: "ocean",
  appearance: "modern",
  vars: { "--text-primary": "#e6e6e6", "--app-bg": "#1a1a1a" },
};

function build(over: Partial<Parameters<typeof buildHtmlDocument>[0]> = {}) {
  return buildHtmlDocument({
    title: "季度复盘",
    bodyHtml: "<p>正文</p>",
    css: ".md p{color:red}",
    rootClass: "_md_abc_1",
    theme: THEME,
    docId: "ppdoc1",
    fields: [],
    ...over,
  });
}

describe("ensureFieldNames —— 字段 name 必须稳定且按文档顺序", () => {
  it("缺 name 的控件按出现顺序补 __f0/__f1，已有 name 的不动", () => {
    const r = ensureFieldNames(
      `<input type="text"><textarea></textarea><input name="已有" type="text">`,
    );
    expect(r.fields.map((f) => f.name)).toEqual(["__f0", "__f1", "已有"]);
    expect(r.html).toContain(`name="__f0"`);
    expect(r.html).toContain(`name="已有"`);
  });

  it("任务列表勾选框（data-task-i）不算表单字段，且不补 name", () => {
    // 判据：导出的文件里没有写回通道，能勾但存不下来 = 假的可编辑
    const r = ensureFieldNames(`<input type="checkbox" data-task-i="0">`);
    expect(r.fields).toEqual([]);
    expect(r.html).not.toContain("name=");
  });

  it("data-pp-skip 的控件跳过；submit/button/reset/file 不算字段", () => {
    const r = ensureFieldNames(
      `<input data-pp-skip type="text"><input type="submit"><input type="button">` +
        `<input type="reset"><input type="file"><input type="checkbox">`,
    );
    // 序号只在**真实字段**之间递增：跳过的控件不占号，否则删掉一个非字段控件
    // 就会让后面所有字段改名，业务人员已填的值全部错位
    expect(r.fields.map((f) => f.name)).toEqual(["__f0"]);
    expect(r.html).toContain(`<input data-pp-skip type="text">`);
  });

  it("label 优先取 placeholder，没有则退回 name", () => {
    const r = ensureFieldNames(
      `<input type="text" placeholder="客户名称"><input type="number">`,
    );
    expect(r.fields.map((f) => f.label)).toEqual(["客户名称", "__f1"]);
  });

  it("kind 分类正确（textarea/select/checkbox/radio/number）", () => {
    const r = ensureFieldNames(
      `<textarea name="a"></textarea><select name="b"></select>` +
        `<input name="c" type="checkbox"><input name="d" type="radio"><input name="e" type="number">`,
    );
    expect(r.fields.map((f) => f.kind)).toEqual([
      "textarea",
      "select",
      "checkbox",
      "radio",
      "other",
    ]);
  });
});

describe("serializeValues —— 必须能安全塞进 <script type=application/json>", () => {
  it("< > & 全部转成 \\u 形式（正文里贴过 </script> 会截断标签）", () => {
    const s = serializeValues({ a: "</script><img onerror=x>" });
    expect(s).not.toContain("<");
    expect(s).not.toContain(">");
    expect(s).not.toContain("&");
    // 转义不能改变 parse 出来的值
    expect(JSON.parse(s)).toEqual({ a: "</script><img onerror=x>" });
  });

  it("U+2028/2029 转义（旧引擎里是非法换行）", () => {
    const s = serializeValues({ a: "x\u2028y\u2029z" });
    expect(s).not.toContain("\u2028");
    expect(JSON.parse(s).a).toBe("x\u2028y\u2029z");
  });
});

describe("makeDocId", () => {
  it("同一时刻连续两次也不相等（每份导出都是独立表单，不能共用 key）", () => {
    const a = makeDocId(1000, 0.11);
    const b = makeDocId(1000, 0.22);
    expect(a).not.toBe(b);
    expect(a.startsWith("pp")).toBe(true);
  });

  it("默认调用（不传参）也要互不相同", () => {
    expect(makeDocId()).not.toBe(makeDocId());
  });
});

describe("parseFormSugar —— {{}} 语法糖", () => {
  it("单行文本 / 多行 / 日期 / 数字 / 勾选", () => {
    expect(parseFormSugar("姓名")).toEqual({ head: "姓名", mode: "", options: [] });
    expect(parseFormSugar("备注/多行")?.mode).toBe("多行");
    expect(parseFormSugar("日期/日期")?.mode).toBe("日期");
    expect(parseFormSugar("数量/数字")?.mode).toBe("数字");
    expect(parseFormSugar("同意/勾选")?.mode).toBe("勾选");
  });

  it("下拉：第一个 | 之后全是选项", () => {
    expect(parseFormSugar("状态|待处理|已完成")).toEqual({
      head: "状态",
      mode: "",
      options: ["待处理", "已完成"],
    });
  });

  it("空内容与超长内容都不认（超长大概率是模板语法不是字段）", () => {
    expect(parseFormSugar("   ")).toBeNull();
    expect(parseFormSugar("x".repeat(41))).toBeNull();
  });
});

describe("exportDoc —— 产物结构", () => {
  it("主题变量必须以具体值内联（不快照到了别人电脑上就是透明/黑字）", () => {
    const html = build();
    expect(html).toContain("--text-primary:#e6e6e6");
    expect(html).not.toMatch(/--text-primary:\s*var\(/);
  });

  it("根节点带哈希类名，CSS 内联进来", () => {
    const html = build();
    expect(html).toContain(`class="_md_abc_1"`);
    expect(html).toContain(".md p{color:red}");
  });

  it("没有字段 → 不嵌任何 script、也不渲染工具条（纯阅读的导出保持零 JS）", () => {
    const html = build({ runtimeJs: EXPORT_RUNTIME });
    expect(html).not.toContain("<script");
    // 注意：外壳 CSS 里始终有 `.pp-bar` 规则，所以只能断言**元素**没渲染
    expect(html).not.toContain(`<div class="pp-bar">`);
    expect(html).not.toContain("下载已填版本");
  });

  it("有字段 → 出现工具条、docId 烧进 JSON、运行时内联", () => {
    const html = build({
      fields: [{ name: "n1", kind: "text", label: "姓名" }],
      values: { n1: "张三" },
      runtimeJs: EXPORT_RUNTIME,
    });
    expect(html).toContain("pp-bar");
    expect(html).toContain('id="pp-data"');
    expect(html).toContain("ppdoc1");
    expect(html).toContain("下载已填版本");
    // 值必须带进文件，否则「导出已填内容」是空的
    expect(html).toContain("张三");
  });

  it("运行时里的 </script 必须转义（否则脚本被提前截断，表单全废）", () => {
    const html = build({
      fields: [{ name: "n1", kind: "text", label: "a" }],
      runtimeJs: `var s = "</script><b>x</b>";`,
    });
    expect(html).not.toMatch(/var s = "<\/script>/);
    expect(html).toContain("<\\/script>");
  });

  it("标题与来源名做 HTML 转义（文件名带 < > 会破坏标签结构）", () => {
    const html = build({ title: "a<b>&c", sourceName: "x\"y" });
    expect(html).toContain("a&lt;b&gt;&amp;c");
    expect(html).not.toContain("<title>a<b>");
  });

  it("打印样式存在（业务人员大概率要打印）", () => {
    expect(build()).toContain("@media print");
  });
});

describe("escapeInlineScript / cssVarsBlock", () => {
  it("</script 各种大小写都不再有闭合能力", () => {
    // 断言「结果里匹配不到闭合标签」而不是「等于某个字符串」：
    // 替换串统一小写就够了（HTML 标签名不区分大小写），写死大小写会把实现绑死
    expect(escapeInlineScript("</SCRIPT>")).not.toMatch(/<\/script/i);
    expect(escapeInlineScript("a</script")).not.toMatch(/<\/script/i);
    expect(escapeInlineScript("a</Script")).not.toMatch(/<\/script/i);
    expect(escapeInlineScript("normal code")).toBe("normal code");
  });

  it("含 ; 或 } 的变量值丢弃（会破坏 CSS 声明，宁可少一个变量）", () => {
    const out = cssVarsBlock({
      "--ok": "#fff",
      "--bad1": "red;color:blue",
      "--bad2": "x}",
      "notvar": "#000",
    });
    expect(out).toContain("--ok:#fff;");
    expect(out).not.toContain("--bad1");
    expect(out).not.toContain("--bad2");
    expect(out).not.toContain("notvar");
  });

  it("空输入返回空串（不要留一个空 :root{}）", () => {
    expect(cssVarsBlock({})).toBe("");
  });
});
