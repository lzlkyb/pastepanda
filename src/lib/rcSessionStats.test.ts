import { describe, expect, it } from "vitest";
import {
  actionUnansweredMs,
  frameIdleMs,
  linkStateHint,
  linkStateOf,
  pathKindHint,
  pathKindLabel,
  rttGrade,
  FrameStats,
  RenderDelayBuffer,
  ACTION_UNANSWERED_MS,
  HEARTBEAT_FAIL_MS,
  HEARTBEAT_STALE_MS,
} from "@/lib/rcSessionStats";

const T = 1_000_000; // 任意固定时刻，避免测试受真实时钟影响

describe("linkStateOf（链路活性：只认对端 pong 的新鲜度）", () => {
  it("还没收到过 pong → 连接中", () => {
    expect(linkStateOf(0, T)).toBe("connecting");
  });

  it("pong 新鲜 → 已连接", () => {
    expect(linkStateOf(T - 1, T)).toBe("connected");
    expect(linkStateOf(T - (HEARTBEAT_STALE_MS - 1), T)).toBe("connected");
  });

  it("🔴 pong 陈旧但未超上限 → unstable，而不是 failed", () => {
    // 这是对标 WebRTC 的关键一条：disconnected 是临时态，会自愈，不该报错。
    expect(linkStateOf(T - HEARTBEAT_STALE_MS, T)).toBe("unstable");
    expect(linkStateOf(T - (HEARTBEAT_FAIL_MS - 1), T)).toBe("unstable");
  });

  it("陈旧超过上限 → failed", () => {
    expect(linkStateOf(T - HEARTBEAT_FAIL_MS, T)).toBe("failed");
  });

  it("重连动作进行中优先显示重连中", () => {
    expect(linkStateOf(T - 1, T, true)).toBe("reconnecting");
    // 即便心跳看起来是断的，也要显示「重连中」而不是「已断开」
    expect(linkStateOf(T - HEARTBEAT_FAIL_MS * 2, T, true)).toBe("reconnecting");
  });

  it("unstable 必须带「可能自愈」口径，failed 才给重连指引", () => {
    expect(linkStateHint("unstable")).toContain("恢复");
    expect(linkStateHint("connected")).toBe("");
  });
});

describe("frameIdleMs（画面静：中性观测，不是故障）", () => {
  it("没有帧 / 时间为 0 → 不显示", () => {
    expect(frameIdleMs(T - 99999, T, false)).toBe(0);
    expect(frameIdleMs(0, T, true)).toBe(0);
  });

  it("未超过阈值 → 不显示（避免每次眨眼都冒提示）", () => {
    expect(frameIdleMs(T - 1000, T, true)).toBe(0);
  });

  it("超过阈值 → 返回静止时长", () => {
    expect(frameIdleMs(T - 9000, T, true)).toBe(9000);
  });

  it("🔴 回归钉子：画面静止不改变链路判定", () => {
    // 2026-09-17 的误报根因：被控端画面无变化时刻意不推帧，
    // 旧实现把「2.5s 无新帧」当链路故障 ⇒ 看静止桌面 2.5s 必报错。
    // 下面两行必须同时成立：帧静止为真，链路仍为「已连接」。
    expect(frameIdleMs(T - 60_000, T, true)).toBeGreaterThan(0);
    expect(linkStateOf(T - 1000, T)).toBe("connected");
  });
});

describe("actionUnansweredMs（有后果的操作之后没画面）", () => {
  it("没操作过 → 不提示（用户只是在看静止画面）", () => {
    expect(actionUnansweredMs(T - 60_000, 0, T)).toBe(0);
  });

  it("操作之后收到过新帧 → 对端已响应，不提示", () => {
    expect(actionUnansweredMs(T - 200, T - 1000, T)).toBe(0);
  });

  it("操作后一直没帧且超过阈值 → 提示，并给出等待时长", () => {
    const waited = actionUnansweredMs(T - 10_000, T - 9_000, T);
    expect(waited).toBe(9_000);
  });

  it("未满阈值 → 不提示（编解码+网络本就需要时间）", () => {
    expect(actionUnansweredMs(T - 60_000, T - (ACTION_UNANSWERED_MS - 1), T)).toBe(0);
  });

  it("帧时间戳为 0（首帧都没到）时仍能判出未响应", () => {
    expect(actionUnansweredMs(0, T - 9_000, T)).toBe(9_000);
  });
});

describe("rttGrade（分档阈值）", () => {
  it("0 / 负数 = 尚未测到，不能当成「很快」", () => {
    expect(rttGrade(0)).toBe("unknown");
    expect(rttGrade(-5)).toBe("unknown");
  });

  it("边界值按「上界不含」分档", () => {
    expect(rttGrade(29)).toBe("good");
    expect(rttGrade(30)).toBe("ok");
    expect(rttGrade(59)).toBe("ok");
    expect(rttGrade(60)).toBe("fair");
    expect(rttGrade(199)).toBe("fair");
    expect(rttGrade(200)).toBe("poor");
  });
});

describe("pathKindLabel / pathKindHint（走哪条路）", () => {
  it("三档文案与 Rust PathKind::label 同构", () => {
    expect(pathKindLabel("lan")).toBe("局域网直连");
    expect(pathKindLabel("direct")).toBe("公网直连");
    expect(pathKindLabel("relay")).toBe("绕中继");
  });

  it("未知 / 空串 → 空文案，界面不显示这一格（不猜）", () => {
    expect(pathKindLabel("")).toBe("");
    expect(pathKindLabel(undefined)).toBe("");
    expect(pathKindLabel("custom")).toBe("");
  });

  it("绕中继必须给解释：延迟高≠故障", () => {
    expect(pathKindHint("relay")).toContain("正常");
    expect(pathKindHint("")).toBe("");
  });
});

describe("FrameStats（帧遥测 EMA，2026-09-22 自 useRcFrames 拆出）", () => {
  it("noteLatency：age 越界（<0 / >10s）的帧不算", () => {
    const st = new FrameStats();
    const now = Date.now();
    expect(st.noteLatency(now + 500, 0, 0, 0)).toBe(false); // age<0：时钟没校准
    expect(st.noteLatency(now - 11_000, 0, 0, 0)).toBe(false); // 停顿后的一帧
    expect(st.latencyMs).toBe(0);
  });

  it("EMA 系数 α=1/8：首个样本直取，其后按 7/8 混合", () => {
    const st = new FrameStats();
    // 🔴 0 是「无样本」哨兵：age≈0 的首样本存进去仍读作 0（原实现语义，
    // 类忠实保留）——所以 EMA 行为必须用非零首样本考察。
    st.noteLatency(Date.now() - 100, 0, 0, 0); // age ≈ 100+ε → 首样本直取
    expect(st.latencyMs).toBeGreaterThanOrEqual(100);
    expect(st.latencyMs).toBeLessThanOrEqual(101);
    st.noteLatency(Date.now() - 1000, 0, 0, 0); // (100*7+1000+ε)/8 ≈ 212.5
    expect(st.latencyMs).toBeGreaterThanOrEqual(212);
    expect(st.latencyMs).toBeLessThanOrEqual(214);
  });

  it("网络段 = 总龄 − 采集 − 编码 − 解码，负值 clamp 到 0", () => {
    const st = new FrameStats();
    st.noteDecode(30); // dec EMA = 30（先于 noteLatency，net 段要减它）
    // age ≈ 100+ε → net = age-40-20-30 ≈ 10+ε（容忍真实时钟的毫秒差）
    st.noteLatency(Date.now() - 100, 40, 20, 0);
    expect(st.netMs).toBeGreaterThanOrEqual(10);
    expect(st.netMs).toBeLessThan(25);
    const st2 = new FrameStats();
    st2.noteLatency(Date.now() - 50, 90, 20, 0); // 50-90-20 < 0 → 0
    expect(st2.netMs).toBe(0);
  });

  it("码率：1s 窗口闭合才出数，EMA 首样本直取", () => {
    const st = new FrameStats();
    expect(st.noteBytes(1000)).toBeNull(); // 窗口未满
    // 把窗口起点拨回 1001ms 前：绕开真实时钟等待
    (st as unknown as { windowStart: number }).windowStart -= 1001;
    const kbps = st.noteBytes(1_000_000);
    // (1000 + 1_000_000) * 8 / ~1001ms ≈ 7999 kbps
    expect(kbps).not.toBeNull();
    expect(kbps!).toBeGreaterThan(7000);
  });

  it("noteResponse：只统计 0<d≤500 的样本", () => {
    const st = new FrameStats();
    expect(st.noteResponse(Date.now() - 600)).toBe(false); // 太久 = 没在等
    expect(st.noteResponse(Date.now() + 50)).toBe(false); // 未来时刻
    expect(st.noteResponse(Date.now() - 120)).toBe(true);
    expect(st.respMs).toBeGreaterThanOrEqual(119); // d = 120±1ms
    expect(st.respMs).toBeLessThanOrEqual(121);
  });

  it("reset 后全部归零", () => {
    const st = new FrameStats();
    st.noteLatency(Date.now() - 100, 40, 20, 0);
    st.reset();
    expect(st.latencyMs).toBe(0);
    expect(st.netMs).toBe(0);
  });
});

describe("RenderDelayBuffer（P1-8 微抖动缓冲）", () => {
  it("样本不足 4 个 → 0（LAN 平稳不垫缓冲）", () => {
    const jb = new RenderDelayBuffer();
    let t = 1_000_000;
    for (let i = 0; i < 3; i++) {
      t += 20;
      expect(jb.next(t)).toBe(0);
    }
  });

  it("平稳 gap（20ms）→ target=0，即便凑够样本也不垫", () => {
    const jb = new RenderDelayBuffer();
    let t = 1_000_000;
    for (let i = 0; i < 10; i++) {
      t += 20;
      jb.next(t);
    }
    expect(jb.next(t + 20)).toBe(0); // max≈avg → target=0
  });

  it("抖动样本（gap 忽大忽小）→ 垫 (max−avg)/2，封顶 60ms", () => {
    const jb = new RenderDelayBuffer();
    let t = 1_000_000;
    const gaps = [20, 20, 100, 20]; // max=100 avg=40 → target=30
    for (const g of gaps) {
      t += g;
      jb.next(t);
    }
    // ema = 0*0.7 + 30*0.3 = 9 > 5
    expect(jb.next(t + 20)).toBe(9);
  });

  it(">250ms 的 gap 是空闲退避不是抖动：清空样本重来", () => {
    const jb = new RenderDelayBuffer();
    let t = 1_000_000;
    for (const g of [20, 20, 100, 20]) {
      t += g;
      jb.next(t);
    }
    t += 400; // 空闲退避拉出来的大 gap
    jb.next(t);
    expect(jb.next(t + 20)).toBe(0); // 样本已清空，不足 4 个
  });
});
