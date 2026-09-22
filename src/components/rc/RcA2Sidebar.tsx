/**
 * RcA2Sidebar — A2 工作台的常驻设备栏（306px）。
 *
 * 上半部随页切换（批5）：
 *  - 设备/文件/设置页 → `RcA2DeviceList`（标题行 + 搜索 + 分组设备列表）
 *  - 记录页 → `RcA2HistoryFilter`（按设备筛选）。稿的 history 屏就是这一形态，
 *    而设备列表在记录页点一下会跳回设备页，等于给了一个「不该按的按钮」。
 * 底部三类入口常驻：被连接开关、一次性协助、工具导航。
 *
 * 「允许别人连接本机」开关留在侧栏而稿只把它放在设置页：这是高频操作，留在
 * 侧栏一抬手就能切（设置页同款仍在）。此偏离已写进设计稿实施备注。
 */
import { FileUp, HandHelping, History, KeyRound, Settings, Users } from "lucide-react";
import type { RcCapability, RcTargetDevice } from "@/lib/api/rc";
import type { RcHistoryDevice } from "@/lib/rcHistory";
import type { RcA2Page } from "@/lib/rcWorkbenchA2";
import { RcA2DeviceList } from "./RcA2DeviceList";
import { RcA2HistoryFilter } from "./RcA2HistoryFilter";
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
  lockedLabel,
  onSelect,
  onConnect,
  onProbe,
  onPair,
  onNavigate,
  selfEnabled,
  onToggleSelf,
  onHelpMe,
  onHelpOther,
  onUnoJoin,
  historyFilter,
}: {
  page: RcA2Page;
  targets: RcTargetDevice[];
  selectedId: string | null;
  busy: boolean;
  locked: boolean;
  lockedLabel: string;
  onSelect: (id: string) => void;
  onConnect: (id: string, capability: RcCapability) => void;
  /** 批7：单台探测（透传给设备行离线态的「检测」）。 */
  onProbe: (id: string) => Promise<unknown>;
  onPair: () => void;
  onNavigate: (page: RcA2Page) => void;
  selfEnabled?: boolean;
  onToggleSelf?: (enabled: boolean) => void;
  onHelpMe?: () => void;
  onHelpOther?: () => void;
  onUnoJoin?: () => void;
  historyFilter?: RcA2HistoryFilterState;
}) {
  return (
    <aside className={styles.sidebar} aria-label="我的设备与工具">
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
          busy={busy}
          locked={locked}
          lockedLabel={lockedLabel}
          onSelect={onSelect}
          onConnect={onConnect}
          onProbe={onProbe}
          onPair={onPair}
          onNavigate={onNavigate}
        />
      )}

      {onToggleSelf && (
        <div className={styles.receiveRow}>
          <span>
            <strong>允许别人连接本机</strong>
            <small>{selfEnabled ? "已开启，可接收远程请求" : "已暂停接收远程请求"}</small>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={selfEnabled}
            disabled={busy || locked}
            className={selfEnabled ? styles.receiveOn : styles.receiveOff}
            onClick={() => onToggleSelf(!selfEnabled)}
          >
            {selfEnabled ? "已允许" : "已暂停"}
          </button>
        </div>
      )}

      {(onHelpMe || onHelpOther || onUnoJoin) && (
        <div className={styles.assistActions} aria-label="一次性协助">
          {onHelpMe && (
            <button type="button" onClick={onHelpMe}>
              <Users size={14} aria-hidden="true" />
              让别人帮我
            </button>
          )}
          {onHelpOther && (
            <button type="button" onClick={onHelpOther}>
              <HandHelping size={14} aria-hidden="true" />
              帮助别人
            </button>
          )}
          {onUnoJoin && (
            <button type="button" className={styles.assistJoin} onClick={onUnoJoin}>
              <KeyRound size={14} aria-hidden="true" />
              输入接入码
            </button>
          )}
        </div>
      )}

      <nav className={styles.toolNav} aria-label="远程电脑工具">
        {TOOLS.map(({ page: toolPage, label, icon: Icon }) => (
          <button
            key={toolPage}
            type="button"
            className={page === toolPage ? styles.toolActive : undefined}
            aria-current={page === toolPage ? "page" : undefined}
            onClick={() => onNavigate(toolPage)}
          >
            <Icon size={16} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
