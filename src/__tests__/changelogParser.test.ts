import { describe, it, expect } from "vitest";
import { parseChangelogSection } from "@/lib/changelogParser";

describe("parseChangelogSection（运行时更新日志解析）", () => {
  it("结构化段落：还原分类、条目、分组与日期", () => {
    const md = [
      "## [5.4.0] - 2026-08-01",
      "",
      "### 新增",
      "- 新功能甲",
      "- 新功能乙",
      "",
      "### 修复",
      "**体验优化**",
      "- 修复丙：某场景下的问题",
      "  续行内容",
      "- 修复丁",
    ].join("\n");

    const entry = parseChangelogSection(md, "5.4.0");
    expect(entry).not.toBeNull();
    expect(entry!.version).toBe("5.4.0");
    expect(entry!.date).toBe("2026-08-01");
    expect(entry!.categories).toHaveLength(2);

    const [feat, fix] = entry!.categories;
    expect(feat.type).toBe("feat");
    expect(feat.name).toBe("新增");
    expect(feat.items?.map((i) => i.text)).toEqual(["新功能甲", "新功能乙"]);

    expect(fix.type).toBe("fix");
    expect(fix.groups).toHaveLength(1);
    expect(fix.groups![0].label).toBe("体验优化");
    // 缩进续行并入上一条目
    expect(fix.groups![0].items[0].text).toBe("修复丙：某场景下的问题 续行内容");
    expect(fix.groups![0].items[1].text).toBe("修复丁");
  });

  it("子项语法：用法→how 数组、配图→media、为什么→why（与 gen-changelog.mjs 一致）", () => {
    const md = [
      "### 新增",
      "- 取文字：截图里识别文字",
      "  为什么：截图里看到字，点一下直接识别",
      "  用法：点「取文字」按钮；按 T 直接复制全文",
      "  配图：ocr",
      "- 普通条目：没有子项",
    ].join("\n");

    const entry = parseChangelogSection(md, "5.5.0");
    expect(entry).not.toBeNull();
    const feat = entry!.categories[0];
    expect(feat.type).toBe("feat");

    const [rich, plain] = feat.items!;
    // 为什么：一句话价值说明
    expect(rich.why).toBe("截图里看到字，点一下直接识别");
    // 用法：按 ；;→/ 切分为步骤数组
    expect(rich.how).toEqual(["点「取文字」按钮", "按 T 直接复制全文"]);
    // 配图：插图 key 原样保留（Canvas 实时绘制，见 Illustration.tsx）
    expect(rich.media).toBe("ocr");
    // 无子项的条目不携带 why / how / media
    expect(plain.why).toBeUndefined();
    expect(plain.how).toBeUndefined();
    expect(plain.media).toBeUndefined();
  });

  it("子项只挂载到最近的 bullet；分类切换后不再误挂载", () => {
    const md = [
      "### 新增",
      "- 甲功能",
      "  用法：步骤一→步骤二",
      "### 修复",
      "- 乙修复",
      "  配图：docs/shots/fix.png",
    ].join("\n");

    const entry = parseChangelogSection(md, "5.5.1");
    const [feat, fix] = entry!.categories;
    expect(feat.items![0].how).toEqual(["步骤一", "步骤二"]);
    expect(feat.items![0].media).toBeUndefined();
    expect(fix.items![0].media).toBe("docs/shots/fix.png");
    expect(fix.items![0].how).toBeUndefined();
  });

  it("分类映射与构建时一致：修复→fix、改进→other、UI/UX→uiux、括号后缀剥离", () => {
    const md = [
      "### 修复",
      "- 甲",
      "### 改进",
      "- 乙",
      "### UI/UX 体验专项（58 项全部修复）",
      "- 丙",
      "### 崩溃与数据完整性",
      "- 丁",
    ].join("\n");

    const entry = parseChangelogSection(md, "9.9.9");
    expect(entry).not.toBeNull();
    const cats = entry!.categories;
    expect(cats.map((c) => c.type)).toEqual(["fix", "other", "uiux", "stability"]);
    // 显示名剥离括号注释
    expect(cats[2].name).toBe("UI/UX 体验专项");
  });

  it("平铺 bullet 列表（v5.3.2 及更早的 notes 格式）：归入单个「更新内容」分类", () => {
    const md = [
      "- 全屏编辑器主题样式丢失：已补齐样式导入",
      "- 托盘右键弹窗同类问题：已补齐样式并跟随用户主题",
      "- 版本徽章样式迁移：多窗口共用",
    ].join("\n");

    const entry = parseChangelogSection(md, "5.3.2");
    expect(entry).not.toBeNull();
    expect(entry!.version).toBe("5.3.2");
    expect(entry!.date).toBe("");
    expect(entry!.categories).toHaveLength(1);
    expect(entry!.categories[0].name).toBe("更新内容");
    expect(entry!.categories[0].type).toBe("other");
    expect(entry!.categories[0].items).toHaveLength(3);
  });

  it("CRLF 换行同样可解析（Windows runner 检出场景）", () => {
    const md = "### 修复\r\n- 条目甲\r\n- 条目乙\r\n";
    const entry = parseChangelogSection(md, "1.0.0");
    expect(entry).not.toBeNull();
    expect(entry!.categories[0].items?.map((i) => i.text)).toEqual(["条目甲", "条目乙"]);
  });

  it("摘要：首条 ≤40 字符原样；超长截断为 37 字符 + 省略号", () => {
    const short = parseChangelogSection("### 修复\n- 短摘要", "1.0.0");
    expect(short!.summary).toBe("短摘要");

    const longText = "这".repeat(50);
    const long = parseChangelogSection(`### 修复\n- ${longText}`, "1.0.0");
    expect(long!.summary).toBe("这".repeat(37) + "...");
    expect(long!.summary.length).toBe(40);
  });

  it("空输入 / 纯文本 / 无条目段落：返回 null（弹框走灰盒兜底）", () => {
    expect(parseChangelogSection(null, "1.0.0")).toBeNull();
    expect(parseChangelogSection("", "1.0.0")).toBeNull();
    expect(parseChangelogSection("   \n  \n", "1.0.0")).toBeNull();
    expect(parseChangelogSection("原始日志文本", "1.0.0")).toBeNull();
    expect(parseChangelogSection("### 修复\n（没有任何条目）", "1.0.0")).toBeNull();
  });
});
