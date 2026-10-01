/**
 * RcPairDigest — 「这串凭证的 8 位核对数」的**唯一展示件**（规则 11 收口）。
 *
 * 三条配对路里只有附近配对天生带一个两端一致的 8 位数（SAS）。跨网那条路
 * 搬的是一长串接入码，用户没法念也没法对。本组件把凭证折成 8 位
 * （[`pairCodeDigest`]），让两条路在用户眼里是同一件事：
 * 「都是一个 8 位数，两边对一眼」。
 *
 * 🔴 **它不是新增的安全层**：凭证自签，中间人把自己那份换进来时两端折出来
 * 的数照样一致。真正把关的是生成方那一侧的确认 + 指纹（见 `RcPairPastePane`
 * 头注释与 `sync/invite.rs` 模块头）。写在这里免得后人把它当 SAS 用。
 *
 * 两端各算各的（出示方折自己生成的码，输入方折刚粘的码），同一个 8 位数
 * 即「双方手上是同一份凭证」——**不需要后端参与**，因此也没有第二处口径。
 */
import { formatPairCode, pairCodeDigest } from "@/lib/utils";
import lanStyles from "./Lan.module.css";
import styles from "../rc/RemoteComputer.module.css";

/** `show` = 出示方；`enter` = 输入方。只是文案方向不同。 */
export function RcPairDigest({
  code,
  tone,
}: {
  code: string;
  tone: "show" | "enter";
}) {
  const digits = formatPairCode(pairCodeDigest(code));
  if (tone === "show") {
    return (
      <div className={lanStyles.lanPairBox}>
        <div className={lanStyles.lanPairTitle}>这串配对码的核对数</div>
        <div className={lanStyles.lanPairPin}>{digits}</div>
        <div className={lanStyles.lanPairHint}>
          让对方把这串码贴进「我拿到了对方的配对码」，<br />
          两边显示的是同一个数，才说明搬的过程中没被换过。
        </div>
      </div>
    );
  }
  return (
    <div className={lanStyles.lanPairBox}>
      <div className={lanStyles.lanPairTitle}>这串配对码的核对数</div>
      <div className={lanStyles.lanPairPin}>{digits}</div>
      <div className={lanStyles.lanPairHint}>
        和对方屏幕上那个 8 位数对一眼：<b>一致再发送</b>。
      </div>
      <div className={styles.foot}>
        不一致说明这份码在发送途中被人换过——把它退回去，让对方重新出示一份。
      </div>
    </div>
  );
}
