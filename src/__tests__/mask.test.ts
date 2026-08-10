/**
 * v6.4 B 粘贴脱敏测试。
 *
 * 重点：
 * 1. 五类敏感信息正确脱敏（手机/邮箱/身份证/IP/密钥），保留可辨识前缀；
 * 2. 无敏感信息 → count 0、文本原样（**绝不误伤**）；
 * 3. 动作 detect 命中判定 + run 产出。
 */

import { describe, it, expect } from "vitest";
import { maskSensitiveText } from "@/lib/mask";
import { maskTransform } from "@/lib/transforms/maskTransform";
import { analyzeContent } from "@/lib/transforms/analyzer";
import type { TransformContext } from "@/lib/transforms/types";

function ctx(text: string): TransformContext {
  return { text, contentType: "text", features: analyzeContent(text, "text") };
}

describe("maskSensitiveText 各类脱敏", () => {
  it("手机号 → 138****1234", () => {
    const r = maskSensitiveText("请联系 13812345678 确认");
    expect(r.count).toBe(1);
    expect(r.text).toContain("138****5678");
  });

  it("邮箱 → a***@domain", () => {
    const r = maskSensitiveText("发到 admin@example.com 谢谢");
    expect(r.count).toBe(1);
    expect(r.text).toContain("ad***@example.com");
  });

  it("身份证 → 前6后4", () => {
    const r = maskSensitiveText("证件号 110101199003078811");
    expect(r.count).toBe(1);
    expect(r.text).toContain("110101********8811");
  });

  it("IPv4 → 全遮", () => {
    const r = maskSensitiveText("服务器 192.168.1.10 已重启");
    expect(r.count).toBe(1);
    expect(r.text).toContain("***.***.***.***");
  });

  it("密钥 token → 保留前4位", () => {
    const r = maskSensitiveText("key=sk-ant-api03-ABCDEFGHIJKLMNOPQRST");
    expect(r.count).toBe(1);
    expect(r.text).toContain("sk-a***");
  });

  it("多处混合 → 全部替换", () => {
    const r = maskSensitiveText("手机13812345678，邮箱a@b.com");
    expect(r.count).toBe(2);
  });
});

describe("maskSensitiveText 不误伤", () => {
  it("无敏感 → count 0 原文", () => {
    const r = maskSensitiveText("今天天气不错，下午开个会。");
    expect(r.count).toBe(0);
    expect(r.text).toBe("今天天气不错，下午开个会。");
  });

  it("短数字（非手机/身份证）不遮", () => {
    const r = maskSensitiveText("房间号 12 号");
    expect(r.count).toBe(0);
  });

  it("普通英文单词不遮", () => {
    const r = maskSensitiveText("just a normal sentence");
    expect(r.count).toBe(0);
  });
});

describe("maskTransform 动作", () => {
  it("含敏感内容 → detect 高置信命中 + run 产出脱敏文本", async () => {
    expect(maskTransform.detect(ctx("key=sk-ant-api03-ABCDEFGHIJKLMN"))).toBeGreaterThan(0);
    const r = await maskTransform.run("key=sk-ant-api03-ABCDEFGHIJKLMN");
    expect(r.ok).toBe(true);
    expect(r.output).not.toContain("sk-ant-api03-");
  });

  it("无敏感内容 → detect 0 + run 提示", async () => {
    expect(maskTransform.detect(ctx("一段普通文本"))).toBe(0);
    const r = await maskTransform.run("一段普通文本");
    expect(r.ok).toBe(false);
  });
});
