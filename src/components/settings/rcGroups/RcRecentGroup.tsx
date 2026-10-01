/**
 * RcRecentGroup — 组 4「最近会话」。
 *
 * 单块最大的体量来源：`RC_HISTORY_MAX = 20` 条 compact 行原先整份平铺在设置页里。
 * 现在收起态只剩摘要一行，展开态默认 3 条（「再连一次」这个高频动作必须在这 3 条里
 * 看得见，设计稿 §5 ④），「展开全部 20 条」交给 `RcSessionHistory` 的 `limit` 变体。
 *
 * 🔴 数据在编排层拉（`useRcHistory`）而不是让组件自拉：组头摘要要报「共几条 /
 * 最近一条是谁」，而摘要在组收起时是**唯一**可见的信息源。组件自拉的话收起态
 * 根本拿不到这份数据，摘要只能写死——那正是守卫测试要拦的事。
 *
 * 🔴 「再次连接」是**出站**动作，不跟「允许被远程协助」联动（原实现只 `disabled={busy}`）：
 * 主开关关掉后按记录再连一次对面，本来就是允许的——把它一起锁掉等于砍掉这条高频路径。
 */
import type { RcHistoryData } from "@/hooks/useRcHistory";
import { historyCapabilityLabel, historyPeerLabel } from "@/lib/rcHistory";
import { formatWhen } from "@/lib/rcSessionStats";
import { RcSessionHistory } from "@/components/rc/RcSessionHistory";
import type { RcCapability, RcTargetDevice } from "@/lib/api/rc";
import shared from "../../Settings.module.css";
import styles from "../RcSettings.module.css";
import { RcGroupHead } from "./RcGroupHead";

/** 展开态先给几条（§5 ④ 拍板：3 条 + 展开全部）。 */
const RECENT_PREVIEW = 3;

export function RcRecentGroup({
  history,
  targets,
  running,
  busy,
  open,
  inert,
  onToggle,
  onReconnect,
}: {
  history: RcHistoryData;
  targets: RcTargetDevice[];
  running: boolean;
  busy: boolean;
  open: boolean;
  /** 搜索态：组头停止响应点击（见 RcGroupHead）。 */
  inert?: boolean;
  onToggle: () => void;
  onReconnect: (nodeId: string, name: string, cap: RcCapability) => void;
}) {
  const last = history.list[0];

  return (
    <>
      <RcGroupHead
        label="最近会话"
        open={open}
        inert={inert}
        onToggle={onToggle}
        summary={
          history.loading ? (
            <>读取中…</>
          ) : history.list.length === 0 ? (
            <>暂无记录</>
          ) : (
            <>
              <span className={styles.rcGroupCount}>{history.list.length}</span> 条 · 最近{" "}
              {formatWhen(last.started_ms)} {historyPeerLabel(last)}（
              {historyCapabilityLabel(last.capability)}）
            </>
          )
        }
      />
      {open && (
        <div className={`${shared.lanPanel} ${styles.rcBlockTop}`}>
          <RcSessionHistory
            variant="compact"
            limit={RECENT_PREVIEW}
            data={history}
            targets={targets}
            running={running}
            busy={busy}
            onReconnect={onReconnect}
          />
        </div>
      )}
    </>
  );
}
