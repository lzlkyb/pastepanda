/**
 * AiQuickResult —— 单个动作的结果卡，四态：loading / confirm / error / done
 * （从 AiQuickBar 抽出，规则 #7）。
 *
 * 本组件**只负责渲染**，一行异步与状态变更都没有：所有动作回调都从
 * useAiQuickRun 给的 `run` 里取。一整包传而不拆成八个 props，是因为它们本来
 * 就是同一个编排器的对外面，拆开只会让调用处多八行而不多任何信息。
 */
import { Loader2, Copy, ClipboardPaste, ShieldAlert, ChevronUp, ChevronDown } from "lucide-react";
import { openAiSettings } from "@/lib/openAiSettings";
import type { QuickAction } from "@/lib/aiQuick";
import type { AiQuickRun } from "@/hooks/useAiQuickRun";
import { FollowupInput } from "./FollowupInput";
import type { ActionState } from "./quickTypes";
import styles from "../AiQuickBar.module.css";

export function AiQuickResult({
  action: a,
  state: st,
  text,
  run,
}: {
  action: QuickAction;
  state: ActionState;
  /** 处理前的原文（还原 / 复制 / 粘贴时用） */
  text: string;
  run: AiQuickRun;
}) {
  if (st.status === "loading") {
    return (
      <div className={styles.resultBar}>
        {/* 流式：有增量 → 打字机；还没到第一块 → 转圈 */}
        {st.streamText ? (
          <div className={styles.streamBox}>
            {st.streamText}
            <span className={styles.caret} aria-hidden="true" />
          </div>
        ) : (
          <div className={styles.thinking}>
            <Loader2 size={13} className="spin" /> {a.ai ? "AI 思考中…" : "处理中…"}
          </div>
        )}
      </div>
    );
  }

  if (st.status === "confirm") {
    return (
      <div className={`${styles.gateBar} ${styles.sens}`}>
        <ShieldAlert size={12} />
        <span>{st.message || "内容可能包含敏感信息"}</span>
        <button className={styles.gbBtn} onClick={() => void run.runAction(a, true)}>
          确认发送
        </button>
        <button className={styles.gbBtn} onClick={() => run.cancelConfirm(a.id)}>
          取消
        </button>
      </div>
    );
  }

  if (st.status === "error") {
    return (
      <div className={`${styles.gateBar} ${styles.err}`}>
        <span>{st.message}</span>
        {/* 出错一律给出口：以前只有文案里带「预算」二字才有按钮，
            「未配置 API Key」这种明明可操作的错反而让用户自己猜去哪配。
            分类用结构化的 errKind，不再 includes 文案。 */}
        <button className={styles.gbBtn} onClick={() => void openAiSettings()}>
          {st.errKind === "budget" ? "去调整预算" : "去设置 AI"}
        </button>
      </div>
    );
  }

  // done
  const shown = st.reverted ? text : (st.output ?? "");
  const followQs = st.followQs ?? [];
  const followAs = st.followAs ?? [];

  return (
    <div className={styles.resultBar}>
      {/* 结果卡头部：类型标签 + 动作名 + meta chip + 收起按钮 */}
      <div className={styles.rhead}>
        {a.ai ? (
          <span className={styles.aiMark} aria-hidden="true">✦</span>
        ) : (
          <span className={styles.locTag} aria-hidden="true">本地</span>
        )}
        <span className={styles.rName}>
          {a.label}
          {st.reverted ? "（已还原）" : ""}
        </span>
        <span className={styles.rmeta}>
          {st.meta?.model ? <span className={styles.rModel}>{st.meta.model}</span> : null}
          {st.meta?.cached && <span className={`${styles.metaChip} ${styles.metaCached}`}>缓存命中</span>}
          {st.meta?.truncated && <span className={`${styles.metaChip} ${styles.metaTrunc}`}>⚠ 截断</span>}
        </span>
        <button
          className={styles.rCollapse}
          onClick={() => run.toggleCollapse(a.id)}
          title={st.collapsed ? "展开结果" : "收起结果"}
        >
          {st.collapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        </button>
      </div>

      {!st.collapsed && (
        <>
          <div className={styles.rbody}>{shown}</div>

          {/* 追问：多轮叠加（同卡左缩进） */}
          {followQs.length > 0 && (
            <div className={styles.turnBox}>
              {followQs.map((q, i) => (
                <div key={i} className={styles.turnGroup}>
                  <div className={styles.turnQ}>{q}</div>
                  {i < followAs.length && <div className={styles.turnA}>{followAs[i]}</div>}
                  {i === followQs.length - 1 && st.followPending && (
                    <div className={styles.turnPending}>
                      <Loader2 size={11} className="spin" /> 处理中…
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 追问输入框（只给出网动作——本地动作无需追问） */}
          {a.ai && !st.reverted && (
            <FollowupInput
              disabled={!!st.followPending}
              onSubmit={(q) => void run.runFollowup(a, q)}
            />
          )}

          <div className={styles.racts}>
            <button className={styles.rb} onClick={() => void run.copy(a, shown)}>
              <Copy size={11} /> 复制
            </button>
            <button className={`${styles.rb} ${styles.rbPri}`} onClick={() => void run.paste(a, shown)}>
              <ClipboardPaste size={11} /> 粘贴到前台
            </button>
            {a.ai && !st.reverted && (
              <button
                className={`${styles.rb} ${styles.rbMore}`}
                onClick={() => run.continueWith(a)}
                title="把结果作为输入，打开变换中心继续处理"
              >
                ▸ 继续处理…
              </button>
            )}
            {a.ai && (
              <button
                className={`${styles.rb} ${styles.rbGhost}`}
                onClick={() => run.revert(a)}
                disabled={st.reverted}
              >
                {st.reverted ? "✓ 已还原" : "↺ 还原原文"}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
