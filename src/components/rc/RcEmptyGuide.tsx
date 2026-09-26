/**
 * RcEmptyGuide — 远程面板空态引导（L3）。
 *
 * 1A（2026-09-18）：三步讲的都是「配对→发起→同意」，唯独不提被控方的
 * 「允许被远程」开关——被控视角的人做完三步，对方还是连不进来。
 * 本机开关是关的且调用方给了动作时，在引导顶部放一条 orange 提示 +
 * 「立即打开」，就地解决（不用跳设置页）。
 *
 * 2026-09-18（布局修复）：三步引导原先塞在**侧栏 272px** 里做三列 grid，
 * 每列实测只剩 63px（中文每行 3~4 字），而同一时刻主区整块空着 ——
 * 「引导放哪」和「有没有空间」正好反了。现在完整版（含三步）**只由主区渲染**
 * （见 RcWorkbench）；侧栏改用 `emptyHint` 那一行提示，不再复用本组件
 * ——复用会让同一个标题与同一个配对按钮在屏幕上各出现两次。
 */
import { Monitor } from "lucide-react";
import styles from "./RemoteComputer.module.css";

const STEPS = [
  {
    t: "双方配对",
    d: "同一网络：打开配对后在「附近的设备」点对方，两边核对同一个 6 位数字。跨网才用长期配对码。知识库同步配对不会自动获得远程/文件权限。",
  },
  { t: "发起申请", d: "选「只看」或「可控」，对方会看到确认条与你的指纹。同意一次后该设备会记入远程列表。" },
  { t: "对方同意", d: "被控端常驻横幅可随时结束；默认关闭，每次都要点头（或逐台开免确认）。" },
];

export function RcEmptyGuide({
  onPair,
  onHelpMe,
  onHelpOther,
  onUnoJoin,
  selfEnabled = true,
  onEnableSelf,
}: {
  onPair: () => void;
  /** 方案甲：被协助方——出码让对方连一次（用完即忘）。 */
  onHelpMe: () => void;
  /** 方案甲：协助方——粘对方的码直接连，跳过配对完成屏。 */
  onHelpOther: () => void;
  /** Q2：无人值守接入——粘对方的接入码直连（对方机器可以没人）。 */
  onUnoJoin: () => void;
  /** 本机「允许被远程」当前状态；缺省按已开处理（不显示提示条）。 */
  selfEnabled?: boolean;
  /** 就地打开开关的动作；未提供则不显示提示条。 */
  onEnableSelf?: () => void;
}) {
  return (
    <div className={`${styles.emptyBox} ${styles.emptyBoxCenter}`}>
      {!selfEnabled && onEnableSelf && (
        <div className={`${styles.noteWarn} ${styles.emptyLeadLast}`}>
          想让别人能连到这台电脑，先打开本机「允许被远程」。
          <button
            type="button"
            className={`${styles.miniBtnPri} ${styles.ml8}`}
            onClick={onEnableSelf}
          >
            立即打开
          </button>
        </div>
      )}
      {/* UX 审查 P2（2026-09-18）：emoji 会被 SR 念出「桌面计算机」，
          且跨平台渲染不可控——图标 + aria-hidden 才是图标该有的写法。 */}
      <div className={styles.emptyIcon} aria-hidden="true">
        <Monitor size={30} />
      </div>
      <div className={styles.guideTitle}>还没有可远程的设备</div>
      <div className={styles.guideLead}>
        配对后，对方可以申请查看或控制这台电脑；你也可以去控别人的电脑。
      </div>
      {/* B：原来这里还有一句「允许被远程只影响别人控你…」——与主面板底部 foot
          完全重复，且本空态只在「没有任何设备」时出现，解释为时过早。已删。 */}
      <div className={styles.steps}>
        {STEPS.map((s, i) => (
          <div key={s.t} className={styles.step}>
            <div className={styles.stepNum}>{i + 1}</div>
            <div className={styles.stepT}>{s.t}</div>
            <div className={styles.stepD}>{s.d}</div>
          </div>
        ))}
      </div>
      {/* 方案甲：上面那三步讲的是**长期**配对。只想帮一次的人不该先读完三步
          ——两条一次性入口排在三步之后、长期按钮之前，并各自说清代价。 */}
      <div className={styles.emptyActions}>
        <button
          type="button"
          className={styles.miniBtn}
          title="生成一次性帮助码发给对方；他连过来时你要当场点确认"
          onClick={onHelpMe}
        >
          让别人帮我
        </button>
        <button
          type="button"
          className={styles.miniBtn}
          title="粘贴对方发来的一次性帮助码直接连；对方当场确认"
          onClick={onHelpOther}
        >
          帮别人连一次
        </button>
        <button
          type="button"
          className={styles.miniBtn}
          title="无人值守码：对方不在电脑前时预先给你的，会过期、可撤销"
          onClick={onUnoJoin}
        >
          有码，直接连
        </button>
      </div>
      {/* 对齐 Chrome 远程桌面式承诺密度（一行讲完，细节进各钮悬停）；
          「默认留在列表」是乙方案的预期管理，必须常驻可见，不能进 tooltip。 */}
      <div className={styles.foot}>
        前两个<b>不用配对</b>、双方在场；用完默认留在设备列表，随时可删。
      </div>
      <div className={styles.emptyActions}>
        <button type="button" className={styles.miniBtnPri} onClick={onPair}>
          远程配对设备
        </button>
      </div>
    </div>
  );
}
