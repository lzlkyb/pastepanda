/**
 * RcPairModeSelect — 配对向导的第一屏（乙方案 2026-09-26 瘦身后的全部 anatomy）。
 *
 * 设计稿：`design/远程电脑-入口收敛乙方案-默认保留配对-设计稿.html` §2。
 *
 * # 🔴 主路只剩「附近设备」一条
 *
 * 局域网是**零字符串搬运**的一条路：点一下、对一眼 6 位数字就完事，而且能挡住
 * 中间人（换公钥 → 两端数字对不上）。跨网第一次连接的正路已改走「帮助」
 * （出码/粘码，连完设备默认保留）——邀请码不再挡在主路，降级进折叠「高级」，
 * 留一版观察使用情况后移除。
 *
 * # 空的时候怎么渲染
 *
 * 空态照渲（`RcNearbyList` 自带标题与「对方版本要够新」那条），因为「用户以为
 * 找不到设备是网络问题」这个误解恰恰发生在看不到任何设备的时候。
 *
 * 纯展示，无本地状态。原先这里的「剪贴板检测到邀请码，要填入吗」已挪进
 * `RcPairPastePane`——询问只该发生在用户已经决定粘码之后，不该一开屏就拦。
 */
import type { RcNeighbor } from "@/lib/api/rcPair";
import { RcNearbyList } from "./RcNearbyList";
import pairStyles from "./RcPair.module.css";
import styles from "../rc/RemoteComputer.module.css";

export function RcPairModeSelect({ neighbors, busy, onPair, onCreate, onPaste }: {
  neighbors: RcNeighbor[];
  busy: boolean;
  onPair: (n: RcNeighbor) => void;
  onCreate: () => void;
  onPaste: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className={pairStyles.secLabel}>同一局域网（推荐，零搬运）</div>
      <RcNearbyList neighbors={neighbors} busy={busy} onPair={onPair} />
      <div className={styles.foot}>
        点「配对」→ 两边各核一次 6 位数字 → 完成。<b>配对成功的设备会自动出现在列表里</b>，
        直接点大钮就能连。
      </div>
      <div className={`${styles.foot} ${pairStyles.hintMuted}`}>
        不在同一网络？不用这里——让对方点「帮助 → 让别人帮我」把码发给你，
        你在「帮别人连一次」粘贴，连完后设备自动保留。
      </div>

      <details className={pairStyles.adv}>
        <summary>高级：手动生成 / 粘贴配对码</summary>
        <div className={pairStyles.advBody}>
          <button
            type="button"
            className={`${styles.miniBtn} ${pairStyles.advBtn}`}
            onClick={onCreate}
          >
            生成配对码（给对方粘贴）
          </button>
          <button
            type="button"
            className={`${styles.miniBtn} ${pairStyles.advBtn}`}
            onClick={onPaste}
          >
            粘贴对方的配对码
          </button>
          <div className={styles.foot}>
            留作对方暂时不方便开帮助窗口时的兜底。
          </div>
        </div>
      </details>

      <div className={styles.foot}>
        与「知识库同步」配对是两回事：这里只授权远程协助，不共享笔记。
      </div>
    </div>
  );
}
