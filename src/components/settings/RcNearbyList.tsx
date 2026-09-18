/**
 * RcNearbyList — 「附近的设备」：同网段里**还没配对**的邻居。
 *
 * 设计稿：`design/远程电脑-配对流程重做-设计稿.html` §4.1 / §4.2。
 *
 * # 🔴 名字不可信，所以行里只放名字、把判据留给下一步
 *
 * `name` 由对方在明文招呼包里自报（`wire::clean_name`），同网段任何人都能填。
 * 这一屏**不用它做任何判断**——点「配对」之后两端会算出同一个 6 位数字，
 * 那才是唯一靠人把关的地方。脚注把这件事写出来，是因为用户会以为
 * 「名字对得上就是那台机器」。
 *
 * # 为什么头像是方圆角
 *
 * 形态即语义：已配对设备是圆形头像（`rc/RcDeviceList`），邻居是方圆角。
 * 见 `RcPair.module.css` 的 `.avSq`。
 *
 * # 空态为什么列 4 条
 *
 * 第 4 条（对方版本要够新）是这次新增的：旧版对端**不会回招呼包**，
 * 用户会把它当成网络问题，反复重启 Wi-Fi。写出版本要求比让他猜强。
 *
 * ⚠️ 这一条**故意不写死版本号**（2026-09-18 定）：那个号改一次要人工同步 7 个文件，
 * 而用户没地方查对端的版本、也不会去装某个中间版本，他真正会做的只有
 * 「让对方升级到最新版」——所以写号的信息量≈0，代价是 7 处必错一处。
 * 只说「要够新」，把可操作的那半句（旧版只能走邀请码）留下。
 *
 * # 空态里为什么没有「改用邀请码配对」按钮（2026-09-17 定稿）
 *
 * 设计稿 §4.1「没有设备就不出现（不留空标题）」与 §4.2 的空态设计互相矛盾，
 * 拍板结论：**空态照渲**（它自带标题，所以不会留下空标题），
 * 但**不渲「同一局域网（推荐）」那个小标**、也**不重复那个按钮** ——
 * 邀请码那两个按钮就在本组件下方几行，同一个对话框里出现两次是噪音。
 * 要改回「完全没有就不出现」，就是删掉这里这个分支、由调用方判断 `length`。
 */
import type { RcNeighbor } from "@/lib/api/rcPair";
import rcStyles from "../rc/RemoteComputer.module.css";
import lanStyles from "./Lan.module.css";
import styles from "./RcPair.module.css";

/** 20 秒的 TTL 之内，把「最后一次听到」说成人话。 */
function heardAgo(nowMs: number, lastMs: number): string {
  const s = Math.max(0, Math.round((nowMs - lastMs) / 1000));
  return s < 5 ? "刚刚听到" : `${s} 秒前`;
}

/** 自己报的名字，空串渲染成「（未命名）」——不留一块空白让人怀疑渲染坏了。 */
function displayName(name: string): string {
  return name.trim() || "（未命名）";
}

/** 头像里那一个字：取名字首字符；没名字就用 `?`。 */
function avatarChar(name: string): string {
  const t = name.trim();
  return t ? t.charAt(0).toUpperCase() : "?";
}

export function RcNearbyList({ neighbors, busy, onPair }: {
  neighbors: RcNeighbor[];
  busy: boolean;
  onPair: (n: RcNeighbor) => void;
}) {
  // ❗ 用渲染时刻的 now：本组件由对话框那 2 秒一轮的轮询驱动重渲染，
  //   自己开定时器只会多一个要关的东西（规则 #8）。
  const now = Date.now();

  if (neighbors.length === 0) {
    return (
      <div className={lanStyles.lanNearbyEmpty}>
        <div className={lanStyles.lanNearbyEmptyTitle}>还没有发现附近设备</div>
        <ol className={lanStyles.lanNearbySteps}>
          <li>另一台电脑安装并打开 <b>PastePanda</b></li>
          <li>确保在同一 Wi-Fi / 局域网</li>
          <li>两边都打开 <b>远程电脑</b></li>
          <li>对方的 PastePanda 是<b>最新版</b>（旧版只能走邀请码）</li>
        </ol>
      </div>
    );
  }

  return (
    <>
      <div className={rcStyles.devList}>
        {neighbors.map((n) => (
          <div key={n.node_id} className={rcStyles.devItem}>
            <div className={styles.avSq}>{avatarChar(n.name)}</div>
            <div className={rcStyles.info}>
              <div className={rcStyles.name}>{displayName(n.name)}</div>
              <div className={rcStyles.meta}>未配对 · {heardAgo(now, n.last_seen_ms)}</div>
            </div>
            <button
              type="button"
              className={`${rcStyles.miniBtnPri} ${rcStyles.wideBtn}`}
              disabled={busy}
              onClick={() => onPair(n)}
            >
              配对
            </button>
          </div>
        ))}
      </div>
      <div className={rcStyles.foot}>
        设备名由对方自报、可随意填写（可自称，以指纹为准）——
        真正定对方是谁的是核对环节的那串数字。列表 20 秒听不到会自动移除。
      </div>
    </>
  );
}
