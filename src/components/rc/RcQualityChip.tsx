/**
 * RcQualityChip — 浮条上的常驻质量读数（2026-09-26 对齐稿，对标 AnyDesk 顶栏）。
 *
 * 数据与 ⓘ 面板同一份（`link.rttMs` EMA + `frames.fps`），零新增采样；
 * 无样本（rtt 未测到）整枚不渲染，不拿 0 充数——与 RcHud 分格口径一致。
 * 着色复用 `rttGrade` 现成分档：good/ok 绿、fair 琥珀、poor 红。
 * 链路死活仍归顶条红灯负责，这里只报网速体感，不重复播报。
 * 点击 = 开合 ⓘ 同一面板（经 rcDetailPanel 单例桥，见该文件头）。
 */
import { rttGrade, rttGradeLabel } from "@/lib/rcSessionStats";
import { toggleRcDetail } from "@/lib/rcDetailPanel";
import styles from "./RemoteComputer.module.css";

export function RcQualityChip({
  rttMs,
  fps,
  tab,
}: {
  rttMs: number;
  fps: number;
  /** 浮条隐藏期间的 tabIndex 锁（与胶囊其余控件同款）。 */
  tab?: number;
}) {
  const grade = rttGrade(rttMs);
  if (grade === "unknown") return null;
  const cls =
    grade === "poor"
      ? styles.qualityChipBad
      : grade === "fair"
        ? styles.qualityChipWarn
        : styles.qualityChipOk;
  return (
    <button
      type="button"
      tabIndex={tab}
      className={`${styles.qualityChip} ${cls}`}
      aria-label="连接质量读数，点击展开连接详情"
      title={`往返 ${rttMs}ms（${rttGradeLabel(grade)}）${fps > 0 ? ` · ${fps}fps` : ""}，点击展开连接详情`}
      onClick={toggleRcDetail}
    >
      <i className={styles.qualityDot} aria-hidden="true" />
      {rttMs}ms{fps > 0 ? ` · ${fps}fps` : ""}
    </button>
  );
}
