/**
 * 来源名归一化的用例。
 *
 * 下面每一条输入都是 **2026-09-05 从真库拉出来的**，不是编的。
 * 真库共 341 个不同 `source`，其中 730 条记录含 `" - "`（连字符）、
 * 只有 16 条含 `" — "`（破折号）——而 `resolveSource` 原先只拆后者。
 */
import { describe, it, expect } from "vitest";
import { resolveSource, cleanSourceName } from "@/lib/source-mappings";

describe("resolveSource · 窗口标题提取应用名", () => {
  it("连字符分隔的窗口标题 → 取最后一段作为应用名", () => {
    // 真库里最典型的三种形态：三段、四段、带路径的
    expect(
      cleanSourceName("10．200．21．46 (SERVER) - 10.202.101.5:63389 - 远程桌面连接"),
    ).toBe("远程桌面连接");
    expect(
      cleanSourceName("长沙、成都爱尔眼科医院双双获评三级甲等 - 医院汇 - 丁香园"),
    ).toBe("丁香园");
    expect(
      cleanSourceName("aier - newar/src/client/InvcountImportablePanel.java - Eclipse IDE"),
    ).toBe("Eclipse IDE");
  });

  it("破折号分隔的（原本就支持的）不能回归", () => {
    expect(cleanSourceName("某个文档 — 记事本")).toBe("记事本");
  });

  it("两种分隔符混用时取**靠后**的那个", () => {
    expect(cleanSourceName("a — b - 真应用名")).toBe("真应用名");
    expect(cleanSourceName("a - b — 真应用名")).toBe("真应用名");
  });

  it("应用名自己带连字符但没空格 → 不误拆", () => {
    // GLM-5.3-Flash 里的连字符两边没空格，不该被当分隔符
    expect(cleanSourceName("GLM-5.3-Flash夜间免费活动真假")).toBe("GLM-5.3-Flash夜间免费…");
  });

  it("没有分隔符的短名字原样返回", () => {
    expect(cleanSourceName("企业微信")).toBe("企业微信");
    expect(cleanSourceName("WorkBuddy")).toBe("WorkBuddy");
  });

  it("空串返空串", () => {
    expect(cleanSourceName("")).toBe("");
  });
});

describe("resolveSource · matchPatterns 不得过宽", () => {
  it("Xterminal 不能被认成 Terminal", () => {
    // 真库里 Xterminal 有 191 条。`/Terminal/i` 是无锚点子串匹配，
    // 把它开头的 X 吃掉了——而那是一个独立软件，不是系统终端。
    expect(cleanSourceName("Xterminal")).toBe("Xterminal");
  });

  it("真正的终端仍然认得出来", () => {
    expect(resolveSource("Windows Terminal").displayName).toBe("Terminal");
    expect(resolveSource("命令提示符").displayName).toBe("Terminal");
    expect(resolveSource("Windows PowerShell").displayName).toBe("Terminal");
  });

  it("cmd 不能子串误中", () => {
    // 如果某个应用名里碰巧含 cmd（如 "abccmdxyz"），不该被归成终端
    expect(resolveSource("abccmdxyz").displayName).toBe("abccmdxyz");
  });
});

describe("resolveSource · 归一化的实际收益", () => {
  it("同一个 App 的不同窗口归到一起", () => {
    // 这正是每日整理算「主来源」靠的东西：不归一化的话，
    // 一段里同一个 App 会被数成好几个来源，主来源就选错。
    const a = cleanSourceName("a.java - Eclipse IDE");
    const b = cleanSourceName("b.java - Eclipse IDE");
    expect(a).toBe(b);
    expect(a).toBe("Eclipse IDE");
  });
});
