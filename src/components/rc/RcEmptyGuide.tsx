/**
 * RcEmptyGuide — 工具箱空态三步引导（L3）。
 */
import styles from "./RemoteComputer.module.css";

const STEPS = [
  { t: "双方配对", d: "一边生成邀请码，另一边粘贴并核对指纹。与知识库同步配对无关。" },
  { t: "发起申请", d: "选「只看」或「可控」，对方会看到确认条与你的指纹。" },
  { t: "对方同意", d: "被控端常驻横幅可随时结束；默认关闭，每次都要点头。" },
];

export function RcEmptyGuide({ onPair }: { onPair: () => void }) {
  return (
    <div className={`${styles.emptyBox} ${styles.emptyBoxLeft}`}>
      <div className={styles.emptyIcon}>🖥️</div>
      <div className={styles.guideTitle}>还没有可远程的设备</div>
      <div className={styles.guideLead}>
        配对后，对方可以申请查看或控制这台电脑；你也可以去控别人的电脑。
      </div>
      <div className={`${styles.guideLead} ${styles.emptyLeadLast}`}>
        「允许被远程」只影响别人控你；发起远程不需要打开它。
      </div>
      <div className={styles.steps}>
        {STEPS.map((s, i) => (
          <div key={s.t} className={styles.step}>
            <div className={styles.stepNum}>{i + 1}</div>
            <div className={styles.stepT}>{s.t}</div>
            <div className={styles.stepD}>{s.d}</div>
          </div>
        ))}
      </div>
      <div className={styles.emptyActions}>
        <button type="button" className={styles.miniBtnPri} onClick={onPair}>
          远程配对设备
        </button>
      </div>
    </div>
  );
}
