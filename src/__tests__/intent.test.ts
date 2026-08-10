/**
 * intent.test.ts — 意图识别引擎（V3-A）规则测试。
 */
import { describe, it, expect } from "vitest";
import { detectIntent } from "@/lib/intent";

const ctx = (text: string, contentType = "text") => ({ text, contentType });

describe("detectIntent · 排错意图", () => {
  it("报错关键字 + 代码类 → troubleshoot", () => {
    const i = detectIntent(ctx("Error: cannot find module 'react'\n  at webpack...", "code"));
    expect(i).not.toBeNull();
    expect(i!.id).toBe("troubleshoot");
    expect(i!.actionIds[0]).toBe("ai-explain-code");
  });

  it("中文报错也识别", () => {
    const i = detectIntent(ctx("异常：连接超时，请检查网络后重试", "log"));
    expect(i?.id).toBe("troubleshoot");
  });

  it("普通文本无报错关键字 → 不误报", () => {
    const i = detectIntent(ctx("今天天气不错"));
    expect(i?.id).not.toBe("troubleshoot");
  });
});

describe("detectIntent · JSON/结构化意图", () => {
  it("JSON 对象 → json-shape（生成类型优先）", () => {
    const i = detectIntent(ctx('{"name":"x","age":1}', "json"));
    expect(i?.id).toBe("json-shape");
    expect(i!.actionIds).toContain("ai-json-to-type");
  });

  it("JSON 数组 → json-shape（转 SQL 优先）", () => {
    const i = detectIntent(ctx("[1,2,3]", "json"));
    expect(i?.id).toBe("json-shape");
    expect(i!.actionIds[0]).toBe("json_format");
    expect(i!.actionIds).toContain("query-result-to-sql");
  });
});

describe("detectIntent · 收集链接", () => {
  it("单条含 2+ URL → collect-links", () => {
    const i = detectIntent(
      ctx("参考 https://docs.rs/rmcp 和 https://github.com/x/y 的文档"),
    );
    expect(i?.id).toBe("collect-links");
    expect(i!.actionIds).toContain("url-summary");
  });

  it("最近连续 2 条链接 + 当前也含链接 → collect-links", () => {
    const i = detectIntent(
      ctx("再看这个 https://example.com/a"),
      undefined,
      [{ text: "https://example.com/1" }, { text: "https://example.com/2" }],
    );
    expect(i?.id).toBe("collect-links");
  });
});

describe("detectIntent · 批量数据", () => {
  it("3+ IP → batch（合并 SQL IN）", () => {
    const i = detectIntent(ctx("192.168.1.1\n192.168.1.2\n192.168.1.3"));
    expect(i?.id).toBe("batch");
    expect(i!.actionIds).toContain("sql-in");
  });

  it("3+ 手机号 → batch", () => {
    const i = detectIntent(ctx("13812345678 13900001111 13712349999"));
    expect(i?.id).toBe("batch");
  });
});

describe("detectIntent · 长文本提炼", () => {
  it("500+ 字文本 → digest", () => {
    const long = "测试内容".repeat(130); // 520 字
    const i = detectIntent(ctx(long));
    expect(i?.id).toBe("digest");
    expect(i!.actionIds[0]).toBe("ai-summarize");
  });

  it("短文本不触发 digest", () => {
    const i = detectIntent(ctx("短文本"));
    expect(i?.id).not.toBe("digest");
  });
});

describe("detectIntent · 财务", () => {
  it("≥2 处金额 → finance", () => {
    const i = detectIntent(ctx("A 项 ¥123.45，B 项 ¥678.90，合计约 ¥800"));
    expect(i?.id).toBe("finance");
    expect(i!.actionIds[0]).toBe("ai-tabulate");
  });
});

describe("detectIntent · 综合", () => {
  it("空文本 / 未知内容 → null", () => {
    expect(detectIntent(ctx(""))).toBeNull();
    expect(detectIntent(ctx("  \n  "))).toBeNull();
  });

  it("只返回置信度最高的一个意图", () => {
    // 同时是报错 + 长文本 → 取置信更高的 troubleshoot
    const i = detectIntent(ctx("Error: something failed\n" + "x".repeat(600), "code"));
    expect(i?.id).toBe("troubleshoot");
  });
});

// ---------------------------------------------------------------------------
// 以下是 6 处意图误判的回归用例（编号对应修复清单 ①~⑥）。
// 重点都在「不得返回某意图」：意图建议优先级高于所有单动作建议，
// 误报比漏报严重得多；万一日后有人把判据改宽，这里应该立刻变红。
// ---------------------------------------------------------------------------

describe("detectIntent · ① 排错意图不吃普通文本", () => {
  it("「这次活动失败了，下次再试」ct=text → 不判排错", () => {
    expect(detectIntent(ctx("这次活动失败了，下次再试"))?.id).not.toBe("troubleshoot");
  });

  it("「登录失败，请重试」ct=text → 不判排错", () => {
    expect(detectIntent(ctx("登录失败，请重试"))?.id).not.toBe("troubleshoot");
  });

  it("「订单异常」ct=text → 不判排错", () => {
    expect(detectIntent(ctx("订单异常"))?.id).not.toBe("troubleshoot");
  });

  it("带分号与尖括号的普通中文句 ct=text → 不判排错（旧 /[;{}<>]/ 判据太弱）", () => {
    expect(detectIntent(ctx("导入失败；请检查 <配置> 后重试"))?.id).not.toBe("troubleshoot");
  });

  it("Java 堆栈 ct=text → 仍判排错", () => {
    const stack = [
      "java.lang.NullPointerException: null",
      "\tat com.example.Foo.bar(Foo.java:42)",
      "\tat com.example.Foo.main(Foo.java:11)",
    ].join("\n");
    expect(detectIntent(ctx(stack))?.id).toBe("troubleshoot");
  });

  it("Python Traceback ct=text → 仍判排错", () => {
    const stack = [
      "Traceback (most recent call last):",
      '  File "app.py", line 3, in <module>',
      '    raise ValueError("bad")',
      "ValueError: bad",
    ].join("\n");
    expect(detectIntent(ctx(stack))?.id).toBe("troubleshoot");
  });

  it("ct=code + error → 保持原行为", () => {
    const i = detectIntent(ctx('if (e) { throw new Error("boom"); }', "code"));
    expect(i?.id).toBe("troubleshoot");
  });

  it("ct=log + failed → 保持原行为", () => {
    const i = detectIntent(ctx("2026-08-10 10:00:00 job failed after 3 retries", "log"));
    expect(i?.id).toBe("troubleshoot");
  });
});

describe("detectIntent · ② JSON 形状兜底必须真能 parse", () => {
  it("[INFO] 日志行 ct=text → 不判 json-shape", () => {
    const i = detectIntent(ctx("[INFO] 2026-08-10 10:00:00 request completed"));
    expect(i?.id).not.toBe("json-shape");
  });

  it("[1] 参考文献 ct=text → 不判 json-shape", () => {
    expect(detectIntent(ctx("[1] 参考文献"))?.id).not.toBe("json-shape");
  });

  it("markdown 链接 ct=text → 不判 json-shape", () => {
    expect(detectIntent(ctx("[链接](http://example.com)"))?.id).not.toBe("json-shape");
  });

  it("对象形状兜底（ct=text）→ json-shape 对象分支", () => {
    const i = detectIntent(ctx('{"a":1}'));
    expect(i?.id).toBe("json-shape");
    expect(i!.actionIds[0]).toBe("ai-json-to-type");
  });

  it("对象数组形状兜底（ct=text）→ json-shape 数组分支", () => {
    const i = detectIntent(ctx('[{"a":1},{"a":2}]'));
    expect(i?.id).toBe("json-shape");
    expect(i!.actionIds[0]).toBe("json_format");
  });

  it("ct=json 但内容被截断 → 仍信分类器", () => {
    expect(detectIntent(ctx('{"a":1', "json"))?.id).toBe("json-shape");
  });
});

describe("detectIntent · ③ 财务意图不吃 shell/代码里的 $n", () => {
  it("awk '{print $1, $2}' ct=shell → 不判 finance", () => {
    expect(detectIntent(ctx("awk '{print $1, $2}'", "shell"))?.id).not.toBe("finance");
  });

  it("sed 反向引用 ct=code → 不判 finance", () => {
    const i = detectIntent(ctx(String.raw`sed 's/\(a\)\(b\)/$2$1/'`, "code"));
    expect(i?.id).not.toBe("finance");
  });

  it("裸 $1/$2 即使 ct=text 也不算金额（位数太少）", () => {
    expect(detectIntent(ctx("参数 $1 和 $2 分别是路径与模式"))?.id).not.toBe("finance");
  });

  it("正常金额文本 ct=text → finance", () => {
    const i = detectIntent(ctx("总计 ¥1200，定金 ¥300"));
    expect(i?.id).toBe("finance");
    expect(i!.actionIds[0]).toBe("ai-tabulate");
  });
});

describe("detectIntent · ④ 手机号需要数字边界", () => {
  it("三个正常手机号（换行分隔）→ batch", () => {
    const i = detectIntent(ctx("13812345678\n13900001111\n13712349999"));
    expect(i?.id).toBe("batch");
  });

  it("40 位纯数字串 → 不判 batch（旧正则能从中切出 3 个假手机号）", () => {
    const digits = "13812345678".repeat(4).slice(0, 40);
    expect(digits).toHaveLength(40);
    expect(detectIntent(ctx(digits))?.id).not.toBe("batch");
  });
});

describe("detectIntent · ⑤ scene 参数不参与意图判定", () => {
  it("传入 scene 与不传结果完全一致", () => {
    const text = "总计 ¥1200，定金 ¥300";
    const withScene = detectIntent(ctx(text), { hourBucket: "work", sourceCat: "terminal" });
    expect(withScene).toEqual(detectIntent(ctx(text)));
  });
});

describe("detectIntent · ⑥ 优先级由 confidence 数值显式表达", () => {
  it("JSON 数组同时命中批量（3 个手机号）→ 取 json-shape", () => {
    const i = detectIntent(ctx('["13812345678","13900001111","13712349999"]', "json"));
    expect(i?.id).toBe("json-shape");
  });

  it("json-shape 的置信度严格大于 batch，不靠 sort 稳定性", () => {
    const json = detectIntent(ctx('{"a":1}', "json"));
    const batch = detectIntent(ctx("192.168.1.1\n192.168.1.2\n192.168.1.3"));
    expect(json!.confidence).toBeGreaterThan(batch!.confidence);
  });
});
