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
  bad_node_id: {
    title: "设备标识无效",
    hint: "请重新配对这台设备。",
    kind: "other",
  },
};

function byReasonText(reason: string): Omit<RcErrorInfo, "reason"> | null {
  if (reason.includes("未开启") || reason.includes("允许被远程")) {
    return BY_CODE.disabled;
  }
  if (reason.includes("禁止")) return BY_CODE.device_denied;
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
  const hit = BY_CODE[code] ?? byReasonText(reason);
  if (hit) return { ...hit, reason };
  return {
    title: "远程申请未成功",
    hint: reason || "请稍后重试；若持续失败，检查双方网络与「允许被远程」开关。",
    kind: "other",
    reason,
  };
}
