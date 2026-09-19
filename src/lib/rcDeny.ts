/** RC 远程错误分档：稳定 code → 标题 + 下一步提示。 */

export type RcErrorKind =
  | "disabled"
  | "device_denied"
  | "not_paired"
  | "capability"
  | "busy"
  | "timeout"
  | "offline"
  | "other";

export interface RcErrorInfo {
  title: string;
  hint: string;
  kind: RcErrorKind;
  reason: string;
}

const BY_CODE: Record<string, Omit<RcErrorInfo, "reason">> = {
  disabled: {
    title: "对方未开启「允许被远程协助」",
    hint: "请对方打开：设置 → 远程电脑 → 允许被远程协助。",
    kind: "disabled",
  },
  device_denied: {
    title: "对方已禁止这台设备远程",
    hint: "请对方在远程设备列表里解除对你的禁止。",
    kind: "device_denied",
  },
  not_paired: {
    title: "尚未远程配对",
    hint: "先完成远程配对（与知识库同步配对无关）。",
    kind: "not_paired",
  },
  // 🔴 「窗口过期」必须与「从未配对」分开（2026-09-17 拆）。
  //   后端原先把两者塌缩成同一句 `not_paired`，而用户实际撞到的**几乎总是窗口过期**——
  //   文案指不到「回去重新生成一个」这个唯一正确的动作，于是他只能反复重试同一个失效的码。
  //   按钮名照真实 UI 写（`RcPairCreatePane` 的「生成并复制」），别写成不存在的「重新生成」。
  invite_door_closed: {
    title: "对方的邀请窗口已过期",
    hint: "邀请码只在生成后 30 分钟内有效。请让对方重新走一次「生成并复制」，再把新的码发你。",
    kind: "not_paired",
  },
  pair_denied: {
    title: "对方拒绝过这次配对",
    hint: "对方此前点了拒绝，30 分钟内不会再弹确认。请让对方重新生成一份邀请码再试。",
    kind: "not_paired",
  },
  await_pair_confirm: {
    title: "等待对方确认配对",
    hint: "对方需在弹出的配对请求里核对指纹并允许。",
    kind: "not_paired",
  },
  capability_too_high: {
    title: "申请的能力超过对方上限",
    hint: "改选「只看」再试，或请对方把能力上限调到可控。",
    kind: "capability",
  },
  busy: {
    title: "对方已有进行中的远程会话",
    hint: "稍后再试，或请对方先结束当前会话。",
    kind: "busy",
  },
  busy_local: {
    title: "本机已有进行中的远程会话",
    hint: "先结束当前会话再发起新的远程。",
    kind: "busy",
  },
  confirm_timeout: {
    title: "对方未在 2 分钟内确认",
    hint: "对方可能没注意到确认条。提醒对方查看 PastePanda。",
    kind: "timeout",
  },
  rejected_or_busy: {
    title: "对方拒绝或会话被占用",
    hint: "对方可能点了拒绝，或已有别的会话。",
    kind: "busy",
  },
  connect_failed: {
    title: "连接对端失败",
    hint: "对方可能离线、未启动远程通道，或不在同一网络且中继不可用。",
    kind: "offline",
  },
  channel_down: {
    title: "远程通道未启动",
    hint: "在工具箱点「开启远程通道」，或先完成一次配对。",
    kind: "offline",
  },
  connection_lost: {
    title: "连接对端时中途断开",
    hint: "对方可能刚好关机、切网，或中继不稳。稍后重试；若一直如此，确认对方远程通道在跑、双方网络可达。",
    kind: "offline",
  },
  not_request: {
    title: "对端收到了意外的申请",
    hint: "两台机器的版本可能不一致，先都升到同一版本再试。",
    kind: "other",
  },
  bad_request: {
    title: "对端无法识别这次申请",
    hint: "两台机器的版本可能不一致，先都升到同一版本再试。",
    kind: "other",
  },
  bad_node_id: {
    title: "设备标识无效",
    hint: "请重新配对这台设备。",
    kind: "other",
  },
  // ── Q2 无人值守：接入码（方案 B）与固定密码（方案 C）的准入门 ──
  uno_invalid: {
    title: "接入码无效或已过期",
    hint: "接入码默认 15 分钟有效、限 1 次。请让对方重新生成一个再试。",
    kind: "not_paired",
  },
  uno_store_error: {
    title: "对方暂时无法处理该接入码",
    hint: "对方本机存储出了问题，请稍后重试。",
    kind: "other",
  },
  uno_pass_off: {
    title: "对方未开启固定密码接入",
    hint: "请对方在「远程电脑 → 无人值守固定密码」里开启，或改用接入码 / 正常配对。",
    kind: "not_paired",
  },
  uno_pass_invalid: {
    title: "接入密码不正确",
    hint: "核对密码后重试。注意：连续错 5 次会被对方机器临时锁定 10 分钟。",
    kind: "not_paired",
  },
  uno_pass_wan: {
    title: "对方的固定密码仅限局域网使用",
    hint: "连到与对方同一 Wi-Fi / 网段再试，或请对方在固定密码设置里打开「允许跨网」。",
    kind: "not_paired",
  },
  uno_pass_throttled: {
    title: "尝试过于频繁",
    hint: "等一会儿再试；连续错 5 次会锁定 10 分钟。",
    kind: "busy",
  },
  uno_pass_store_error: {
    title: "对方暂时无法处理该接入请求",
    hint: "对方本机存储出了问题，请稍后重试。",
    kind: "other",
  },
};

/**
 * 从正文里认「对端关闭连接时带上的 code」。
 *
 * 🔴 为什么需要它：后端把 `close_reason()` 拼进了错误串
 * （`src-tauri/src/rc/service.rs` 的 `explain`），形态是
 * `读帧长度失败：connection lost（closed by peer: [not_paired] 尚未远程配对 (code 1)）`。
 * 而下面 `byReasonText` 里「connection lost」那条判据会把整串一口吞掉、
 * 报成「对方可能关机」——恰恰又把真实理由盖住了。
 * 所以带 code 的关闭原因必须**先于**文本判据认。
 */
function fromCloseReason(reason: string): Omit<RcErrorInfo, "reason"> | null {
  const m = /closed by peer:\s*\[([a-z_]+)\]/i.exec(reason);
  const code = m?.[1]?.toLowerCase();
  if (!code) return null;
  // 认不出来就返回 null，让后面的文本判据继续兜底（而不是给一个错的分档）。
  return BY_CODE[code] ?? null;
}

function byReasonText(reason: string): Omit<RcErrorInfo, "reason"> | null {
  // 方案 C 的具体文案必须**先于**通用「未开启」判：
  // 「对方未开启固定密码接入」里也有「未开启」，先来先得会误报成「允许被远程」关着。
  if (reason.includes("固定密码") || reason.includes("接入密码")) {
    if (reason.includes("过于频繁")) return BY_CODE.uno_pass_throttled;
    if (reason.includes("不正确")) return BY_CODE.uno_pass_invalid;
    if (reason.includes("局域网")) return BY_CODE.uno_pass_wan;
    if (reason.includes("未开启")) return BY_CODE.uno_pass_off;
  }
  if (reason.includes("接入码无效")) return BY_CODE.uno_invalid;
  if (reason.includes("未开启") || reason.includes("允许被远程")) {
    return BY_CODE.disabled;
  }
  if (reason.includes("禁止")) return BY_CODE.device_denied;
  // 「窗口过期」必须先于「未配对」判：过期文案里也可能带「配对」二字。
  // 也兜住 `invite::decode` 那条本地报错（「这份邀请码已过期…」）——
  // 它不带 `[code]` 前缀，但意思与「对方的窗口过期」完全一致，动作也一样。
  if (reason.includes("邀请窗口") || reason.includes("已过期")) {
    return BY_CODE.invite_door_closed;
  }
  if (reason.includes("拒绝过")) return BY_CODE.pair_denied;
  if (reason.includes("未配对") || reason.includes("尚未完成远程配对")) {
    return BY_CODE.not_paired;
  }
  // 🔴 connection lost 要先于「超时」：它也可能写成「…秒内一个字节都没动」
  // 之外的形态；真正的停滞超时文案含「秒内」「停滞」，下面单独认。
  if (
    reason.includes("connection lost") ||
    reason.includes("读帧长度失败") ||
    reason.includes("读帧内容失败")
  ) {
    return BY_CODE.connection_lost;
  }
  if (reason.includes("超时") || reason.includes("停滞")) return BY_CODE.confirm_timeout;
  if (reason.includes("已有进行中") || reason.includes("占用")) return BY_CODE.busy;
  if (reason.includes("连接对端失败") || reason.includes("离线")) return BY_CODE.connect_failed;
  if (reason.includes("通道未启动")) return BY_CODE.channel_down;
  return null;
}

/** 解析后端错误串（`[code] reason` 或裸 reason）。 */
export function explainRcError(raw: string): RcErrorInfo {
  const m = /^\[([a-z_]+)\]\s*([\s\S]*)$/i.exec(raw);
  const code = m?.[1]?.toLowerCase() ?? "";
  const reason = (m?.[2] ?? raw).trim();
  const hit = BY_CODE[code] ?? fromCloseReason(reason) ?? byReasonText(reason);
  if (hit) return { ...hit, reason };
  return {
    title: "远程申请未成功",
    hint: reason || "请稍后重试；若持续失败，检查双方网络与「允许被远程」开关。",
    kind: "other",
    reason,
  };
}
