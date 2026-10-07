import { Fragment } from "react";
import type { useSessionPointer } from "./useSessionPointer";
import { MobileNotice } from "../ui/MobileNotice";
import notice from "../ui/MobileNotice.module.css";
import type { RcConnectStage } from "./rcConnectStage";
import styles from "./RcMobileSession.module.css";

export function SessionModeNotice({ hasFrame, canControl, pointer }: {
  hasFrame: boolean;
  canControl: boolean;
  pointer: Pick<ReturnType<typeof useSessionPointer>, "charging" | "dragging" | "scrolling" | "modeHint">;
}) {
  if (!hasFrame || (canControl && !pointer.charging && !pointer.dragging && !pointer.scrolling)) return null;
  return (
    <div className={styles.modePill} role="status">
      {!canControl
        ? "只看模式 · 输入已关闭"
        : pointer.charging ? "长按已识别 · 松手右键，移动拖拽"
        : pointer.dragging ? "拖拽中 · 点释放拖拽结束"
        : pointer.scrolling ? "滚动中 · 点滚动退出"
        : pointer.modeHint}
    </div>
  );
}

const STAGE_STEPS = ["拨号", "批准", "起画面"] as const;

/** 甲+乙稿：真标水位（public/icon.png 两层，空壳 28% + 按阶段裁 clip-path）+ 步进点 + 路径胶囊。
 *  图标零无限动画（水位换档一次 600ms 过渡），「活着」信号由步进点呼吸承担；文案仍是 rcWaitStage 的。 */
function ConnectStageCard({ text, stage, hint, onReturn }: {
  text: string; stage: RcConnectStage; hint?: string; onReturn: () => void;
}) {
  const detail = [hint, stage.relayExtra].filter(Boolean).join("");
  return (
    <div className={styles.frameWaiting}>
      <section className={`${notice.notice} ${notice.inline}`} data-tone="pending" role="status" aria-atomic="true" aria-busy="true">
        <div className={styles.stageHead}>
          <div className={styles.iconHead} aria-hidden="true">
            <img className={styles.iconShell} src="/icon.png" alt="" width={64} height={64} />
            <img className={`${styles.iconFill} ${styles[`iconFill${stage.stage}`]}`} src="/icon.png" alt="" width={64} height={64} />
          </div>
          <div className={styles.stepper} aria-hidden="true">
            {STAGE_STEPS.map((label, i) => (
              <Fragment key={label}>
                {i > 0 && <span className={styles.stepLine} data-done={String(stage.stage > i)} />}
                <span className={styles.step} data-cur={String(stage.stage === i + 1)} data-done={String(stage.stage > i + 1)}>
                  <i className={styles.dot}>{stage.stage > i + 1 ? "✓" : i + 1}</i>
                  <em>{label}</em>
                </span>
              </Fragment>
            ))}
          </div>
        </div>
        <div className={notice.heading}><strong>{text}</strong></div>
        {stage.pill && <p className={styles.stagePillRow}>
          <span className={`${styles.pathPill} ${stage.pillWarn ? styles.pathPillWarn : ""}`}>{stage.pill}</span>
        </p>}
        {detail && <p className={notice.detail}>{detail}</p>}
        <div className={notice.actions}>
          <button type="button" className={styles.mkKey} onClick={onReturn}>取消连接</button>
        </div>
      </section>
    </div>
  );
}

export function SessionFrameState({ text, hasFrame, hint, stage, onReturn }: {
  text: string | null | undefined;
  hasFrame: boolean;
  /** §17.3：等画面等太久的一句人话（useRcFrames → rcWaitStage 阈值）；空串不出。 */
  hint?: string;
  /** ① 连接建立阶段化（甲+乙稿）：发起链三段时给卡头水位+步进点；被控/未知回退现役卡。 */
  stage?: RcConnectStage | null;
  onReturn: () => void;
}) {
  if (!text) return null;
  if (!hasFrame && stage) return <ConnectStageCard text={text} stage={stage} hint={hint} onReturn={onReturn} />;
  return (
    <div className={hasFrame ? styles.frameNotice : styles.frameWaiting}>
    <MobileNotice compact={hasFrame} tone={hasFrame ? "warning" : "pending"} title={text}
      detail={hint || (hasFrame ? "输入已暂停，收到正常画面后可继续操作。" : undefined)}
      action={<button type="button" className={styles.mkKey} onClick={onReturn}>
        {hasFrame ? "返回设备" : "取消连接"}
      </button>} />
    </div>
  );
}
