/**
 * RcA2Sidebar — A2 工作台的常驻侧栏（方案 A 重做，2026-09-26）。
 *
 * 三段结构（对齐拼装稿左栏）：
 *  - 上半部随页切换：设备/文件/设置页 → `RcA2DeviceList`（在线/不在线分组，
 *    行内零按钮）；记录页 → `RcA2HistoryFilter`。
 *  - 「这台电脑」卡（`RcA2SelfCard`）：常驻设备号短指纹码格 + 复制 + 完整串
 *    一键出码 + 允许被连接开关（高频操作留在侧栏，设置页同款仍在）。
 *  - 底部：单个「帮助」钮（亮码/输码收进一个弹层）+ 工具横排（文件/记录/设置）。
 *
 * 连接动作从侧栏下架：行内零按钮后，发起只走详情面 hero 大钮（方案 3 拍板）。
 */
import { FileUp, History, Settings, Users } from "lucide-react";
import type { RcTargetDevice } from "@/lib/api/rc";
import type { RcHistoryDevice } from "@/lib/rcHistory";
import type { RcTransferStrip } from "@/hooks/useRcTransferNotice";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import type { RcA2Page } from "@/lib/rcWorkbenchA2";
import type { RcReachability } from "@/stores/rcStoreTypes";
import { RcA2DeviceList } from "./RcA2DeviceList";
import { RcA2HistoryFilter } from "./RcA2HistoryFilter";
import { RcA2SelfCard } from "./RcA2SelfCard";
import styles from "./RemoteComputerA2.module.css";

const TOOLS: { page: Exclude<RcA2Page, "devices">; label: string; icon: typeof FileUp }[] = [
  { page: "files", label: "文件", icon: FileUp },
  { page: "history", label: "记录", icon: History },
  { page: "settings", label: "设置", icon: Settings },
];

/** 记录页侧栏的筛选态（打包成一个 prop：它整体来自 RcWorkbench 的同一份历史快照）。 */
export interface RcA2HistoryFilterState {
  devices: RcHistoryDevice[];
  total: number;
  peer: string | null;
  onSelect: (peer: string | null) => void;
}

export function RcA2Sidebar({
  page,
  targets,
  selectedId,
  busy,
  locked,
  reachability,
  channelUp,
  targetsLoaded,
  targetsError,
  onSelect,
  onRefresh,
  onPair,
  onNavigate,
  selfEnabled,
  onToggleSelf,
  onUnoGenerate,
  onHelp,
  rc,
  toast,
  historyFilter,
  capFor,
  transferBadge = 0,
  transferStrip = null,
  trustedOnly = false,
  onExitTrustedFilter,
}: {
  page: RcA2Page;
  targets: RcTargetDevice[];
  selectedId: string | null;
  busy: boolean;
  locked: boolean;
  reachability?: Record<string, RcReachability>;
  channelUp?: boolean | null;
  targetsLoaded?: boolean;
  targetsError?: string | null;
  onSelect: (id: string) => void;
  onRefresh?: () => void;
  onPair: () => void;
  onNavigate: (page: RcA2Page) => void;
  selfEnabled?: boolean;
  onToggleSelf?: (enabled: boolean) => void;
  /** 「无人值守 ›」：出本机无人值守码（RcUnoDialog generate）。 */
  onUnoGenerate?: () => void;
  /** 「帮助」：一个弹层收齐「让别人帮我 / 帮别人连一次」（方案 A 收口）。 */
  onHelp?: () => void;
  /** 「这台电脑」卡要用：本机身份 + 完整串生成 + toast。 */
  rc?: UseRc;
  toast?: ToastFn;
  historyFilter?: RcA2HistoryFilterState;
  /** 行 meta 预告「以哪档连接」——行钮删除后这是档位唯一的常驻预告位。 */
  capFor?: (id: string) => import("@/lib/api/rc").RcCapability;
  /** U2：「文件」导航角标 = 进行中传输任务数。 */
  transferBadge?: number;
  /** U2：侧栏顶部传输摘要条（仅离开文件页时由调用方给出）。 */
  transferStrip?: RcTransferStrip | null;
  /** U10：免确认设备过滤态。 */
  trustedOnly?: boolean;
  onExitTrustedFilter?: () => void;
}) {
  return (
    <aside className={styles.sidebar} aria-label="我的设备与工具">
      {transferStrip && (
        <button type="button" className={styles.xferStrip} onClick={transferStrip.onClick}>
          {transferStrip.label}
        </button>
      )}
      {page === "history" && historyFilter ? (
        <RcA2HistoryFilter
          devices={historyFilter.devices}
          total={historyFilter.total}
          peer={historyFilter.peer}
          targets={targets}
          onSelect={historyFilter.onSelect}
          onBack={() => onNavigate("devices")}
        />
      ) : (
        <RcA2DeviceList
          page={page}
          targets={targets}
          selectedId={selectedId}
          reachability={reachability}
          channelUp={channelUp}
          targetsLoaded={targetsLoaded}
          targetsError={targetsError}
          onSelect={onSelect}
          onRefresh={onRefresh}
          onPair={onPair}
          onNavigate={onNavigate}
          capFor={capFor}
          trustedOnly={trustedOnly}
          onExitTrustedFilter={onExitTrustedFilter}
        />
      )}

      {onToggleSelf && rc && (
        <RcA2SelfCard
          rc={rc}
          toast={toast ?? (() => undefined)}
          busy={busy}
          locked={locked}
          enabled={Boolean(selfEnabled)}
          onToggleSelf={onToggleSelf}
          onUnoGenerate={onUnoGenerate ?? (() => undefined)}
        />
      )}

      <div className={styles.sideFoot}>
        {onHelp && (
          <button type="button" className={styles.helpBtn} onClick={onHelp}>
            <Users size={14} aria-hidden="true" />
            帮助
            <small>让别人帮我 / 帮别人连一次</small>
          </button>
        )}
        <nav className={styles.toolRow} aria-label="远程电脑工具">
          {TOOLS.map(({ page: toolPage, label, icon: Icon }) => (
            <button
              key={toolPage}
              type="button"
              className={page === toolPage ? styles.toolActive : undefined}
              aria-current={page === toolPage ? "page" : undefined}
              onClick={() => onNavigate(toolPage)}
            >
              {/* U2：文件页有进行中传输时，角标常驻可见（离开页面也能看见在传） */}
              {toolPage === "files" && transferBadge > 0 && (
                <span className={styles.toolBadge} aria-label={`${transferBadge} 个传输进行中`}>
                  {transferBadge}
                </span>
              )}
              <Icon size={14} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </div>
    </aside>
  );
}
