import { Clock, UserRound, Info, Workflow, Sparkles, Star, X } from "lucide-react";
import { AiBadge, badgeKindOf } from "@/components/AiBadge";
import { TIcon } from "@/components/transform/TransformIcon";
import type { RecommendReason, Transform } from "@/lib/transforms";
import styles from "../TransformHub.module.css";

/** 理由图标：五种理由各给一个，光看图标就能分出是“常用”还是“被降权” */
function ReasonIcon({ kind }: { kind: RecommendReason["kind"] }) {
  const C =
    kind === "scene" ? Clock
    : kind === "sequence" ? Workflow
    : kind === "role" ? UserRound
    : kind === "quality" || kind === "content" ? Info
    : Sparkles;
  return <C size={10} />;
}

export function TransformCardHead({ t, score, reason, pinned, onTogglePin, onDismiss }: {
  t: Transform;
  score: number;
  reason?: RecommendReason;
  pinned?: boolean;
  onTogglePin?: (actionId: string, next: boolean) => void;
  onDismiss?: (actionId: string) => void;
}) {
  const isRemote = !!t.remote;
  return (
      <div className={styles.cardHead}>
        <span className={styles.cardIcon}><TIcon name={t.icon} /></span>
        <span className={styles.cardMain}>
          <span className={styles.cardLabel}>
            {t.label}
            {/* 显不显示由 remote 决定（风险标记不能漏），写什么字由分组决定 */}
            {isRemote && <AiBadge kind={badgeKindOf(t)} />}
          </span>
          {t.description && <span className={styles.cardDesc}>{t.description}</span>}
          {/* 理由另起一行，不抢描述的位：描述告诉你“这是什么”，
              理由告诉你“为什么给你看”，两者对新老用户各有用 */}
          {reason && (
            <span className={`${styles.why}${reason.kind === "quality" ? ` ${styles.whyMuted}` : ""}`}>
              <ReasonIcon kind={reason.kind} />
              {reason.text}
            </span>
          )}
        </span>
        <span className={styles.score}>{score >= 0.6 ? "适合当前内容" : "可选"}</span>
        {/* v6.14 正向偏好：置顶。摆在「不再推荐」旁边——两者是同一件事的正反面，
            分开摆反而让用户找不到。
            为何需要它：推荐的五个因子里四个吃行为数据，而冷启动时没有行为数据——
            “推荐不准→不用→更不准”的死锁只能由用户直接表达意图来打破。 */}
        {onTogglePin && (
          <button
            className={`${styles.pinBtn}${pinned ? ` ${styles.pinBtnOn}` : ""}`}
            title={pinned ? "取消常用" : "设为常用（排到最前）"}
            aria-label={pinned ? "取消常用" : "设为常用"}
            aria-pressed={!!pinned}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin(t.id, !pinned);
            }}
          >
            <Star size={11} fill={pinned ? "currentColor" : "none"} />
          </button>
        )}
        {/* v6.1 负反馈：不再推荐这个动作（对该内容类型）。点一下从排序里消失 */}
        {onDismiss && (
          <button
            className={styles.dismissBtn}
            title="不再推荐这个"
            aria-label="不再推荐这个"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(t.id);
            }}
          >
            <X size={11} />
          </button>
        )}
      </div>

  );
}
