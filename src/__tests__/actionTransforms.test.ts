/**
 * 执行类动作（kind: "action"）的 detect 匹配度。
 *
 * 重点盯两件事：
 * 1. **误判是安全风险**：动作点下去就有真实副作用（打开浏览器/资源管理器）。
 *    所以"看起来像但实际不是"必须 0 分——多行内容、含空格、伪 IP 全要拦下；
 * 2. 每类目标只命中自己那一类，URL 不会触发发邮件、路径不会触发查域名。
 */

import { describe, it, expect } from "vitest";
import { actionTransforms } from "@/lib/transforms/actionTransforms";
import { analyzeContent } from "@/lib/transforms/analyzer";
import type { TransformContext } from "@/lib/transforms/types";

function ctx(text: string, contentType = "text"): TransformContext {
  return { text, contentType, features: analyzeContent(text, contentType) };
}

const t = (id: string) => {
  const hit = actionTransforms.find((x) => x.id === id);
  if (!hit) throw new Error(`找不到动作 ${id}`);
  return hit;
};

describe("act-open-url（打开链接）", () => {
  it("识别 http/https URL", () => {
    expect(t("act-open-url").detect(ctx("https://github.com/lzlkyb/pastepanda"))).toBeGreaterThan(0);
    expect(t("act-open-url").detect(ctx("http://example.com/a?b=1&c=2"))).toBeGreaterThan(0);
  });

  it("无协议/普通文本/多行不命中", () => {
    expect(t("act-open-url").detect(ctx("github.com"))).toBe(0); // 没写协议
    expect(t("act-open-url").detect(ctx("hello world"))).toBe(0);
    expect(t("act-open-url").detect(ctx("https://a.com\nhttps://b.com"))).toBe(0); // 多行
  });
});

describe("act-open-path（资源管理器打开）", () => {
  it("识别 Windows 绝对路径与 UNC", () => {
    expect(t("act-open-path").detect(ctx("C:\\Users\\me\\file.txt"))).toBeGreaterThan(0);
    expect(t("act-open-path").detect(ctx("C:/Users/me/folder"))).toBeGreaterThan(0);
    expect(t("act-open-path").detect(ctx("\\\\server\\share\\x.txt"))).toBeGreaterThan(0);
  });

  it("非绝对路径不命中", () => {
    expect(t("act-open-path").detect(ctx("C:file.txt"))).toBe(0); // 相对盘符路径
    expect(t("act-open-path").detect(ctx("Users/me/file.txt"))).toBe(0);
    expect(t("act-open-path").detect(ctx("hello"))).toBe(0);
  });
});

describe("act-mailto（发邮件）", () => {
  it("识别单个邮箱", () => {
    expect(t("act-mailto").detect(ctx("a@b.com"))).toBeGreaterThan(0);
  });

  it("多邮箱/含空白/不是邮箱不命中", () => {
    expect(t("act-mailto").detect(ctx("a@b.com c@d.com"))).toBe(0); // 两个邮箱混在一起
    expect(t("act-mailto").detect(ctx("a@b"))).toBe(0);
    expect(t("act-mailto").detect(ctx("not-an-email"))).toBe(0);
  });
});

describe("act-lookup（查询 IP / 域名）", () => {
  it("识别 IPv4 与域名", () => {
    expect(t("act-lookup").detect(ctx("192.168.1.1"))).toBeGreaterThan(0);
    expect(t("act-lookup").detect(ctx("google.com"))).toBeGreaterThan(0);
    expect(t("act-lookup").detect(ctx("sub.example.co.uk"))).toBeGreaterThan(0);
  });

  it("伪 IP / 单 token / 普通句子不命中", () => {
    expect(t("act-lookup").detect(ctx("999.1.1.1"))).toBe(0); // 段超 255
    expect(t("act-lookup").detect(ctx("1.2.3.999"))).toBe(0);
    expect(t("act-lookup").detect(ctx("localhost"))).toBe(0); // 无点不算域名
    expect(t("act-lookup").detect(ctx("not a domain at all"))).toBe(0);
  });
});

describe("执行类动作的安全底线", () => {
  it("多行内容一律不命中（有副作用的东西不能对整段文本误触发）", () => {
    const messy = ctx("https://a.com\nC:\\Users\\me\\file.txt\na@b.com");
    for (const a of actionTransforms) {
      expect(a.detect(messy)).toBe(0);
    }
  });

  it("每类目标只命中自己那一个动作", () => {
    const url = ctx("https://example.com/path");
    const path = ctx("C:\\Users\\me\\file.txt");
    const mail = ctx("a@b.com");
    const ip = ctx("8.8.8.8");

    expect(t("act-open-url").detect(url)).toBeGreaterThan(0);
    expect(t("act-open-path").detect(url)).toBe(0);
    expect(t("act-mailto").detect(url)).toBe(0);

    expect(t("act-open-path").detect(path)).toBeGreaterThan(0);
    expect(t("act-open-url").detect(path)).toBe(0);

    expect(t("act-mailto").detect(mail)).toBeGreaterThan(0);
    expect(t("act-open-path").detect(mail)).toBe(0);

    expect(t("act-lookup").detect(ip)).toBeGreaterThan(0);
    expect(t("act-open-url").detect(ip)).toBe(0);
    expect(t("act-mailto").detect(ip)).toBe(0);
  });

  it("所有执行类动作都声明了 kind: action", () => {
    for (const a of actionTransforms) {
      expect(a.kind).toBe("action");
    }
  });
});
