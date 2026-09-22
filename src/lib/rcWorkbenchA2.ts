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

/**
 * 会话态要不要收掉工作台标题栏（稿：`.window[data-state="session"] .titlebar { display:none }`）。
 *
 * 只收「正在控制别人画面」这一态——画面铺满整个工作台，不再被 48px 内嵌栏压着。
 * 连接中 / 等待对方同意 / 被控态都**留**标题栏：那三态下工作台本体还是「侧栏 + 主区」，
 * 标题栏仍要承担**通道状态位 + 窗口控制 + 拖拽区**（批7 起窗口 `decorations(false)`，
 * 没有系统标题栏，这三样只剩它能给）；被控态的画面本来就在别处（RcInboundView）。
 * 注意：这条判据早先的论据是标题栏上的「检测设备」「启动远程通道」两个按钮，批7 已把
 * 它们下架（前者进设备行、后者变成状态位自适应），结论没变但论据换了。
 *
 * 🔴 单独抽成纯函数而非在 JSX 里写 `surface === "session"`，是为了让守卫单测
 * 钉住这个判据。批7 落地自绘窗口控制（`decorations(false)`）时，会话态没有系统
 * 标题栏可拖，**必须在这一态补一条可拖拽细条**——改这里与 RcWorkbench 的同一个
 * 分支即可，不要在会话视图里另写一套显隐判断。
 */
export function hidesWorkbenchTitleBar(surface: RcA2Surface): boolean {
  return surface === "session";
}
