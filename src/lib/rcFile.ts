/**
 * 远程电脑 · 文件传输的前端纯逻辑（G6，B4）。
 *
 * 这一层**不碰 React、不碰 invoke**——只做「快照 → 界面要的字」的换算，
 * 所以全部可单测。理由与 `rc/audio.rs` 拆出判据同源：进度/速率/倒计时/文案
 * 这些最容易写错、又最难在真机上复现的决定，要让测试直接钉住。
 *
 * # 与 `imageFormat.formatBytes` 的关系（2026-09-22 起失效）
 *
 * 曾因「MB 封顶 + 0 返回 —」两处口径不合而各持一份；现已统一收口到
 * `lib/utils.ts` 的 `formatBytes`（B/KB/MB/GB，0 → `"0 B"`，非法 → `"—"`），
 * 两个模块都 re-export 它。0 字节与「还没开始」的区分交给**调用方**的
 * null/未开始状态，不再由格式化函数代劳。
 */
import type { RcFileAsk, RcFileSnapshot, RcFileTask, RcFileTaskState } from "@/lib/api/rcFile";

/** 确认条超时，与后端 `file_state::ASK_TIMEOUT_MS` **必须一致**（两端同倒计时）。 */
export const ASK_TIMEOUT_MS = 60_000;
/** 超过这个时长仍未响应时补一句「对方可能没看到」——避免用户误判卡死。 */
export const ASK_LATE_MS = 30_000;

export function isTerminal(s: RcFileTaskState): boolean {
  return s === "done" || s === "denied" || s === "failed" || s === "canceled";
}

/**
 * 要不要给这一行「打开所在文件夹」。
 *
 * 判据是**终态 + 后端给了绝对路径**，不是「成功」。失败/取消也有价值：
 * 收侧中断时留下的是 `.pppart`（就在同一个目录），用户去找它才能明白发生了什么；
 * 发侧则是去找原件。反而 `denied` 之类后端根本没路径的，自然不摆这个按钮。
 */
export function canOpenPath(t: RcFileTask): boolean {
  return isTerminal(t.state) && typeof t.path === "string" && t.path.length > 0;
}

/**
 * 防御式解析事件载荷。
 *
 * 载荷来自后端 `FileSnapshot` 的序列化，理论上形状固定；但事件是**跨进程序列化**
 * 的边界，历史版本/半截 payload 都不该让整条 UI 崩掉——读不出就当空快照。
 */
export function parseFileSnapshot(raw: unknown): RcFileSnapshot {
  const empty: RcFileSnapshot = { asks: [], tasks: [] };
  if (raw == null || typeof raw !== "object") return empty;
  const o = raw as Record<string, unknown>;
  return {
    asks: Array.isArray(o.asks) ? o.asks.filter(isAskLike) : [],
    tasks: Array.isArray(o.tasks) ? o.tasks.filter(isTaskLike) : [],
  };
}

function isAskLike(v: unknown): v is RcFileAsk {
  if (v == null || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return typeof a.id === "string" && (a.kind === "push" || a.kind === "pull");
}

function isTaskLike(v: unknown): v is RcFileTask {
  if (v == null || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return typeof t.id === "string" && typeof t.size === "number" && typeof t.done === "number";
}

import { formatBytes, formatRate } from "@/lib/utils";

/**
 * 字节数 → 人类可读（B/KB/MB/GB）。0 是合法值（空文件），不是「无」。
 *
 * 实现**收口在 `lib/utils.ts`**（规则 11，2026-09-22）：本模块曾与
 * `imageFormat.ts` 各持一份同名实现、口径互不一致。这里 re-export 保持
 * 既有 import 路径（`@/lib/rcFile`）与测试锚点不变——新代码请直接从
 * `@/lib/utils` 引。
 */
export { formatBytes, formatRate };

/** 剩余时间 → `剩 12s` / `剩 3m` / `剩 1.2h`。 */
export function formatEta(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "即将完成";
  const s = ms / 1000;
  if (s < 1) return "剩 <1s";
  if (s < 60) return `剩 ${Math.round(s)}s`;
  if (s < 3600) return `剩 ${Math.round(s / 60)}m`;
  return `剩 ${(s / 3600).toFixed(1)}h`;
}

/** 已完成百分比（0..100 整数）。size 为 0（pull 尚未定文件）时按 0 算。 */
export function taskPercent(t: RcFileTask): number {
  if (t.size <= 0) return 0;
  return Math.min(100, Math.floor((t.done / t.size) * 100));
}

/** 进行中（未结束）的任务。 */
export function runningTasks(tasks: RcFileTask[]): RcFileTask[] {
  return tasks.filter((t) => !isTerminal(t.state));
}

/** 完成的任务数。 */
export function doneCount(tasks: RcFileTask[]): number {
  return tasks.filter((t) => t.state === "done").length;
}

/** 运行中优先，其余按开始时间倒序（新消息在上）。 */
export function sortTasks(tasks: RcFileTask[]): RcFileTask[] {
  return [...tasks].sort((a, b) => {
    const ra = isTerminal(a.state) ? 1 : 0;
    const rb = isTerminal(b.state) ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return b.started_ms - a.started_ms;
  });
}

/**
 * 底栏那一句汇总：`传文件中 3/5 · 42% · 6.2 MB/s · 剩 12s`。
 *
 * 没有任何运行中任务时返回 null（底栏就不占位）——**不返回「空闲」**，
 * 那是把「无事发生」也说出来占地方。
 */
export function barSummary(tasks: RcFileTask[], rateOf: (t: RcFileTask) => number): string | null {
  const run = runningTasks(tasks);
  if (run.length === 0) return null;
  const total = tasks.length;
  const idx = total - run.length + 1;
  // 多文件串行：进度按**当前这一条**算，整体百分比会把 5 个文件算成一个长条。
  // P2-7：优先真正 `transferring` 的（串行时它才是正在动的）；都没有 transferring
  // （只剩 awaiting 等确认）时取最早 `started_ms`，而不是数组末尾那条。
  const transferring = run.filter((t) => t.state === "transferring");
  const pool = transferring.length > 0 ? transferring : run;
  const cur = pool.reduce((a, b) => (a.started_ms <= b.started_ms ? a : b));
  const parts = [`传文件中 ${idx}/${total}`, `${taskPercent(cur)}%`];
  const rate = rateOf(cur);
  if (rate > 0) {
    parts.push(formatRate(rate));
    const left = cur.size - cur.done;
    if (left > 0) parts.push(formatEta((left / rate) * 1000));
  }
  return parts.join(" · ");
}

/** 单行任务状态文案（进度列表用）。 */
export function taskLine(t: RcFileTask, rate: number): string {
  const arrow = t.dir === "send" ? "发送" : "接收";
  switch (t.state) {
    case "awaiting":
      return t.dir === "send" ? "等待对方确认…" : "等待你选择文件…";
    case "transferring": {
      const parts = [`${arrow}中 ${taskPercent(t)}%`];
      if (rate > 0) {
        parts.push(formatRate(rate));
        const left = t.size - t.done;
        if (left > 0) parts.push(formatEta((left / rate) * 1000));
      }
      return parts.join(" · ");
    }
    case "done":
      return `${arrow}完成 · ${formatBytes(t.done)}`;
    case "denied":
      return "对方拒绝了";
    case "canceled":
      return "已取消（保留断点，可续传）";
    case "failed":
      return classifyErr(t.err).title;
  }
}

/**
 * 结束态的一句总结。返回 null = 还在跑（调用方不展示）。
 *
 * 完成/失败文案按**方向**分：收侧说「已收到」，发侧说「已送达」。
 */
export function closingText(t: RcFileTask): string | null {
  if (!isTerminal(t.state)) return null;
  if (t.state === "done") {
    return t.dir === "recv"
      ? `已收到 ${t.name}（${formatBytes(t.done)}）`
      : `已送达 ${t.name}（${formatBytes(t.done)}）`;
  }
  if (t.state === "denied") return `对方拒绝了 ${t.name}`;
  if (t.state === "canceled") return `已取消 ${t.name}`;
  return `${t.name} 失败：${classifyErr(t.err).title}`;
}

/**
 * 发起侧「等对方确认」的补充提示。
 *
 * 前半段给一个确定的事实，超过 30s 后补一句「对方可能没看到」——不然用户会
 * 把「对方在犹豫」误判成「卡死了」（§11.6）。非 awaiting 状态返回空串。
 */
export function waitingHint(t: RcFileTask, nowMs: number): string {
  if (t.state !== "awaiting") return "";
  return nowMs - t.started_ms >= ASK_LATE_MS
    ? "对方可能没看到，继续等待中"
    : "已发出请求，等待对方确认…";
}

/** 错误分档。 */
export interface ErrInfo {
  /** 一句话标题（能直接作为失败原因展示）。 */
  title: string;
  /** 补一句可操作的提示；无则空串。 */
  tip: string;
  /** 是否属于「对方版本太旧」——这类必须**单独一档**，不能塌缩成「连接失败」。 */
  upgrade: boolean;
}

/**
 * 把后端 `err` 字符串分档。
 *
 * 后端在少数场合会带机器可读的方括号标记（`[file_unsupported]` / `[bad_node_id]`），
 * 其余是人话。这里先认标记、再回退到关键词——**不做版本号比对**（决策 5：
 * 版本号会腐化，泛化为「连不上就提示升级」）。
 */
export function classifyErr(err?: string | null): ErrInfo {
  const s = (err ?? "").trim();
  if (s.includes("[file_unsupported]")) {
    return {
      title: "对方可能是不支持文件传输的旧版本",
      tip: "请对方升级 PastePanda 后再试；这不影响画面与控制。",
      upgrade: true,
    };
  }
  if (s.includes("[bad_node_id]")) {
    return { title: "对方设备号不合法", tip: "请重新从设备列表发起。", upgrade: false };
  }
  if (/超时|timeout/i.test(s)) {
    return { title: "等待超时", tip: "对方可能没看到确认条，可再试一次。", upgrade: false };
  }
  if (/拒绝|denied/i.test(s)) return { title: "对方拒绝了", tip: "", upgrade: false };
  if (/取消|cancel/i.test(s)) return { title: "已取消", tip: "", upgrade: false };
  if (/上限|太大|size_limit/i.test(s)) {
    return { title: "文件超过上限", tip: "单个文件上限 8 GB。", upgrade: false };
  }
  if (/文件名|bad_name/i.test(s)) {
    return { title: "文件名无法使用", tip: "换一个不含特殊字符的名字。", upgrade: false };
  }
  if (!s) return { title: "失败（无原因）", tip: "", upgrade: false };
  // 去掉机器标记再给人看，避免界面里出现 `[xxx]`
  return { title: s.replace(/\[[a-z_]+\]\s*/g, ""), tip: "", upgrade: false };
}

/** 确认条的文案（两个方向的按钮含义**完全不同**，绝不共用同一句）。 */
export interface AskPrompt {
  /** 标题：谁 + 要干什么。 */
  title: string;
  /** 一句补充：说明对方有没有在看屏、以及按钮会做什么。 */
  lead: string;
  /** 主按钮（选路径/选文件）。 */
  accept: string;
  /** 次按钮。 */
  deny: string;
}

export function askPrompt(ask: RcFileAsk): AskPrompt {
  const who = ask.peer_name || "对方";
  if (ask.kind === "push") {
    return {
      title: `${who} 想给你发送文件`,
      lead: `对方请求传文件（未查看你的屏幕）。接受后选择保存位置，文件为「${ask.name}」（${formatBytes(ask.size)}）。`,
      accept: "选择保存位置",
      deny: "拒绝",
    };
  }
  return {
    title: `${who} 请求你发送文件`,
    lead: "对方请求传文件（未查看你的屏幕）。接受后去选择要发送的文件；在你选完之前不会有任何文件离开本机。",
    accept: "去选择文件",
    deny: "拒绝",
  };
}

/** 确认条倒计时。`late` = 已超过 ASK_LATE_MS，调用方补一句「对方可能没看到」。 */
export function askCountdown(
  ask: RcFileAsk,
  nowMs: number,
): { remainSec: number; late: boolean } {
  const elapsed = Math.max(0, nowMs - ask.first_seen_ms);
  const remain = Math.max(0, ASK_TIMEOUT_MS - elapsed);
  return { remainSec: Math.ceil(remain / 1000), late: elapsed >= ASK_LATE_MS };
}

/**
 * 逐任务速率估算（EMA）。
 *
 * 后端已经按 ≤10Hz 节流，但节流是「最快」，静止时可能几秒才来一拍——
 * 所以速率必须用**事件里的时间戳**算，不能用「上一拍到现在」的心跳。
 * 每条任务独立计，任务消失即丢。
 */
export class RateTracker {
  private last = new Map<string, { done: number; at: number; rate: number }>();

  /** 喂一份快照，返回「取某条任务速率」的函数（同步、幂等）。 */
  feed(tasks: RcFileTask[], nowMs: number): (t: RcFileTask) => number {
    const seen = new Set<string>();
    for (const t of tasks) {
      seen.add(t.id);
      const prev = this.last.get(t.id);
      if (!prev) {
        this.last.set(t.id, { done: t.done, at: nowMs, rate: 0 });
        continue;
      }
      const dt = (nowMs - prev.at) / 1000;
      const db = t.done - prev.done;
      if (dt > 0 && db > 0) {
        const inst = db / dt;
        // EMA(0.4)：单拍抖动不至于让数字乱跳，又跟得上真实速率变化
        const rate = prev.rate > 0 ? prev.rate * 0.6 + inst * 0.4 : inst;
        this.last.set(t.id, { done: t.done, at: nowMs, rate });
      } else if (dt > 0.5) {
        // 半秒以上没有新字节 = 卡住了，速率归零（别留着旧数字骗人）
        this.last.set(t.id, { done: t.done, at: nowMs, rate: 0 });
      }
    }
    for (const id of [...this.last.keys()]) if (!seen.has(id)) this.last.delete(id);
    return (t) => this.last.get(t.id)?.rate ?? 0;
  }

  reset() {
    this.last.clear();
  }
}
