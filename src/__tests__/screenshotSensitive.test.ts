/**
 * 截图 OCR 文本的敏感内容扫描（红线兜底）。
 *
 * 它把守的是「识别出的文字会不会被自动发到云端」这道闸，漏报的代价是密钥泄露。
 *
 * ⚠️ 本文件里的假密钥一律用**字符串拼接**造，不写成完整字面量——
 * 否则会被 GitHub 的 secret scanning 当成真密钥拦住 push（这个坑踩过）。
 */

import { describe, it, expect } from "vitest";
import { detectSensitiveText } from "@/lib/screenshot/sensitive";

describe("detectSensitiveText", () => {
  it("空文本 / 普通文本 → 不拦", () => {
    expect(detectSensitiveText("")).toBeNull();
    expect(detectSensitiveText("今天开会讨论了三个议题，下周一交初稿。")).toBeNull();
    expect(detectSensitiveText("const a = 1;\nfunction hello() {}")).toBeNull();
  });

  it("OpenAI 风格密钥", () => {
    const fake = "sk-" + "A1b2C3d4E5f6G7h8I9j0K1l2";
    expect(detectSensitiveText(`配置里写了 ${fake} 这一行`)).toBe("API Key（sk-*）");
  });

  it("AWS Access Key", () => {
    const fake = "AKIA" + "IOSFODNN7EXAMPLE";
    expect(detectSensitiveText(fake)).toBe("AWS Access Key");
  });

  it("GitHub Token（两种形式）", () => {
    expect(detectSensitiveText("ghp_" + "a".repeat(36))).toBe("GitHub Token");
    expect(detectSensitiveText("github_pat_" + "b".repeat(24))).toBe("GitHub Token");
  });

  it("PEM 私钥头", () => {
    expect(detectSensitiveText("-----BEGIN RSA PRIVATE KEY-----\nMIIE...")).toBe("私钥（PEM）");
    expect(detectSensitiveText("-----BEGIN PRIVATE KEY-----")).toBe("私钥（PEM）");
  });

  it("密码赋值行（大小写不敏感、等号与冒号都算）", () => {
    expect(detectSensitiveText("password = hunter2xx")).toBe("密码");
    expect(detectSensitiveText("PASSWORD: s3cr3t99")).toBe("密码");
    // 太短不算（< 6 位）
    expect(detectSensitiveText("password = 12345")).toBeNull();
  });

  it("api_key / api-key / apikey 赋值行", () => {
    expect(detectSensitiveText("api_key = abcdefgh12")).toBe("API Key");
    expect(detectSensitiveText("api-key: abcdefgh12")).toBe("API Key");
    expect(detectSensitiveText("apikey=abcdefgh12")).toBe("API Key");
  });

  it("JWT 三段式", () => {
    const jwt = ["a".repeat(24), "b".repeat(24), "c".repeat(12)].join(".");
    expect(detectSensitiveText(jwt)).toBe("JWT");
  });

  it("命中多条时返回第一条（按声明顺序）", () => {
    const text = "sk-" + "A1b2C3d4E5f6G7h8I9j0K1l2" + "\nAKIA" + "IOSFODNN7EXAMPLE";
    expect(detectSensitiveText(text)).toBe("API Key（sk-*）");
  });

  it("已知误报面：长路径形的三段字符串会被当成 JWT", () => {
    // 不是 bug 而是取舍：宁可误拦（弹一个确认框）也不能漏发。
    // 写成测试是为了让这个行为是「已知且有意」，而不是以后被当成新 bug 重新发现。
    const pathLike = ["x".repeat(22), "y".repeat(22), "z".repeat(14)].join(".");
    expect(detectSensitiveText(pathLike)).toBe("JWT");
  });
});
