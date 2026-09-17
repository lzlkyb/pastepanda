/**
 * rcRequest — 「发起远程申请」用的能力档记忆。
 *
 * 改前：`RemoteComputerDialog` 的 `useState<RcCapability>("view")`——每次打开面板都
 * 回到「只看」，惯用「可控」的人每发起一次都要多点一下。
 *
 * 与既有的 `rc_last_peer`（同目录 `RemoteComputerDialog` 的 `LS_LAST`）同法：
 * localStorage 读写，任何异常都静默回落默认档——隐私模式下写不进去也不能让
 * 「发起远程」整个失败。
 */
import type { RcCapability } from "@/lib/api/rc";

const KEY = "rc_last_request_cap";

/** 没记过时的默认档。与后端默认一致，「只看」是更保守的一侧。 */
export const DEFAULT_REQUEST_CAP: RcCapability = "view";

/** 上次发起用的能力档；没记过或值不合法 → 默认「只看」。 */
export function lastRequestCap(): RcCapability {
  try {
    const v = localStorage.getItem(KEY);
    return v === "control" || v === "view" ? v : DEFAULT_REQUEST_CAP;
  } catch {
    return DEFAULT_REQUEST_CAP;
  }
}

/** 记下这次用的档，供下次一键发起。 */
export function rememberRequestCap(c: RcCapability): void {
  try {
    localStorage.setItem(KEY, c);
  } catch {
    /* 记不住不影响本次发起 */
  }
}

/**
 * 能力档的中文短文案。
 * 发起前必须在按钮上写明「将以『只看』发起」——能力记忆之后这是必要的交代，
 * 否则用户会以为「我只是想看看」却申请了可控（设计稿风险 #3）。
 */
export function capabilityLabel(c: string): string {
  return c === "control" ? "可控" : "只看";
}
