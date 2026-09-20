import { describe, expect, it } from "vitest";
import type { RcFileAsk, RcFileTask } from "@/lib/api/rcFile";
import {
  ASK_LATE_MS,
  ASK_TIMEOUT_MS,
  RateTracker,
  askCountdown,
  askPrompt,
  barSummary,
  canOpenPath,
  classifyErr,
  closingText,
  doneCount,
  formatBytes,
  formatEta,
  formatRate,
  isTerminal,
  parseFileSnapshot,
  runningTasks,
  sortTasks,
  taskLine,
  taskPercent,
  waitingHint,
} from "@/lib/rcFile";

function task(p: Partial<RcFileTask> = {}): RcFileTask {
  return {
    id: "t1",
    peer: "node",
    peer_name: "笔记本",
    dir: "recv",
    name: "报告.zip",
    size: 1000,
    offset: 0,
    done: 0,
    state: "transferring",
    started_ms: 1_000,
    updated_ms: 2_000,
    ...p,
  };
}

function ask(p: Partial<RcFileAsk> = {}): RcFileAsk {
  return {
    id: "a1",
    peer: "node",
    peer_name: "笔记本",
    kind: "push",
    name: "照片.jpg",
    size: 2048,
    first_seen_ms: 10_000,
    ...p,
  };
}

describe("parseFileSnapshot", () => {
  it("非对象 / null 一律当空快照，不抛", () => {
    for (const bad of [null, undefined, 42, "x", true]) {
      expect(parseFileSnapshot(bad)).toEqual({ asks: [], tasks: [] });
    }
  });

  it("缺字段的数组当空（半截事件不该让 UI 崩）", () => {
    expect(parseFileSnapshot({})).toEqual({ asks: [], tasks: [] });
    expect(parseFileSnapshot({ asks: "no", tasks: { nope: 1 } })).toEqual({
      asks: [],
      tasks: [],
    });
  });

  it("丢掉形状不对的条目，保留合法的", () => {
    const got = parseFileSnapshot({
      asks: [{ id: "a1", kind: "push" }, { id: 2, kind: "push" }, { kind: "push" }],
      tasks: [{ id: "t1", size: 10, done: 2 }, { id: "x" }],
    });
    expect(got.asks).toHaveLength(1);
    expect(got.tasks).toHaveLength(1);
  });
});

describe("formatBytes", () => {
  it("0 字节是合法值，不是「无」", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("四档单位都到得了", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });

  it("非法输入给占位符", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatRate / formatEta", () => {
  it("量不到速率时不报假数", () => {
    expect(formatRate(0)).toBe("—");
    expect(formatRate(500)).toBe("—"); // 低于 1 KB/s
    expect(formatRate(6.2 * 1024 * 1024)).toBe("6.2 MB/s");
  });

  it("剩余时间三档 + 边界", () => {
    expect(formatEta(0)).toBe("即将完成");
    expect(formatEta(400)).toBe("剩 <1s");
    expect(formatEta(12_400)).toBe("剩 12s");
    expect(formatEta(180_000)).toBe("剩 3m");
    expect(formatEta(4_320_000)).toBe("剩 1.2h");
  });
});

describe("taskPercent", () => {
  it("size 未知（pull 尚未定文件）按 0，不除零", () => {
    expect(taskPercent(task({ size: 0, done: 0 }))).toBe(0);
  });

  it("正常比例与上限夹住", () => {
    expect(taskPercent(task({ size: 1000, done: 420 }))).toBe(42);
    expect(taskPercent(task({ size: 1000, done: 1200 }))).toBe(100);
  });
});

describe("状态分档", () => {
  it("isTerminal 覆盖四个终态", () => {
    expect(isTerminal("awaiting")).toBe(false);
    expect(isTerminal("transferring")).toBe(false);
    for (const s of ["done", "denied", "failed", "canceled"] as const) {
      expect(isTerminal(s)).toBe(true);
    }
  });

  it("running / doneCount", () => {
    const list = [
      task({ id: "a", state: "transferring" }),
      task({ id: "b", state: "done" }),
      task({ id: "c", state: "failed" }),
      task({ id: "d", state: "awaiting" }),
    ];
    expect(runningTasks(list).map((t) => t.id)).toEqual(["a", "d"]);
    expect(doneCount(list)).toBe(1);
  });

  describe("canOpenPath（完成态「打开所在文件夹」的开关）", () => {
    it("终态且有路径 → 给按钮", () => {
      expect(canOpenPath(task({ state: "done", path: "C:\\x\\报告.zip" }))).toBe(true);
      // 失败/取消也有价值：收侧中断留下的是同目录的 .pppart，用户去找它才知道发生了什么
      expect(canOpenPath(task({ state: "failed", path: "C:\\x\\报告.zip" }))).toBe(true);
      expect(canOpenPath(task({ state: "canceled", path: "C:\\x\\报告.zip" }))).toBe(true);
    });

    it("还在跑 → 不给（文件还没落定，打开只会让人困惑）", () => {
      expect(canOpenPath(task({ state: "transferring", path: "C:\\x\\a.zip" }))).toBe(false);
      expect(canOpenPath(task({ state: "awaiting", path: "C:\\x\\a.zip" }))).toBe(false);
    });

    it("后端没给路径 → 不给（契约是「键不出现」，不是空串）", () => {
      expect(canOpenPath(task({ state: "done" }))).toBe(false);
      expect(canOpenPath(task({ state: "done", path: "" }))).toBe(false);
    });
  });

  it("sortTasks：运行中在上，其余按开始时间倒序", () => {
    const list = [
      task({ id: "old", state: "done", started_ms: 1 }),
      task({ id: "new", state: "done", started_ms: 9 }),
      task({ id: "run", state: "transferring", started_ms: 2 }),
    ];
    expect(sortTasks(list).map((t) => t.id)).toEqual(["run", "new", "old"]);
  });
});

describe("barSummary", () => {
  const rate = () => 0;

  it("没有运行中的任务就不占位", () => {
    expect(barSummary([task({ state: "done" })], rate)).toBeNull();
  });

  it("单条：序号/总数 + 百分比", () => {
    const s = barSummary([task({ dir: "send", size: 100, done: 42 })], rate);
    expect(s).toBe("传文件中 1/1 · 42%");
  });

  it("多文件串行时序号按「总数 - 剩余」推算，不是 1/1", () => {
    const list = [
      task({ id: "a", state: "done", size: 100, done: 100 }),
      task({ id: "b", state: "done", size: 100, done: 100 }),
      task({ id: "c", state: "transferring", size: 100, done: 10 }),
      task({ id: "d", state: "transferring", size: 100, done: 0 }),
    ];
    // 剩 2 条 → 当前是第 4-2+1 = 3 条
    expect(barSummary(list, rate)).toBe("传文件中 3/4 · 0%");
  });

  it("有速率时补速率与 ETA", () => {
    // 剩 6 MiB，速率 6.2 MiB/s → 0.97s，落在「剩 <1s」档
    const t = task({ size: 12 * 1024 * 1024, done: 6 * 1024 * 1024 });
    expect(barSummary([t], () => 6.2 * 1024 * 1024)).toBe(
      "传文件中 1/1 · 50% · 6.2 MB/s · 剩 <1s",
    );
    // 放慢到 1 MiB/s → 6s，验证 ETA 真的参与拼接（不只是恒为 <1s）
    expect(barSummary([t], () => 1024 * 1024)).toBe("传文件中 1/1 · 50% · 1.0 MB/s · 剩 6s");
  });
});

describe("taskLine", () => {
  it("发送与接收的等待态文案不同（一个等对方确认、一个等自己去选）", () => {
    expect(taskLine(task({ state: "awaiting", dir: "send" }), 0)).toBe("等待对方确认…");
    expect(taskLine(task({ state: "awaiting", dir: "recv" }), 0)).toBe("等待你选择文件…");
  });

  it("传输中带速率与 ETA", () => {
    const t = task({ dir: "send", size: 2048, done: 1024 });
    expect(taskLine(t, 1024)).toBe("发送中 50% · 1.0 KB/s · 剩 1s");
  });

  it("终态各说各话", () => {
    expect(taskLine(task({ state: "done", dir: "recv", done: 12 }), 0)).toBe("接收完成 · 12 B");
    expect(taskLine(task({ state: "denied" }), 0)).toBe("对方拒绝了");
    expect(taskLine(task({ state: "canceled" }), 0)).toBe("已取消（保留断点，可续传）");
    expect(taskLine(task({ state: "failed", err: "[file_unsupported] x" }), 0)).toBe(
      "对方可能是不支持文件传输的旧版本",
    );
  });
});

describe("closingText", () => {
  it("还在跑就不给总结", () => {
    expect(closingText(task({ state: "transferring" }))).toBeNull();
  });

  it("完成按方向分：收侧「已收到」、发侧「已送达」", () => {
    expect(closingText(task({ state: "done", dir: "recv", name: "a.zip", done: 512 }))).toBe(
      "已收到 a.zip（512 B）",
    );
    expect(closingText(task({ state: "done", dir: "send", name: "a.zip", done: 512 }))).toBe(
      "已送达 a.zip（512 B）",
    );
  });

  it("失败把分档后的标题拼进去", () => {
    expect(closingText(task({ state: "failed", name: "b", err: "对方拒绝了这次传输" }))).toBe(
      "b 失败：对方拒绝了",
    );
  });
});

describe("waitingHint", () => {
  it("前 30s 说事实，之后补「对方可能没看到」", () => {
    const t = task({ state: "awaiting", started_ms: 1_000 });
    expect(waitingHint(t, 5_000)).toBe("已发出请求，等待对方确认…");
    expect(waitingHint(t, 1_000 + ASK_LATE_MS)).toBe("对方可能没看到，继续等待中");
  });

  it("非等待态不给提示（别在传输中说「等待确认」）", () => {
    expect(waitingHint(task({ state: "transferring" }), 999_999)).toBe("");
    expect(waitingHint(task({ state: "done" }), 999_999)).toBe("");
  });
});

describe("classifyErr", () => {
  it("版本不支持必须单独一档（不能塌缩成「连接失败」）", () => {
    const e = classifyErr("[file_unsupported] 对方没有响应文件通道：timeout");
    expect(e.upgrade).toBe(true);
    expect(e.title).toContain("旧版本");
    expect(e.tip).not.toBe("");
  });

  it("设备号不合法走另一档，不算升级问题", () => {
    expect(classifyErr("[bad_node_id] node_id 解不开").upgrade).toBe(false);
  });

  it("关键词分档：超时 / 拒绝 / 上限 / 文件名", () => {
    expect(classifyErr("等对端数据超时").title).toBe("等待超时");
    expect(classifyErr("对方拒绝了这次传输").title).toBe("对方拒绝了");
    expect(classifyErr("文件超过上限").title).toBe("文件超过上限");
    expect(classifyErr("文件名不能用").title).toBe("文件名无法使用");
  });

  it("空原因有兜底，机器标记不泄漏到界面", () => {
    expect(classifyErr("").title).toBe("失败（无原因）");
    expect(classifyErr(undefined).title).toBe("失败（无原因）");
    expect(classifyErr("[file_stall] 传输中无进展").title).toBe("传输中无进展");
  });
});

describe("askPrompt", () => {
  it("push 与 pull 的按钮含义不同，绝不共用文案", () => {
    const push = askPrompt(ask({ kind: "push" }));
    const pull = askPrompt(ask({ kind: "pull", name: "", size: 0 }));
    expect(push.accept).toBe("选择保存位置");
    expect(pull.accept).toBe("去选择文件");
    expect(push.lead).toContain("未查看你的屏幕");
    expect(pull.lead).toContain("未查看你的屏幕");
    expect(push.lead).not.toBe(pull.lead);
  });

  it("pull 时不报文件名/大小（选完才知道）", () => {
    const pull = askPrompt(ask({ kind: "pull", name: "", size: 0 }));
    expect(pull.title).toContain("请求你发送文件");
    expect(pull.lead).not.toContain("（0 B）");
  });

  it("对端名字为空时用「对方」，不显示空括号", () => {
    expect(askPrompt(ask({ peer_name: "" })).title).toBe("对方 想给你发送文件");
  });
});

describe("askCountdown", () => {
  it("按 60s 倒数，超 30s 标记 late", () => {
    const a = ask({ first_seen_ms: 0 });
    expect(askCountdown(a, 0)).toEqual({ remainSec: 60, late: false });
    expect(askCountdown(a, 30_000)).toEqual({ remainSec: 30, late: true });
    expect(askCountdown(a, ASK_LATE_MS).late).toBe(true);
    expect(askCountdown(a, ASK_TIMEOUT_MS).remainSec).toBe(0);
  });

  it("时间倒流（时钟回拨）不会给出负数", () => {
    expect(askCountdown(ask({ first_seen_ms: 5_000 }), 1_000).remainSec).toBe(60);
  });
});

describe("RateTracker", () => {
  it("第一拍没有基准，速率为 0（不编造）", () => {
    const rt = new RateTracker();
    const rate = rt.feed([task({ id: "a", done: 100 })], 1_000);
    expect(rate(task({ id: "a" }))).toBe(0);
  });

  it("第二拍算出瞬时速率，第三拍走 EMA 收敛", () => {
    const rt = new RateTracker();
    rt.feed([task({ id: "a", done: 0 })], 0);
    let rate = rt.feed([task({ id: "a", done: 1024 })], 1000);
    expect(rate(task({ id: "a" }))).toBeCloseTo(1024, 5);
    // 再来一拍同样速率 → EMA 仍等于瞬时值
    rate = rt.feed([task({ id: "a", done: 2048 })], 2000);
    expect(rate(task({ id: "a" }))).toBeCloseTo(1024, 5);
  });

  it("超过半秒没有新字节 → 速率归零，不留旧数字骗人", () => {
    const rt = new RateTracker();
    rt.feed([task({ id: "a", done: 0 })], 0);
    rt.feed([task({ id: "a", done: 1024 * 1024 })], 1000);
    const rate = rt.feed([task({ id: "a", done: 1024 * 1024 })], 3000);
    expect(rate(task({ id: "a" }))).toBe(0);
  });

  it("任务从快照里消失即丢（不会串到同 id 的新任务上）", () => {
    const rt = new RateTracker();
    rt.feed([task({ id: "a", done: 0 })], 0);
    rt.feed([task({ id: "a", done: 999 })], 1000);
    const rate = rt.feed([], 2000);
    expect(rate(task({ id: "a" }))).toBe(0);
  });
});
