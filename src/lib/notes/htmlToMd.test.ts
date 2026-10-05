/**
 * htmlToMarkdown 的行为钉子。三条实测沉淀（见模块头注释）各有一条专项：
 * 内链、隐藏节点、data-src 懒加载。
 */
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./htmlToMd";

describe("htmlToMarkdown", () => {
  it("空输入与纯噪声返回 null（调用方回退纯文本）", () => {
    expect(htmlToMarkdown("")).toBeNull();
    expect(htmlToMarkdown("   ")).toBeNull();
    expect(htmlToMarkdown("<div><script>var a=1;</script></div>")).toBeNull();
  });

  it("标题分级 h1-h6", () => {
    const md = htmlToMarkdown("<h1>大标题</h1><h2>小标题</h2><h3>三级</h3>");
    expect(md).toContain("# 大标题");
    expect(md).toContain("## 小标题");
    expect(md).toContain("### 三级");
  });

  it("段落与加粗斜体行内样式", () => {
    const md = htmlToMarkdown(
      '<p>正常段落。<strong>加粗内容</strong>与<em>斜体</em>混排。</p>',
    );
    expect(md).toContain("正常段落。**加粗内容**与*斜体*混排。");
  });

  it("a 标签转 Markdown 链接（微信内链场景）", () => {
    const md = htmlToMarkdown(
      '<p>上周接过的商家<a href="https://mp.weixin.qq.com/s?biz=1&amp;mid=2">三年了</a>，又下发新任务。</p>',
    );
    expect(md).toContain("[三年了](https://mp.weixin.qq.com/s?biz=1&mid=2)");
  });

  it("javascript:/锚点 href 只留文字不产链接", () => {
    const md = htmlToMarkdown('<a href="javascript:void(0)">点我</a>');
    expect(md).toBe("点我");
    expect(md).not.toContain("](");
  });

  it("含空格或括号的 URL 用尖括号包裹", () => {
    const md = htmlToMarkdown('<a href="https://e.com/a (1).html">文</a>');
    expect(md).toContain("](<https://e.com/a (1).html>)");
  });

  it("隐藏节点（display:none）整棵丢弃（反爬毒文本防护）", () => {
    const md = htmlToMarkdown(
      '<p>正文第一段。</p><span style="display:none">隐藏的干扰文字</span><p>正文第二段。</p>',
    );
    expect(md).not.toContain("干扰文字");
    expect(md).toContain("正文第一段。");
    expect(md).toContain("正文第二段。");
  });

  it("visibility:hidden / opacity:0 / font-size:0 同样丢弃", () => {
    for (const style of [
      "visibility:hidden",
      "opacity:0",
      "font-size:0px",
      "opacity:0.0",
    ]) {
      const md = htmlToMarkdown(
        `<p>可见内容${style.length}</p><span style="${style}">隐藏内容</span>`,
      );
      expect(md).not.toContain("隐藏内容");
      expect(md).toContain("可见内容");
    }
  });

  it("opacity:0.5 这类半透明不算隐藏", () => {
    const md = htmlToMarkdown('<p><span style="opacity:0.5">半透明文字</span></p>');
    expect(md).toContain("半透明文字");
  });

  it("图片地址 data-src 优先于 src（懒加载）", () => {
    const md = htmlToMarkdown(
      '<img src="https://placeholder/1px.gif" data-src="https://mmbiz.qpic.cn/real.jpg">',
    );
    expect(md).toContain("](https://mmbiz.qpic.cn/real.jpg)");
    expect(md).not.toContain("1px.gif");
  });

  it("已本地化的 file:/// 图片地址剥成裸盘符路径（笔记预览渲染管线只认它）", () => {
    const md = htmlToMarkdown('<img src="file:///C:/images/abc.png" alt="截图">');
    expect(md).toBe("![截图](C:/images/abc.png)");
  });

  it("file:/// 地址里的 %20 还原成空格（交给尖括号包裹处理）", () => {
    const md = htmlToMarkdown('<img src="file:///C:/my%20pics/a.png">');
    expect(md).toBe("![](<C:/my pics/a.png>)");
  });

  it("Unix 风格 file:/// 路径保留根斜杠", () => {
    const md = htmlToMarkdown('<img src="file:///home/user/a.png">');
    expect(md).toBe("![](/home/user/a.png)");
  });

  it("超长 data: URI 图片不进正文", () => {
    const huge = "data:image/png;base64," + "A".repeat(80 * 1024);
    const md = htmlToMarkdown(`<img src="${huge}"><p>正文</p>`);
    expect(md).not.toContain("base64");
    expect(md).toContain("正文");
  });

  it("无序列表与有序列表", () => {
    const ul = htmlToMarkdown("<ul><li>第一项</li><li>第二项</li></ul>");
    expect(ul).toBe("- 第一项\n- 第二项");
    const ol = htmlToMarkdown("<ol><li>甲</li><li>乙</li></ol>");
    expect(ol).toBe("1. 甲\n2. 乙");
  });

  it("嵌套列表有缩进", () => {
    const md = htmlToMarkdown(
      "<ul><li>外层<ul><li>内层</li></ul></li></ul>",
    );
    expect(md).toContain("- 外层");
    expect(md).toContain("  - 内层");
  });

  it("引用块逐行加 >", () => {
    const md = htmlToMarkdown("<blockquote><p>第一行</p><p>第二行</p></blockquote>");
    expect(md).toBe("> 第一行\n>\n> 第二行");
  });

  it("代码块保留语言标记与换行", () => {
    const md = htmlToMarkdown(
      '<pre class="language-rust"><code>fn main() {\n    println!("hi");\n}</code></pre>',
    );
    expect(md).toContain("```rust\nfn main() {\n    println!(\"hi\");\n}\n```");
  });

  it("表格转 GFM 且转义竖线", () => {
    const md = htmlToMarkdown(
      "<table><tr><th>列A</th><th>列B</th></tr><tr><td>1</td><td>a|b</td></tr></table>",
    );
    if (!md) throw new Error("应能转出内容");
    expect(md.split("\n")[0]).toBe("| 列A | 列B |");
    expect(md.split("\n")[1]).toBe("| --- | --- |");
    expect(md).toContain("| 1 | a\\|b |");
  });

  it("br 与 div 容器降级为换行分段", () => {
    const md = htmlToMarkdown("<div>第一段<div>第二段</div></div>");
    expect(md).toContain("第一段");
    expect(md).toContain("第二段");
  });

  it("空强调（空 strong）不产出 ** 垃圾", () => {
    const md = htmlToMarkdown("<p>前后文<strong></strong><b> </b>。</p>");
    if (!md) throw new Error("应能转出内容");
    expect(md).not.toContain("**");
    expect(md).toContain("前后文。");
  });

  it("完整文档（html/body 包裹）与片段都能转", () => {
    const doc = htmlToMarkdown(
      "<html><head><title>t</title></head><body><h1>标题</h1><p>正文</p></body></html>",
    );
    expect(doc).toContain("# 标题");
    expect(doc).toContain("正文");
  });

  it("WeChat 文章片段端到端：标题、内链、段落、配图一次成型", () => {
    const md = htmlToMarkdown(
      '<section><h2>一下子来了5个互选广告！</h2>' +
        '<p>仔细一看，其中有4个，就是上周我接过的商家' +
        '<a href="https://mp.weixin.qq.com/s?__biz=x&amp;mid=1" textvalue="旧文">旧文</a>' +
        '，又重新下发了新的广告任务。</p>' +
        '<img src="qplaceholder" data-src="https://mmbiz.qpic.cn/cover.jpg?wx_fmt=jpeg">' +
        "</section>",
    );
    expect(md).toContain("## 一下子来了5个互选广告！");
    expect(md).toContain("[旧文](https://mp.weixin.qq.com/s?__biz=x&mid=1)");
    expect(md).toContain("![](https://mmbiz.qpic.cn/cover.jpg?wx_fmt=jpeg)");
  });
});
