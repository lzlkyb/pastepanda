import type { RcNeighbor } from "@/lib/api/rcPair";
import { RcNearbyList } from "./RcNearbyList";
import pairStyles from "./RcPair.module.css";
import styles from "../rc/RemoteComputer.module.css";

/**
 * RcPairModeSelect — 配对对话框的第一屏：先列「附近的设备」，再给邀请码那两条路。
 *
 * 设计稿：`design/远程电脑-配对流程重做-设计稿.html` §4.1。
 *
 * # 🔴 局域网那一条为什么排在最上面
 *
 * 它是**零字符串搬运**的一条路：点一下、对一眼数字就完事，比复制粘贴快得多，
 * 而且**能挡住中间人**（换公钥 → 两端数字对不上）。邀请码是**兜底**——
 * 不在同一网段时才用它。原来两条路都要求搬码，用户在同一局域网下也得走那一套。
 *
 * # 空的时候怎么渲染（2026-09-17 定稿）
 *
 * 设计稿 §4.1 说「没有设备就不出现（不留空标题）」，§4.2 又给了空态的完整设计
 * （带「对方版本需 ≥ 7.2.2」那条）——两处图例矛盾，拍板的是后者的一半：
 * **空态照渲**（`RcNearbyList` 自带标题，所以不会留下空标题），
 * 但**不渲下面那个「同一局域网（推荐）」小标**（见本文件 `has &&`），
 * 也**不重复那个「改用邀请码配对」按钮**——邀请码两个按钮就在下面几行。
 * 理由是 §4.2 那条版本要求解决的正是「用户以为找不到设备是网络问题」，
 * 而这个误解恰恰发生在看不到任何设备的时候。
 *
 * 纯展示，无本地状态。
 */
export function RcPairModeSelect({ neighbors, busy, clipInvite, onPair, onFill, onIgnore, onCreate, onPaste }: {
  neighbors: RcNeighbor[];
  busy: boolean;
  clipInvite: string | null;
  onPair: (n: RcNeighbor) => void;
  onFill: (clip: string) => void;
  onIgnore: () => void;
  onCreate: () => void;
  onPaste: () => void;
}) {
  const has = neighbors.length > 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {clipInvite && (
        <div className={styles.noteWarn} style={{ flexDirection: "column", alignItems: "stretch" }}>
          <div>检测到剪贴板里可能有一份远程邀请码，要填入吗？</div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className={styles.miniBtnPri}
              onClick={() => onFill(clipInvite)}
            >
              填入
            </button>
            <button
              type="button"
              className={styles.miniBtn}
              onClick={onIgnore}
            >
              忽略
            </button>
          </div>
        </div>
      )}

      {has && <div className={pairStyles.secLabel}>同一局域网（推荐）</div>}
      <RcNearbyList neighbors={neighbors} busy={busy} onPair={onPair} />

      <div className={pairStyles.sep} />
      <div className={pairStyles.secLabel}>不在同一局域网</div>
      <button
        type="button"
        className={styles.miniBtnPri}
        onClick={onCreate}
      >
        生成邀请码（给对方粘）
      </button>
      <button
        type="button"
        className={styles.miniBtn}
        onClick={onPaste}
      >
        粘贴对方的邀请码
      </button>

      <div className={pairStyles.sep} />
      <div className={styles.foot}>
        与「知识库同步」配对是两回事：这里只授权远程协助，不共享笔记。
      </div>
    </div>
  );
}
