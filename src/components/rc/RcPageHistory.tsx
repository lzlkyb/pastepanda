/**
 * RcPageHistory — 「会话记录」页（v4 布局，2026-09-19）。
 *
 * 列表本体复用 `RcSessionHistory`（设置页同一份组件——同一个数据源
 * `rc_session_history` 不该有两套渲染）。这里补的是页面级的归属说明：
 * 记录只存本机 config（`rc_session_history` 键，上限 20 条）、只记元数据。
 *
 * 「清空记录」就该在日志自己的页面上（数据红线「日志可见可删除」）。它原本挂在
 * 旧顶栏 `RcWorkbenchHead` 的 actions 槽位，A2 把顶栏换成 `RcA2TitleBar` 后
 * 那处没人渲染了——批5 挪进本页，与说明同行常驻可见（规则 15.1：触发与反馈
 * 要在同一可见性域）。走 ConfirmDialog；清完调 `history.reload()` 重拉。
 *
 * 批5：设备筛选（侧栏）与数据源都由 `RcWorkbench` 持有——侧栏在 DOM 上不是
 * 本页的子节点，筛选态必须提到共同祖先。本页只消费。
 */
import { Trash2 } from "lucide-react";
import type { RcCapability } from "@/lib/api/rc";
import { confirmDialog } from "@/lib/confirm";
import { useToast } from "@/components/Toast";
import type { UseRc } from "@/hooks/useRc";
import type { UseRcHistory } from "@/hooks/useRcHistory";
import { RcSessionHistory } from "./RcSessionHistory";
import styles from "./RemoteComputer.module.css";

export function RcPageHistory({
  rc,
  peer,
  history,
  onReconnect,
}: {
  rc: UseRc;
  /** 受控的设备筛选（node_id），null = 全部设备。与侧栏同一份状态。 */
  peer: string | null;
  /** 工作台级的会话历史（与侧栏筛选共享同一份快照，避免两处计数来自不同批次）。 */
  history: UseRcHistory;
  /** 再次发起。`cap` 取自本条记录（上次用的档）——语义在 RcSessionHistory 顶部。 */
  onReconnect: (nodeId: string, name: string, cap: RcCapability) => void;
}) {
  return (
    <div className={styles.pageWrap} role="region" aria-label="会话记录">
      <div className={styles.pageLead}>
        <p className={styles.pageNote}>
          每次远程结束后记一条：<b>只记元数据</b>（时间、时长、结果、路径与延迟），
          不记画面与键鼠；记录只存在本机，上限 20 条。
        </p>
        <RcHistoryClearButton rc={rc} onCleared={() => void history.reload()} />
      </div>
      <RcSessionHistory
        targets={rc.targets}
        running={rc.status?.running ?? false}
        busy={rc.busy}
        onReconnect={onReconnect}
        /* v4 对稿（D 窗）：页面态用五列表格行；主窗设置页继续 compact。 */
        variant="page"
        data={history}
        peer={peer}
      />
    </div>
  );
}

/** 「清空记录」：ConfirmDialog → rc_history_clear → 通知调用方重拉列表。 */
export function RcHistoryClearButton({
  rc,
  onCleared,
}: {
  rc: UseRc;
  onCleared: () => void;
}) {
  const { toast } = useToast();
  const clear = async () => {
    const ok = await confirmDialog({
      title: "清空会话记录",
      message: "将删除本机全部会话历史（只含元数据），清空后不可恢复。",
      confirmText: "清空",
      variant: "danger",
    });
    if (!ok) return;
    const done = await rc.clearHistory();
    toast(done ? "会话记录已清空" : "清空失败，请重试", done ? "success" : "error");
    if (done) onCleared();
  };
  return (
    <button
      type="button"
      className={styles.miniBtn}
      disabled={rc.busy}
      onClick={() => void clear()}
    >
      <Trash2 size={12} aria-hidden="true" />
      清空记录
    </button>
  );
}
