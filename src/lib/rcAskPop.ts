/**
 * 丙-①（2026-09-30）：入站申请置顶浮层的**纯判断**（措辞 + 超时算式）。
 *
 * 独立成文件是 AGENTS.md §11.1 的口径：浮层（`RcAskPop`）与主窗那条确认条
 * （`RcJoinRequests`）说的是同一件事，措辞必须只有一个出处；算式（120s 窗、
 * 剩余时间）也必须和后端 `inbound.rs` 的 `deadline` 同源，才能不出现
 * 「UI 还剩 3 秒、后端已经拒了」。
 *
 * 🔴 后端只出 `code`（`confirm_timeout` / `pending_full`），整句中文在这里——
 * 与跨端 deny reason 同一套「后端出码、前端出话」纪律（见 rcHistory 的先例）。
 */

/** 与 `service/inbound.rs` 的 `120_000` 同值；改那边必须改这里（下方守卫单测钉着）。 */
export const RC_ASK_TTL_MS = 120_000;

/** 剩余毫秒（不为负；后端还没拒但 UI 先到 0 时按 0 显示）。 */
export function rcAskLeftMs(firstSeenMs: number, nowMs: number): number {
  return Math.max(0, RC_ASK_TTL_MS - (nowMs - firstSeenMs));
}

/** `1:47` 口径：不写「秒」字，不补零成三段。 */
export function rcAskCountdownText(leftMs: number): string {
  const total = Math.ceil(leftMs / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 申请文案里的能力档：对标 Quick Assist / RustDesk 的「先看，再控」口径。 */
export function rcAskGrantText(cap: "view" | "control"): string {
  return cap === "control" ? "看屏幕 + 控制键鼠" : "只看屏幕";
}

/**
 * 是否摆「只同意看屏幕」这一档。
 *
 * 对方申请**可控**时才有意义（申请只看，再给一个"只看"按钮是重复）。
 * 后端 `approve_inbound_as` 只做降级不做升级，所以这里少摆一个按钮也不会
 * 造成越权——反过来说，按钮摆出来就一定真降得下来。
 */
export function rcAskOfferViewOnly(cap: "view" | "control"): boolean {
  return cap === "control";
}

/** 后端出的码 → 主机看到的一句话（未知码返回 null，不编造原因）。 */
export function rcAskNoteText(code: string | undefined | null): string | null {
  switch (code) {
    case "confirm_timeout":
      return "上一条申请没人应答，已自动拒绝并告诉对方原因";
    case "pending_full":
      return "待确认列表已满，最早那条申请已丢弃并告诉对方原因";
    default:
      return null;
  }
}

/** 免确认设备不会出现本条（待拍板③）；这句常驻提示给普通设备。 */
export const RC_ASK_HINT = "超时会自动拒绝并告诉对方原因 · 已免确认的设备不会出现本条，改由常驻角标告知";
