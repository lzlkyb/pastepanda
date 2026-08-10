import { describe, it, expect } from "vitest";
import {
  extractPrefFeatures,
  PREF_SENTENCE,
  PREF_OBSERVATION,
  type PrefFeature,
} from "@/lib/prefLearn";

describe("extractPrefFeatures—没信号的情况", () => {
  it("没改 → 空", () => {
    expect(extractPrefFeatures("一段译文", "一段译文")).toEqual([]);
  });

  it("改成空 → 空（清空不是风格偏好）", () => {
    expect(extractPrefFeatures("一段很长的译文内容放在这里", "")).toEqual([]);
    expect(extractPrefFeatures("", "随便写的")).toEqual([]);
  });

  it("微调不应该产生信号", () => {
    const before = "这是一段长度足够的中文文本，里面有一个字得改一下才通顺。";
    const after = "这是一段长度足够的中文文本，里面有一个词得改一下才通顺。";
    expect(extractPrefFeatures(before, after)).toEqual([]);
  });

  it("太短的产物不做长度判断", () => {
    // 十几个字删两个就到 70%，那是噪声不是意图
    expect(extractPrefFeatures("短文本一句话", "短")).toEqual([]);
  });
});

describe("extractPrefFeatures—具体特征", () => {
  it("删掉开场说明", () => {
    const before = "好的，以下是翻译结果：\nHello world";
    const after = "Hello world";
    expect(extractPrefFeatures(before, after)).toContain("dropped_preamble");
  });

  it("删掉称呼问候", () => {
    const before = "您好，张经理：\n项目进展如下，这里是正文内容。";
    const after = "项目进展如下，这里是正文内容。";
    expect(extractPrefFeatures(before, after)).toContain("dropped_greeting");
  });

  it("删掉结尾客套", () => {
    const before = "正文内容在这里，这是一段足够长的正文。\n此致\n敬礼";
    const after = "正文内容在这里，这是一段足够长的正文。";
    expect(extractPrefFeatures(before, after)).toContain("dropped_closing");
  });

  it("去掉 Markdown 标记", () => {
    const before = "## 标题\n- 第一条\n- 第二条\n**重点**在这里";
    const after = "标题\n第一条\n第二条\n重点在这里";
    expect(extractPrefFeatures(before, after)).toContain("dropped_markdown");
  });

  it("只少一个 Markdown 标记不算去掉", () => {
    const before = "- a\n- b\n- c\n- d";
    const after = "- a\n- b\n- c\nd";
    expect(extractPrefFeatures(before, after)).not.toContain("dropped_markdown");
  });

  it("敬语改口语", () => {
    const before = "请您确认一下这份文件，如果您有疑问随时联系我。";
    const after = "你确认下这份文件，有疑问随时联系我。";
    expect(extractPrefFeatures(before, after)).toContain("formal_to_casual");
  });

  it("口语改敬语", () => {
    const before = "你看下这份文件，有问题告诉我就行了谢谢。";
    const after = "请您查阅这份文件，如您有疑问请告知。";
    expect(extractPrefFeatures(before, after)).toContain("casual_to_formal");
  });

  it("单个您不触发敬语方向（避免误判）", () => {
    const before = "这份文件需要您确认，其余内容保持不变就可以了。";
    const after = "这份文件需要你确认，其余内容保持不变就可以了。";
    expect(extractPrefFeatures(before, after)).not.toContain("formal_to_casual");
  });
});

describe("extractPrefFeatures—具体特征优先于长度", () => {
  /**
   * 这条是设计的关键：删开场/称呼/客套必然让文本变短。如果两类都记，
   * shorter 会在所有动作上遥遥领先，最后提议出来的永远是最没用的
   * 「输出再精简一些」，而用户真正想要的是「别写开场白」。
   */
  it("删开场同时大幅变短时，只报开场不报 shorter", () => {
    const before =
      "好的，以下是我为您整理的翻译结果，希望对您有帮助：\nHello";
    const after = "Hello";
    const f = extractPrefFeatures(before, after);
    expect(f).toContain("dropped_preamble");
    expect(f).not.toContain("shorter");
  });

  // 下面两条的 before 必须 ≥ MIN_LEN_FOR_RATIO（40），否则会被“太短不做长度判断”拦下
  it("没有具体特征时才报 shorter", () => {
    const before =
      "这个功能的实现涉及到多个模块的改动，需要先改数据层，再改命令层，最后改前端，还要补上测试。";
    const after = "这个功能要改数据层、命令层和前端。";
    expect(extractPrefFeatures(before, after)).toEqual(["shorter"]);
  });

  it("没有具体特征时才报 longer", () => {
    const before =
      "这个功能要改数据层、命令层和前端三个地方，另外还需要补一下相应的测试用例才算完整。";
    const after =
      "这个功能的实现涉及到多个模块的改动，需要先修改数据层的表结构，然后调整命令层的接口，最后再改前端的展示，另外还要补齐相应的测试用例。";
    expect(extractPrefFeatures(before, after)).toEqual(["longer"]);
  });
});

describe("映射表完整性", () => {
  const ALL: PrefFeature[] = [
    "shorter",
    "longer",
    "dropped_preamble",
    "dropped_greeting",
    "dropped_closing",
    "dropped_markdown",
    "formal_to_casual",
    "casual_to_formal",
  ];

  it("每个特征都有偏好句与观察文案", () => {
    // 少一条映射就会在建议条上渲出 undefined，而那是用户可见的
    for (const f of ALL) {
      expect(PREF_SENTENCE[f], `${f} 缺偏好句`).toBeTruthy();
      expect(PREF_OBSERVATION[f], `${f} 缺观察文案`).toBeTruthy();
    }
  });
});
