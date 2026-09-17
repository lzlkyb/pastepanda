/** 会话 HUD 用的轻量统计：fps 滑动窗、RTT、画质档文案。 */

export type FitMode = "fit" | "actual" | "fill";

export function qualityLabel(q: string): string {
  if (q === "uhd") return "原生";
  if (q === "ultra") return "超清";
  if (q === "sharp") return "清晰";
  if (q === "smooth") return "流畅";
  return "均衡";
}

export function scopeLabel(s: string): string {
  if (s === "primary") return "主屏";
  if (s.startsWith("monitor:")) {
    const n = Number(s.slice(8));
    return Number.isFinite(n) ? `屏${n + 1}` : "指定屏";
  }
  return "整屏";
}

/**
 * 通知用的完整范围文案（B3）。
 * 与 HUD 用的短文案 `scopeLabel` 分开：HUD 位置窄、要短；给被控端的提示
 * 说的是一次**隐私相关**的变更，必须把「含副屏」这类信息说全。
 */
export function scopeLabelLong(s: string): string {
  if (s === "primary") return "仅主屏";
  if (s.startsWith("monitor:")) {
    const n = Number(s.slice(8));
    return Number.isFinite(n) ? `第 ${n + 1} 台显示器` : "指定显示器";
  }
  return "整个虚拟屏（含副屏）";
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function formatWhen(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return `今天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/**
 * 画面「静」与链路「断」是两个问题，各有各的判据（2026-09-17 改造）。
 *
 * 🔴 旧实现拿「2.5s 没有新帧」当链路故障，是错的：被控端在画面无变化时
 *    **刻意不推帧**（`rc/video.rs` 的 `DirtyOutcome::Static` → `inbound.rs`
 *    里 `jpeg.is_empty()` 直接 Sleep）。于是看一屏静止桌面 2.5s 后，
 *    顶栏报「画面已停滞」、HUD 报「心跳超时」，而链路完全健康——必然误报。
 *
 * 现在的分工：
 * - **帧到达时间**只答「画面多久没变了」，中性观测，不报警（`frameIdleMs`）。
 * - **对端 pong 的新鲜度**才答「链路还活着吗」（`linkStateOf`）。
 * - 只有「我操作了、但操作之后一直没有新帧」才是真问题（`actionUnansweredMs`）。
 */
export const FRAME_IDLE_MS = 2500;

/**
 * 「有后果的操作」之后多久还没画面变化 = 该提示。
 * 只算点击/按键/滚轮：移动鼠标划过画面属于查看行为，对端本来就不该有反应。
 */
export const ACTION_UNANSWERED_MS = 1500;

/** 心跳新鲜度：pong 超过这么久没回来算「陈旧」（ping 每秒一发）。 */
export const HEARTBEAT_STALE_MS = 3500;
/** 陈旧到这个程度仍未恢复 = 判定链路断了，不再是「可能自愈」。 */
export const HEARTBEAT_FAIL_MS = 12000;

/** RTT 分档阈值（ms）。参考 Parsec 的口径：<30 好，<60 对多数人可接受。 */
export const RTT_GOOD_MS = 30;
export const RTT_OK_MS = 60;
export const RTT_FAIR_MS = 200;

export type RttGrade = "good" | "ok" | "fair" | "poor" | "unknown";

export function rttGrade(rttMs: number): RttGrade {
  if (!(rttMs > 0)) return "unknown";
  if (rttMs < RTT_GOOD_MS) return "good";
  if (rttMs < RTT_OK_MS) return "ok";
  if (rttMs < RTT_FAIR_MS) return "fair";
  return "poor";
}

export function rttGradeLabel(g: RttGrade): string {
  switch (g) {
    case "good":
      return "很流畅";
    case "ok":
      return "流畅";
    case "fair":
      return "一般";
    case "poor":
      return "偏慢";
    default:
      return "测速中";
  }
}

/**
 * 会话链路状态。刻意对齐 WebRTC 的状态语义（2026-09-17 对标）：
 *
 * - `unstable` = 曾经连上、心跳暂时陈旧。**这不是错误**，ICE 层的
 *   `connected → disconnected → connected` 抖动通常无害且会自愈，
 *   所以 UI 说「连接不稳，正在恢复」，不给红色、不给重连按钮。
 * - `failed` = 陈旧到超过 `HEARTBEAT_FAIL_MS` 仍未恢复，才允许提示重连。
 */
export type RcLinkState = "connecting" | "connected" | "unstable" | "reconnecting" | "failed";

/**
 * 由「最后一次 pong 的时间」推链路状态。
 *
 * @param lastPongMs 最后一次收到对端 pong 的时间戳；0 = 还没收到过（刚连上）
 * @param now 当前时间戳
 * @param reconnecting 正在执行重连动作（由调用方传入，优先级最高之外）
 */
export function linkStateOf(
  lastPongMs: number,
  now: number,
  reconnecting = false,
): RcLinkState {
  if (reconnecting) return "reconnecting";
  if (lastPongMs <= 0) return "connecting";
  const age = now - lastPongMs;
  if (age < HEARTBEAT_STALE_MS) return "connected";
  if (age < HEARTBEAT_FAIL_MS) return "unstable";
  return "failed";
}

export function linkStateLabel(s: RcLinkState): string {
  switch (s) {
    case "connected":
      return "已连接";
    case "unstable":
      return "连接不稳";
    case "reconnecting":
      return "重连中";
    case "failed":
      return "连接已断开";
    default:
      return "连接中";
  }
}

/** 「连接不稳」的补充说明——必须带「可能自愈」，否则用户会当失败去关窗口。 */
export function linkStateHint(s: RcLinkState): string {
  switch (s) {
    case "unstable":
      return "网络抖动，正在等待恢复";
    case "failed":
      return "可尝试重连，或检查双方网络";
    default:
      return "";
  }
}

/**
 * 链路走的哪条路（与 Rust `PathKind::label` 同构）。
 * 空串 = 未知/未测到，此时不显示这一格，不猜。
 */
export function pathKindLabel(k: string | undefined): string {
  if (k === "lan") return "局域网直连";
  if (k === "direct") return "公网直连";
  if (k === "relay") return "绕中继";
  return "";
}

/**
 * 绕中继时的一句解释。用户看到「延迟 45ms」无从判断该不该去查网络，
 * 这句话把疑问变成解释（AnyDesk / RustDesk 同位置给的是 Direct/Relay 指示器）。
 */
export function pathKindHint(k: string | undefined): string {
  if (k === "relay") return "中继转发，延迟高于直连属正常";
  if (k === "direct") return "已打洞成功，不经中继";
  if (k === "lan") return "同一局域网，延迟最低";
  return "";
}

/**
 * 画面静止时长（中性观测）。0 = 不显示。
 *
 * 🔴 它与 `linkStateOf` 是两个独立判据，刻意不互相喂数据：
 *    「画面没变化」永远不能推出「链路有问题」。这条分工是整个改造的核心，
 *    删掉任何一个函数都等于把 2026-09-17 的误报重新引回来。
 */
export function frameIdleMs(lastFrameAt: number, now: number, hasFrame: boolean): number {
  if (!hasFrame || lastFrameAt <= 0) return 0;
  const idle = now - lastFrameAt;
  return idle >= FRAME_IDLE_MS ? idle : 0;
}

/**
 * 「我操作了，但操作之后一直没画面」的等待时长。0 = 不该提示。
 *
 * 只算有后果的操作（调用方保证：点击 / 按键 / 滚轮，不含鼠标移动划过）。
 * 不变量（三条，缺一即误报）：
 * 1. 没操作过 → 0。用户只是在看静止画面，不是故障。
 * 2. `lastFrameAt >= lastActionAt` → 0。操作之后已经收到过新帧 = 对端响应了。
 * 3. 未满 `ACTION_UNANSWERED_MS` → 0。编解码+网络本就需要时间。
 */
export function actionUnansweredMs(
  lastFrameAt: number,
  lastActionAt: number,
  now: number,
): number {
  if (lastActionAt <= 0) return 0;
  if (lastFrameAt >= lastActionAt) return 0;
  const waited = now - lastActionAt;
  return waited >= ACTION_UNANSWERED_MS ? waited : 0;
}

/** 固定长度滑动窗，算最近 fps。 */
export class FpsMeter {
  private times: number[] = [];
  push(now = performance.now()) {
    this.times.push(now);
    if (this.times.length > 30) this.times.shift();
  }
  fps(): number {
    if (this.times.length < 2) return 0;
    const span = this.times[this.times.length - 1] - this.times[0];
    if (span <= 0) return 0;
    return Math.round(((this.times.length - 1) / span) * 1000);
  }
  reset() {
    this.times = [];
  }
}
