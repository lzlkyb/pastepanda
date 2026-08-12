/**
 * 审查 #2（规则双写一致性）：来源应用分类的前端钉住测试。
 *
 * 用例表与后端 `data_store/action_events.rs::source_cat` 的测试保持一致——
 * 两边各有一份同样的用例，任一方向改了分类规则，另一端测试立即告警。
 */

import { describe, it, expect } from "vitest";
import { sourceCatOf, hourBucketOf } from "@/lib/recommend";

describe("sourceCatOf 与后端 source_cat 一致（双写护栏）", () => {
  it("IDE", () => {
    expect(sourceCatOf("CodeBuddy.exe")).toBe("ide");
    expect(sourceCatOf("Visual Studio Code")).toBe("ide");
    expect(sourceCatOf("WebStorm")).toBe("ide");
  });

  it("浏览器", () => {
    expect(sourceCatOf("chrome.exe")).toBe("browser");
    expect(sourceCatOf("Microsoft Edge")).toBe("browser");
    expect(sourceCatOf("Firefox")).toBe("browser");
  });

  it("终端", () => {
    expect(sourceCatOf("WindowsTerminal.exe")).toBe("terminal");
    expect(sourceCatOf("powershell")).toBe("terminal");
    expect(sourceCatOf("cmd")).toBe("terminal");
  });

  it("聊天", () => {
    expect(sourceCatOf("WeChat.exe")).toBe("chat");
    expect(sourceCatOf("企业微信")).toBe("chat");
    expect(sourceCatOf("钉钉")).toBe("chat");
    expect(sourceCatOf("telegram")).toBe("chat");
  });

  it("其他", () => {
    expect(sourceCatOf("unknown-app")).toBe("other");
    expect(sourceCatOf("")).toBe("other");
  });

  it("大小写不敏感", () => {
    expect(sourceCatOf("CHROME")).toBe("browser");
    expect(sourceCatOf("Wechat")).toBe("chat");
  });
});

describe("hourBucketOf 时段桶", () => {
  it("工作时间 9-17", () => {
    expect(hourBucketOf(9)).toBe("work");
    expect(hourBucketOf(12)).toBe("work");
    expect(hourBucketOf(17)).toBe("work");
  });
  it("晚间 18-23", () => {
    expect(hourBucketOf(18)).toBe("evening");
    expect(hourBucketOf(23)).toBe("evening");
  });
  it("深夜-凌晨 0-8", () => {
    expect(hourBucketOf(0)).toBe("night");
    expect(hourBucketOf(8)).toBe("night");
  });
});
