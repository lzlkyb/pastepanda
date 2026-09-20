/**
 * RcWorkbenchHead — 工作台顶栏（`RcTopBar`）+ 它**随页变化的动作**。
 *
 * 从 `RcWorkbench` 拆出：那段内联 JSX 有 30 行，而它的职责是自洽的一小块——
 * 「这一页的标题/副标题念什么、右上角摆哪几个动作」。主文件当时已 311 行、
 * 越过 `.tsx ≤ 300` 红线（G6 加「文件传输」页时撑过去的），拆这里是最自然的缝。
 *
 * 两条口径：
 *  1. **副标题的实时计数只给设备页**。其余页沿用 `WB_PAGE_META` 的静态文案——
 *     在没有设备列表的页面上念「共 N 台」是噪声。
 *  2. **动作按页归位**（devices = 检测在线 + 配对；history = 清空记录），
 *     具体 JSX 在各自页面文件里（`RcDevicesTopActions` / `RcHistoryClearButton`），
 *     这里只做分派。
 */
import { useToast } from "@/components/Toast";
import type { UseRc } from "@/hooks/useRc";
import type { RcSession } from "@/lib/api/rc";
import type { WbPage } from "@/lib/rcWorkbench";
import { RcTopBar } from "./RcTopBar";
import { RcDevicesTopActions } from "./RcPageDevices";
import { RcHistoryClearButton } from "./RcPageHistory";

export function RcWorkbenchHead({
  page,
  channelUp,
  busy,
  session,
  sessionLabel,
  probing,
  onProbe,
  onPair,
  onCleared,
  onStartChannel,
  onOpenSettings,
  rc,
  toast,
}: {
  page: WbPage;
  channelUp: boolean;
  busy: boolean;
  session: RcSession | null;
  /** 会话 chip 的一行状态；空串 = 不摆。 */
  sessionLabel: string;
  /** 设备页顶栏的「检测在线」进行中态。 */
  probing: boolean;
  onProbe: () => void;
  onPair: () => void;
  /** history 页清空记录成功后 +1（用 key 重挂页面重新拉列表）。 */
  onCleared: () => void;
  onStartChannel: () => void;
  onOpenSettings: () => void;
  rc: UseRc;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  return (
    <RcTopBar
      page={page}
      channelUp={channelUp}
      busy={busy}
      sessionLabel={sessionLabel}
      /* v4 对稿（B 窗）：会话 chip 带每秒走字的时长（计时器在 live region 外）。 */
      sessionStartedMs={session?.started_ms}
      /* v4 对稿（C 窗）：设备列表页副标题念实时计数；其余页沿用静态 meta。 */
      hintOverride={
        page === "devices"
          ? `共 ${rc.targets.length} 台 · ${rc.targets.filter((t) => t.presence === "live").length} 台在线`
          : undefined
      }
      /* v5：devices 页动作 = 检测在线 + 配对设备；history 页动作 = 清空记录。
         JSX 外移到各自页面文件（RcDevicesTopActions / RcHistoryClearButton）。 */
      actions={
        page === "devices" ? (
          <RcDevicesTopActions probing={probing} onProbe={onProbe} onPair={onPair} />
        ) : page === "history" ? (
          <RcHistoryClearButton rc={rc} toast={toast} onCleared={onCleared} />
        ) : undefined
      }
      onStartChannel={onStartChannel}
      onOpenSettings={onOpenSettings}
    />
  );
}
