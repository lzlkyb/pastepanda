import type { WbMainMode } from "@/lib/rcWorkbench";

/** A2 只保留真实任务页；“远程电脑主页”与“设备列表”合并为设备中心。 */
export type RcA2Page = "devices" | "files" | "history" | "settings";

export type RcA2Surface = RcA2Page | "pending" | "inbound" | "session";

/**
 * 选中设备的单一回落规则。
 * 目标列表刷新后旧 id 可能消失，必须同步回落，不能留下空白详情区。
 */
export function resolveRcA2Selection(
  targets: readonly { node_id: string }[],
  selectedId: string | null | undefined,
): string | null {
  if (selectedId && targets.some((target) => target.node_id === selectedId)) {
    return selectedId;
  }
  return targets[0]?.node_id ?? null;
}

/** 会话是强状态：不能被用户之前停留的文件、记录或设置页遮住。 */
export function resolveRcA2Surface(mode: WbMainMode, page: RcA2Page): RcA2Surface {
  if (mode === "outbound") return "session";
  if (mode === "pending") return "pending";
  if (mode === "inbound") return "inbound";
  return page;
}
