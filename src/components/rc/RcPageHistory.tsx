/**
 * RcPageHistory — 「会话记录」页（v4 布局，2026-09-19）。
 *
 * 列表本体复用 `RcSessionHistory`（设置页同一份组件——同一个数据源
 * `rc_session_history` 不该有两套渲染）。这里补的是页面级的归属说明：
 * 记录只存本机 config（`rc_session_history` 键，上限 20 条）、只记元数据。
 *
 * v5（design/远程电脑-v5-沉浸工作台-设计稿.html D 窗）：「清空记录」升到本页
 * 顶栏（RcTopBar actions 槽位，见下方 RcHistoryClearButton）——数据红线
 * 「日志可见可删除」的删除入口就该在日志自己的页面上。走 ConfirmDialog；
 * 清完由调用方递增 epoch 重挂本页重新拉列表（列表在挂载时读一次）。
 */
import { Trash2 } from "lucide-react";
import type { RcCapability } from "@/lib/api/rc";
import { confirmDialog } from "@/lib/confirm";
import type { UseRc } from "@/hooks/useRc";
import type { useToast } from "@/components/Toast";
import { RcSessionHistory } from "./RcSessionHistory";
import styles from "./RemoteComputer.module.css";

export function RcPageHistory({
  rc,
  onReconnect,
}: {
  rc: UseRc;
  /** 再次发起。`cap` 取自本条记录（上次用的档）——语义在 RcSessionHistory 顶部。 */
  onReconnect: (nodeId: string, name: string, cap: RcCapability) => void;
}) {
  return (
    <div className={styles.pageWrap} role="region" aria-label="会话记录">
      <div className={styles.pageNote}>
        每次远程结束后记一条：<b>只记元数据</b>（时间、时长、结果、路径与延迟），
        不记画面与键鼠；记录只存在本机，上限 20 条。
      </div>
      <RcSessionHistory
        targets={rc.targets}
        running={rc.status?.running ?? false}
        busy={rc.busy}
        onReconnect={onReconnect}
        /* v4 对稿（D 窗）：页面态用五列表格行；主窗设置页继续 compact。 */
        variant="page"
      />
    </div>
  );
}

/** 顶栏「清空记录」：ConfirmDialog → rc_history_clear → 通知调用方刷新列表。 */
export function RcHistoryClearButton({
  rc,
  toast,
  onCleared,
}: {
  rc: UseRc;
  toast: ReturnType<typeof useToast>["toast"];
  onCleared: () => void;
}) {
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
