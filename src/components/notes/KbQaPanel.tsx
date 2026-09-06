/**
 * KbQaPanel.tsx —— 知识库问答面板（B2 #10b）。
 *
 * **宽屏占第三栏、窄屏接管中栏**，两边共用本组件；不同的只是「占哪一栏」。
 * 窄屏曾经走弹窗，已废：弹窗要背 portal / FocusTrap / z-index / 滚动锁一整套，
 * 而窄屏本来就只有一栏，「占一整栏」的正确形态就是**接管它**。形态依据：
 * NotebookLM 把 Chat 放中间**整栏**，Obsidian Copilot 用**右侧全高 sidebar**——
 * 没人把答案塞进列表上方的小盒子（#10 初版就是那个错形态）。
 *
 * 纯展示层：拿 `useKbQa` 的会话画出来，不自己发请求。
 */
import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Sparkles, X, Loader2, CornerDownLeft, ArrowLeft, Minus } from "lucide-react";
import { useAutoGrow } from "@/hooks/useAutoGrow";
import type { KbQaSession } from "@/hooks/useKbQa";
import { QA_MAX_QUESTION_CHARS } from "@/lib/notes/kbQa";
import { KbQaTurn } from "./KbQaTurn";
import styles from "./KbQaPanel.module.css";

export function KbQaPanel({
  session,
  scopeLabel,
  busy,
  onAsk,
  onConfirm,
  onClose,
  onOpenNote,
  onBack,
  onCollapse,
  variant = "pane",
}: {
  session: KbQaSession;
  /**
   * 宿主：`pane` = 宽屏第三栏（带左分割线）；`inline` = 窄屏接管中栏。
   *
   * 两边是**同一语义**：回答占一整栏。窄屏那栏就是全部，所以不需要
   * portal / FocusTrap / z-index 那一套——这也是它比弹窗强的地方。
   */
  variant?: "pane" | "inline";
  /** 窄屏下的「← 返回列表」。不传就不渲染（宽屏不需要：列表一直在旁边） */
  onBack?: () => void;
  /**
   * 折叠回答区（A-61 ①）。不传就不渲染那个「–」。
   *
   * ❗ 与✕ 的区别必须看得出来：**折叠不丢会话**（收成一行胶囊，点一下回来），
   *   而✕ 是清掉整段问答。两个按钮紧挨着，图标得分得开（– vs ✕）。
   */
  onCollapse?: () => void;
  /** 人读的范围说明。筛着一个文件夹没命中时，不写它用户会以为全库都没有 */
  scopeLabel: string;
  busy: boolean;
  onAsk: (question: string) => void;
  onConfirm: () => void;
  onClose: () => void;
  onOpenNote: (noteId: string) => void;
}) {
  const [followup, setFollowup] = useState("");
  /** 追问框随内容长高（A-61 ②）。与工具栏提问框同一份逻辑（规则 #11）。 */
  // ❗ 把面板自身交给 `useAutoGrow`：追问框的上限跟面板高度走（面板高 40%，
  //   夹在 3~10 行）。三栏时第三栏还要再上下切一刀，写死 4 行在那儿太短；
  //   而写死成更大的行数又会在矮面板下把答案区吃光（`.foot` 是 flex-shrink:0）。
  const paneRef = useRef<HTMLDivElement>(null);
  const askRef = useAutoGrow(followup, { containerRef: paneRef });
  const scrollRef = useRef<HTMLDivElement>(null);
  const { turns, pending } = session;

  // 新内容来了就滚到底。不做的话流式出字时得自己不断手动滚。
  // 依赖里带上流式长度：不带的话只在轮次变化时滚一次，流式过程中就不跟了。
  const streamedLen = pending?.kind === "running" ? pending.streamed.length : 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, pending?.kind, streamedLen]);

  const submit = () => {
    const q = followup.trim();
    if (!q || busy) return;
    setFollowup("");
    onAsk(q);
  };

  /* 进场动画分 variant：
     - `pane`（宽屏第三栏）：从右滑进，方向与它所在的那侧一致；
     - `inline`（窄屏接管中栏）：**只淡入**。它是原地把列表换成问答，
       再加水平位移会读成「又开了一层」，而它并没有层级——回去靠的是「← 返回列表」。 */
  return (
    <motion.div
      ref={paneRef}
      className={variant === "inline" ? `${styles.pane} ${styles.inline}` : styles.pane}
      initial={{ opacity: 0, x: variant === "pane" ? 8 : 0 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
    >
      <div className={styles.hd}>
        {/* 窄屏：回答接管了唯一那栏，必须有路回列表——否则就是个回不去的页面 */}
        {onBack && (
          <button type="button" className={styles.back} onClick={onBack}>
            <ArrowLeft size={12} /> 返回列表
          </button>
        )}
        <Sparkles size={12} />
        <span>问知识库</span>
        {/* 折叠在✕ 左边：它是「轻」的那个，而且用户要的往往是它而不是✕。
            `marginLeft: auto` 在✕ 上，所以这一个不用自己靠右。 */}
        {onCollapse && (
          <button
            type="button"
            className={styles.collapse}
            onClick={onCollapse}
            title="收起回答（不丢弃问答）"
            aria-label="收起回答"
          >
            <Minus size={13} />
          </button>
        )}
        <button type="button" className={styles.close} onClick={onClose} aria-label="关闭问答">
          <X size={13} />
        </button>
      </div>

      <div className={styles.scroll} ref={scrollRef}>
        {turns.map((t, i) => (
          <KbQaTurn
            key={`${i}-${t.question}`}
            question={t.question}
            answer={t.answer}
            refs={t.refs}
            cached={t.cached}
            truncated={t.truncated}
            onOpenNote={onOpenNote}
          />
        ))}

        {/* 正在跑：有流式就直接当一轮渲染（带光标）；
            本地厂商不发流，此时 streamed 为空串 → 退回转圈，不能卡着不动 */}
        {pending?.kind === "running" &&
          (pending.streamed ? (
            <KbQaTurn
              question={pending.question}
              answer={pending.streamed}
              refs={[]}
              streaming
              onOpenNote={onOpenNote}
            />
          ) : (
            <div className={styles.turn}>
              <div className={styles.qline}>{pending.question}</div>
              <div className={styles.state}>
                <Loader2 size={12} className="spin" /> 正在问…
              </div>
            </div>
          ))}

        {pending?.kind === "empty" && (
          <div className={styles.turn}>
            <div className={styles.qline}>{pending.question}</div>
            <div className={styles.answer}>知识库中没有相关笔记。</div>
            {/* 说清“未发请求”：否则用户会以为这一次也花了钱 */}
            <div className={styles.hint}>未发送任何请求。</div>
          </div>
        )}

        {pending?.kind === "confirm" && (
          <div className={styles.turn}>
            <div className={styles.qline}>{pending.question}</div>
            <div className={styles.answer}>{pending.reason}</div>
            <div className={styles.actions}>
              <button type="button" className={styles.btnPrimary} onClick={onConfirm}>
                仍要发送
              </button>
              <button type="button" className={styles.btn} onClick={onClose}>
                取消
              </button>
            </div>
          </div>
        )}

        {pending?.kind === "error" && (
          <div className={styles.turn}>
            <div className={styles.qline}>{pending.question}</div>
            <div className={`${styles.answer} ${styles.err}`}>{pending.message}</div>
          </div>
        )}
      </div>

      <div className={styles.foot}>
        <div className={styles.scope}>当前范围：{scopeLabel}</div>
        <div className={styles.askRow}>
          {/* ❗ `textarea` 而不是 `input`（A-61 ②）：追问同样会写长。
              只改上面工具栏那个、这里留单行，就是新的不一致（规则 #11）。 */}
          <textarea
            ref={askRef}
            className={styles.askInput}
            value={followup}
            rows={1}
            maxLength={QA_MAX_QUESTION_CHARS}
            /* 追问期间禁用：`ai-run-chunk` 的 payload 没有 per-call id，
               同时跑两轮会两路 delta 混在一起（useAiStream 自述限制 2） */
            disabled={busy}
            onChange={(e) => setFollowup(e.target.value)}
            onKeyDown={(e) => {
              // ❗ `isComposing` 必须守：中文输入法选字的 Enter 不能当提交。
              //   Shift+Enter 留给换行，所以只在不带 Shift 时 preventDefault。
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                // 不拦的话发送同时还会往框里插一个换行。
                e.preventDefault();
                submit();
              }
            }}
            placeholder={busy ? "正在回答…" : "追问一句…（回车发送，Shift+回车换行）"}
            aria-label="追问"
          />
          <button
            type="button"
            className={styles.askBtn}
            onClick={submit}
            disabled={busy || !followup.trim()}
            aria-label="发送追问"
          >
            <CornerDownLeft size={12} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
