/**
 * RcPairDone — 配对完成屏（A3 局域网配对的第 4 步）。
 *
 * 设计稿：`design/远程电脑-配对流程重做-设计稿.html` §4.4。两端文案不同：
 *
 * - **发起方**：给「立刻发起远程」的出口（结论见 §8 #5）。配对完的第一意图
 *   几乎总是马上连过去，退回列表再点一次是白给的摩擦。
 * - **被配对方**：必须写「每次仍需要你点头」。不写的话用户会以为配对
 *   = 永久放行，下次对方直接连进来他会觉得被骗。
 *
 * 用 `✅` 而不是图标：与隔壁 `KbPairCreate.tsx` 的完成态写法一致（同一个
 * 「配对完成」语义，不该一个用 emoji 一个用 lucide）。
 */
import type { RcPairDone as DoneInfo } from "@/lib/api/rcPair";
import styles from "./RcPair.module.css";
import rcStyles from "../rc/RemoteComputer.module.css";

export function RcPairDone({ done, onClose, onStartRemote }: {
  done: DoneInfo;
  onClose: () => void;
  /**
   * 只由**能发起会话的地方**传进来（工具箱）。设置页里的配对入口没有会话
   * 上下文，那时不传 —— 按钮也就不渲染。见 `RcPairDialog` 的说明。
   */
  onStartRemote?: (peerId: string) => void;
}) {
  const name = done.peer_name.trim() || "这台设备";
  const canStart = done.initiator && !!onStartRemote;

  return (
    <>
      <div className={styles.okBox}>
        <div className={styles.okMark}>✅</div>
        <div className={styles.okTitle}>已与「{name}」配对</div>
        <div className={styles.okSub}>
          {done.initiator
            ? "现在可以发起远程协助了"
            : "对方可以向你发起远程申请了；每次仍需要你点头"}
        </div>
      </div>
      <div className={styles.btnRowCenter}>
        <button
          type="button"
          className={rcStyles.miniBtn}
          onClick={onClose}
        >
          {canStart ? "关闭" : "知道了"}
        </button>
        {canStart && (
          <button
            type="button"
            className={rcStyles.miniBtnPri}
            onClick={() => onStartRemote?.(done.peer_id)}
          >
            立刻发起远程
          </button>
        )}
      </div>
    </>
  );
}
