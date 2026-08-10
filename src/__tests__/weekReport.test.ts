/**
 * v6.4 E 剪贴板周报：纯逻辑测试（行为侧写，不读内容）。
 */

import { describe, it, expect } from "vitest";
import { hourBuckets, statsToText, WEEK_REPORT_MIN_EVENTS } from "@/lib/weekReport";

describe("hourBuckets 时段分档", () => {
  it("24 槽 → 工作/晚间/深夜", () => {
    const hours = new Array(24).fill(0);
    hours[10] = 3; // work
    hours[21] = 2; // evening
    hours[2] = 1; // night
    expect(hourBuckets(hours)).toEqual({ work: 3, evening: 2, night: 1 });
  });

  it("边界：9 和 17 属工作，18 属晚间，0 属深夜", () => {
    const hours = new Array(24).fill(0);
    hours[9] = 1;
    hours[17] = 1;
    hours[18] = 1;
    hours[0] = 1;
    const b = hourBuckets(hours);
    expect(b.work).toBe(2);
    expect(b.evening).toBe(1);
    expect(b.night).toBe(1);
  });
});

describe("statsToText 拼接", () => {
  const stats = {
    total: 100,
    textCount: 60,
    imageCount: 20,
    fileCount: 20,
    hours: (() => {
      const h = new Array(24).fill(0);
      h[10] = 5;
      h[20] = 5;
      return h;
    })(),
    sources: [{ source: "VS Code", count: 50 }],
  };

  it("含转化率与各维度", () => {
    const t = statsToText(stats, 40, [{ actionId: "sql-in", count: 8 }]);
    expect(t).toContain("共复制 100 次");
    expect(t).toContain("40 次真正粘贴使用");
    expect(t).toContain("转化率 40%");
    expect(t).toContain("文本 60、图片 20、文件 20");
    expect(t).toContain("VS Code(50)");
    expect(t).toContain("sql-in(8)");
  });

  it("total 为 0 → 转化率 0 不除零", () => {
    const t = statsToText({ ...stats, total: 0 }, 0, []);
    expect(t).toContain("转化率 0%");
  });

  it("空来源/动作 → 暂无", () => {
    const t = statsToText({ ...stats, sources: [] }, 0, []);
    expect(t).toContain("暂无");
  });

  it("冷启动阈值常量防漂移", () => {
    expect(WEEK_REPORT_MIN_EVENTS).toBe(50);
  });
});
