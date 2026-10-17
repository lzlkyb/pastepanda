/**
 * 单个变换卡片：选项 + 预览 + 复制/粘贴，自包含、互不干扰。
 * （从 TransformHubDialog 拆出——那个文件已超过项目规则 #7 的 300 行上限）
 *
 * **本地变换与云端动作的关键差异**：
 * - 本地变换挂载即执行，直接出预览（零成本）；
 * - 云端动作（`t.remote`）**绝不自动执行**。照本地那套做的话，用户只是打开
 *   一下面板，剪贴板内容就已经发到外部服务并产生了费用。必须等用户点“运行”。
 *
 * **执行类动作（`t.kind === "action"`）同理且更严格**：run() 有真实副作用
 * （打开浏览器/资源管理器），打开面板就执行等于把系统操作权交给悬停本身。
 * 所以 action 卡片只有「执行」按钮：没有预览、没有复制/粘贴。
 *
 * 另外：复制/粘贴直接用本卡已算出的产物，**不重跑一遍** run()——
 * 本地变换重跑是白费，云端动作重跑是多一次往返。
 */

import { useState } from "react";
import { useTransformPreview } from "@/hooks/useTransformPreview";
import { TransformCardHead } from "./TransformCardHead";
import {
  Copy, Check, ClipboardPaste, Play, ShieldAlert, Loader2,
} from "lucide-react";
import { useDialogStore } from "@/stores/dialogStore";
import { openAiSettings } from "@/lib/openAiSettings";

/** v6.4 审查：#10 预算超限 → 关枢纽并跳到设置 AI tab */
async function goAdjustBudget() {
  useDialogStore.getState().closeHub();
  await openAiSettings();
}
import type { RecommendReason, Transform, TransformOptionSpec, TransformResultMeta } from "@/lib/transforms";
import { parseReplyCandidates } from "@/lib/replyCandidates";
import { ReplyCandidates } from "@/components/transform/ReplyCandidates";
import { AiResult } from "@/components/transform/AiResult";
// FollowupInput 已从 AiQuickBar.tsx 独立成文件（本处与 AI 快捷栏共用，
// 再寄在对方组件里会在拆子组件时变成环依赖）
import { FollowupInput } from "@/components/ai/FollowupInput";
import { useAiStatus } from "@/hooks/useAiStatus";
import { countChars, estimateTokens } from "@/lib/utils";
import styles from "../TransformHub.module.css";

export function TransformCard({
  t, score, text, opts, html, userTags, specs, copied, onSetOpt, onCopy, onPaste, onDismiss, reason,
  pinned, onTogglePin,
}: {
  t: Transform;
  score: number;
  /** 推荐理由（“为什么排这里”）。冷启动 / 无主导因子时不传 */
  reason?: RecommendReason;
  text: string;
  opts: Record<string, string>;
  /** P2：doc/rich 条目的 HTML 片段，透传给变换 run() */
  html?: string;
  /**
   * 条目的手工标签名（已拼串）。跟 `html` 走同一条路：本组件拿不到 item，
   * 由 hub 上层传下来，在两处 `t.run` 里当成 opts 带给后端（见 lib/aiTags.ts）。
   */
  userTags?: string;
  specs: TransformOptionSpec[];
  copied: boolean;
  onSetOpt: (key: string, value: string) => void;
  onCopy: (output: string, meta?: TransformResultMeta) => void;
  onPaste: (output: string) => void;
  /** v6.1：当前内容类型，供「不再推荐这个」记录 (动作, 类型) */
  contentType?: string;
  /** v6.1：点击「不再推荐这个」后回调（父组件刷新排序） */
  onDismiss?: (actionId: string) => void;
  /** v6.14：该动作是否已被置顶 */
  pinned?: boolean;
  /**
   * v6.14：切换置顶。与 `onDismiss` 一正一负，所以按钮也摆在一起。
   *
   * `next` 由调用方算好传进来，不让卡片自己取反：置顶状态的真相在
   * `recommend.ts` 的模块级缓存里，卡片只是展示层。
   */
  onTogglePin?: (actionId: string, next: boolean) => void;
}) {
  const isRemote = !!t.remote;
  const isAction = t.kind === "action";
  const { preview, execute, runFollowup } = useTransformPreview({ t, text, opts, html, userTags });
  const [sendOpen, setSendOpen] = useState(false);
  const aiStatus = useAiStatus();
  const hasOutput = preview.state === "ok";

  // 六大王牌 F：回复草稿的结果可能是多语气候选（---标题--- 分隔）。
  // 审查：按动作 id 触发（而不是按输出形状嗅探）——别的动作恰好输出两个 "---" 标题
  // 不会被误切成候选卡（且候选路径丢失编辑/反馈/截断提示）。
  const previewCandidates =
    preview.state === "ok" && t.id === "ai-reply-draft" ? parseReplyCandidates(preview.output) : [];
  const isMultiCandidate = previewCandidates.length > 1;

  return (
    <div className={styles.card}>
      <TransformCardHead t={t} score={score} reason={reason} pinned={pinned}
        onTogglePin={onTogglePin} onDismiss={onDismiss} />

      {specs.length > 0 && (
        <div className={styles.cardOpts}>
          {specs.map((spec) => (
            <div key={spec.key} className={styles.optGroup}>
              <span className={styles.optLabel}>{spec.label}</span>
              {spec.values.map((v) => (
                <button
                  key={v.value}
                  className={`${styles.chip} ${(opts[spec.key] ?? spec.default) === v.value ? styles.chipOn : ""}`}
                  onClick={() => onSetOpt(spec.key, v.value)}
                >
                  {v.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {preview.state === "idle" && (
        isRemote ? (
          /*
           * B1 待发送内容卡。改之前这里只有一句“点运行后才会发送到云端”，
           * 用户把面板打开放一会儿就忘了要发的到底是哪条内容；
           * 而且那句提示用的是 .cardPreview（绿色成功框），语义是反的。
           */
          <div className={styles.willSend}>
            <button
              className={styles.wsHead}
              onClick={() => setSendOpen((v) => !v)}
              aria-expanded={sendOpen}
            >
              ↑ 运行后将发送以下内容
              {aiStatus.model && <span className={styles.runModel}>{aiStatus.model}</span>}
              <span className={styles.wsFold}>{sendOpen ? "收起 ▴" : "展开 ▾"}</span>
            </button>
            <div className={`${styles.wsBody}${sendOpen ? "" : ` ${styles.wsBodyFold}`}`}>
              {text}
            </div>
            <div className={styles.wsFoot}>
              <span className={styles.wsPill}>{countChars(text)} 字</span>
              {/* 必须带“≈”：真实分词由各家 tokenizer 决定，这只是量级参考 */}
              <span className={styles.wsPill}>≈ {estimateTokens(text)} token</span>
              <span>内容不会自动上传，只在你点运行时发一次</span>
            </div>
          </div>
        ) : (
          <pre className={styles.cardPreview}>点「执行」后才会打开/定位。</pre>
        )
      )}
      {preview.state === "loading" && (
        isRemote ? (
          /* v6.4：AI 动作运行态 —— accent spinner + 「AI 思考中…」；v6.10 流式打字机 */
          preview.streamText ? (
            <div className={styles.streamBox}>
              {preview.streamText}
              <span className={styles.caret} aria-hidden="true" />
            </div>
          ) : (
            /*
             * A2：首个 token 到达前的等待态。云端首字延迟常在 1~3 秒，推理模型更久，
             * 这段时间以前只有一个**不转的**图标加一行静止文字（.spin 当时没有全局定义）。
             * 现在：旋转图标 + 三点跳动 + 模型名 + 一根流光骨架占住结果区。
             */
            <>
              <div className={styles.aiRunning}>
                <Loader2 size={13} className="spin" />
                <span>AI 思考中</span>
                <span className={styles.dots} aria-hidden="true">
                  <i /><i /><i />
                </span>
                {aiStatus.model && <span className={styles.runModel}>{aiStatus.model}</span>}
              </div>
              <div className={`${styles.streamBox} ${styles.skelBox}`} aria-hidden="true">
                <div className={styles.skel} />
              </div>
            </>
          )
        ) : (
          <pre className={styles.cardPreview}>{isAction ? "执行中…" : "转换中…"}</pre>
        )
      )}
      {preview.state === "done" && (
        <pre className={styles.cardPreview}>已执行 ✓</pre>
      )}
      {preview.state === "ok" && (
        <>
          {isMultiCandidate ? (
            <ReplyCandidates
              candidates={previewCandidates}
              onCopy={(o) => onCopy(o, preview.meta)}
              onPaste={onPaste}
            />
          ) : isRemote ? (
            <AiResult
              t={t}
              output={preview.output}
              meta={preview.meta}
              copied={copied}
              onCopy={onCopy}
              onPaste={onPaste}
            />
          ) : (
            <pre className={styles.cardPreview}>{preview.output}</pre>
          )}

          {/* v6.10 追问：云端动作结果下叠加轮次 + 追问输入（复用 AiQuickBar 的 FollowupInput） */}
          {isRemote && (preview.followQs ?? []).length > 0 && (
            <div className={styles.followTurns}>
              {(preview.followQs ?? []).map((q, i) => (
                <div key={i} className={styles.followTurn}>
                  <div className={styles.followQ}>{q}</div>
                  {i < (preview.followAs ?? []).length && (
                    <pre className={styles.followA}>{(preview.followAs ?? [])[i]}</pre>
                  )}
                  {i === (preview.followQs ?? []).length - 1 && preview.followPending && (
                    <div className={styles.followPending}>
                      <Loader2 size={11} className="spin" /> 处理中…
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {isRemote && (
            <FollowupInput
              className={styles.tcFollow}
              disabled={!!preview.followPending}
              onSubmit={(q) => void runFollowup(q)}
            />
          )}
        </>
      )}
      {preview.state === "err" && (
        <>
          <pre className={preview.needsConfirm ? styles.previewWarn : styles.previewErr}>
            {preview.needsConfirm && <ShieldAlert size={12} />} {preview.message}
          </pre>
          {/* v6.4 审查：#10 预算超限给操作入口：去设置调高 */}
          {preview.budgetExceeded && (
            <div className={styles.budgetRow}>
              <button
                className={styles.budgetBtn}
                onClick={() => (preview.isQuota ? useDialogStore.getState().openQuota() : void goAdjustBudget())}
              >
                {preview.isQuota ? "去签到 / 兑换" : "去调整每日预算"}
              </button>
            </div>
          )}
        </>
      )}

      <div className={styles.cardActions}>
        {/* 执行类动作：只有「执行」，无预览/复制/粘贴 */}
        {isAction && (
          <>
            {preview.state !== "done" ? (
              <button
                className={styles.runBtn}
                onClick={() => void execute(false)}
                disabled={preview.state === "loading"}
              >
                <Play size={13} />
                {preview.state === "loading" ? "执行中…" : "执行"}
              </button>
            ) : (
              <button className={styles.runBtn} onClick={() => void execute(false)}>
                <Play size={13} />重新执行
              </button>
            )}
          </>
        )}

        {/* 云端动作：先有“运行”，跑完才能复制/粘贴 */}
        {!isAction && isRemote && preview.state !== "ok" && (
          <button
            className={styles.runBtn}
            onClick={() => void execute(preview.state === "err" && !!preview.needsConfirm)}
            disabled={preview.state === "loading"}
          >
            {preview.state === "err" && preview.needsConfirm ? (
              <><ShieldAlert size={13} />仍然发送</>
            ) : (
              /* 文案写成“运行并发送”：点下去会发生什么就写在按钮上，
                 不靠旁边那句提示字去提醒 */
              <><Play size={13} />运行并发送</>
            )}
          </button>
        )}
        {!isAction && isRemote && preview.state === "ok" && (
          <button className={styles.runBtn} onClick={() => void execute(false)}>
            <Play size={13} />重新运行
          </button>
        )}

        {/* 本地变换的复制/粘贴（AI 单结果在 AiResult 里、多候选在候选块里各自有） */}
        {!isAction && !isMultiCandidate && !isRemote && (
          <>
            <button
              className={`${styles.copyBtn} ${copied ? styles.copyBtnDone : ""}`}
              onClick={() => hasOutput && onCopy(preview.output, preview.meta)}
              disabled={!hasOutput}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? "已复制" : "复制"}
            </button>
            <button
              className={styles.pasteBtn}
              onClick={() => hasOutput && onPaste(preview.output)}
              disabled={!hasOutput}
            >
              <ClipboardPaste size={13} />
              粘贴到前台
            </button>
          </>
        )}
      </div>
    </div>
  );
}
