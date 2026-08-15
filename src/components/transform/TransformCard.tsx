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

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Copy, Check, Sparkles, Database, Table, List, ClipboardPaste,
  CaseUpper, CaseLower, Eraser, Pilcrow, Quote, RemoveFormatting, Link as LinkIcon,
  Globe, Mail, Phone, Code, Minus, Hash, Palette, Folder, FileText,
  Play, ShieldAlert, Languages, PenLine, Search, X, Loader2,
  Clock, UserRound, Info, Workflow, Star,
  type LucideIcon,
} from "lucide-react";
import { AiBadge, badgeKindOf } from "@/components/AiBadge";
import { useDialogStore } from "@/stores/dialogStore";
import { openAiSettings } from "@/lib/openAiSettings";

/** v6.4 审查：#10 预算超限 → 关枢纽并跳到设置 AI tab */
async function goAdjustBudget() {
  useDialogStore.getState().closeHub();
  await openAiSettings();
}
import type { RecommendReason, Transform, TransformOptionSpec, TransformResultMeta } from "@/lib/transforms";
import { getTransform } from "@/lib/transforms";
import { parseReplyCandidates } from "@/lib/replyCandidates";
import { ReplyCandidates } from "@/components/transform/ReplyCandidates";
import { AiResult } from "@/components/transform/AiResult";
import { onAiChunk, ensureAiChunkListener } from "@/lib/useAiStream";
// FollowupInput 已从 AiQuickBar.tsx 独立成文件（本处与 AI 快捷栏共用，
// 再寄在对方组件里会在拆子组件时变成环依赖）
import { FollowupInput } from "@/components/ai/FollowupInput";
import { useToast } from "@/components/Toast";
import { useAiStatus } from "@/hooks/useAiStatus";
import { countChars, estimateTokens } from "@/lib/utils";
import styles from "../TransformHub.module.css";

/** 图标语义键 → lucide 组件（逻辑层保持纯净，图标在 UI 层映射） */
const ICONS: Record<string, LucideIcon> = {
  database: Database, table: Table, rows: List,
  "case-upper": CaseUpper, "case-lower": CaseLower, eraser: Eraser, pilcrow: Pilcrow,
  quote: Quote, "remove-formatting": RemoveFormatting, link: LinkIcon, globe: Globe,
  mail: Mail, phone: Phone, code: Code, minus: Minus, hash: Hash, palette: Palette,
  folder: Folder, "file-text": FileText, search: Search,
  // AI 动作的图标语义键（后端 ai/actions.rs 里声明的那几个）
  languages: Languages, "pen-line": PenLine,
};

export function TIcon({ name, size = 15 }: { name?: string; size?: number }) {
  const C = (name && ICONS[name]) || Sparkles;
  return <C size={size} />;
}

/** 理由图标：五种理由各给一个，光看图标就能分出是“常用”还是“被降权” */
function ReasonIcon({ kind }: { kind: RecommendReason["kind"] }) {
  const C =
    kind === "scene" ? Clock
    : kind === "sequence" ? Workflow
    : kind === "role" ? UserRound
    : kind === "quality" ? Info
    : Sparkles;
  return <C size={10} />;
}

type Preview =
  /** 云端动作/执行类动作：等用户点“运行/执行”，在那之前什么都不发 */
  | { state: "idle" }
  | { state: "loading"; streamText?: string }
  | {
      state: "ok";
      output: string;
      meta?: TransformResultMeta;
      /** v6.10 追问：多轮问题/答案 */
      followQs?: string[];
      followAs?: string[];
      followPending?: boolean;
    }
  /** 仅执行类动作：run() 成功但无产物（副作用已完成） */
  | { state: "done" }
  | {
      state: "err";
      message: string;
      /** 内容看起来是密钥，后端拒发了，等用户确认 */
      needsConfirm?: boolean;
      budgetExceeded?: boolean;
      /** v6.9：内置免费额度不足（引导签到/兑换而非调预算） */
      isQuota?: boolean;
    };

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
  const { toast } = useToast();
  const [preview, setPreview] = useState<Preview>(
    isRemote || isAction ? { state: "idle" } : { state: "loading" }
  );
  /** B1：待发送内容默认收起为一行——变换中心常常同屏多张卡，全部展开会把面板撑得很长 */
  const [sendOpen, setSendOpen] = useState(false);
  /** 当前模型名（运行条与待发送卡都要显）。
   *  用已有的可用性快照（30s TTL 缓存、已被其它组件订阅），**不新增任何请求**。
   *  注：它只有模型名，没有服务商显示名；拿后者要额外调 aiListProviders()，
   *  为一个辅助信息每张卡多一次请求不值得。 */
  const aiStatus = useAiStatus();
  // 审查：execute 竞态防护 —— 远程动作运行中用户改 chip/OCR 更新文本，
  // 旧请求晚到会覆盖新上下文的结果；代际计数让过期结果直接丢弃。
  const runSeqRef = useRef(0);

  const execute = useCallback(
    async (force: boolean) => {
      const seq = ++runSeqRef.current;
      setPreview({ state: "loading", streamText: "" });
      // v6.10 流式：远程动作注册增量监听（打字机）。
      // 先 await 监听就绪再发请求（同 AiQuickBar）：listen() 异步注册，不等会丢首次开头几块
      if (isRemote) await ensureAiChunkListener();
      const offStream = isRemote
        ? onAiChunk(t.id, (d) => {
            if (runSeqRef.current !== seq) return;
            setPreview((p) =>
              p.state === "loading"
                ? { state: "loading", streamText: (p.streamText ?? "") + d }
                : p
            );
          })
        : () => {};
      const r = await t.run(text, {
        ...opts,
        ...(html ? { html } : {}),
        ...(userTags ? { userTags } : {}),
        ...(force ? { force: true } : {}),
      });
      offStream();
      if (runSeqRef.current !== seq) return; // 有新请求/内容变化，丢弃过期结果
      if (r.ok && r.output !== undefined) {
        setPreview({ state: "ok", output: r.output, meta: r.meta });
      } else if (r.ok && isAction) {
        // 执行类动作：ok 但无产物 = 副作用已完成
        setPreview({ state: "done" });
      } else {
        setPreview({
          state: "err",
          message: r.message ?? "无法转换",
          needsConfirm: r.meta?.needsConfirm === true,
          budgetExceeded: r.meta?.budgetExceeded === true,
          isQuota: r.meta?.isQuota === true,
        });
      }
    },
    [t, text, opts, html, userTags, isAction, isRemote]
  );

  // v6.10 追问：对云端动作结果继续处理（ai-followup）
  const runFollowup = useCallback(
    async (q: string) => {
      if (preview.state !== "ok" || preview.followPending) return;
      const ft = getTransform("ai-followup");
      if (!ft) {
        toast(`追问暂不可用：${"AI 服务未就绪"}`, "error");
        return;
      }
      setPreview((p) =>
        p.state === "ok"
          ? { ...p, followPending: true, followQs: [...(p.followQs ?? []), q] }
          : p
      );
      const content = `${q}\n\n（上次结果）\n${preview.output}`;
      try {
        const r = await ft.run(content);
        setPreview((p) => {
          if (p.state !== "ok") return p;
          const answers = [...(p.followAs ?? [])];
          if (r.ok && r.output !== undefined) answers.push(r.output);
          else answers.push(`（追问失败：${r.message ?? "未知错误"}）`);
          return { ...p, followPending: false, followAs: answers };
        });
      } catch (e) {
        setPreview((p) =>
          p.state === "ok"
            ? {
                ...p,
                followPending: false,
                followAs: [...(p.followAs ?? []), `（追问失败：${typeof e === "string" ? e : "未知错误"}）`],
              }
            : p
        );
      }
    },
    [preview, toast]
  );

  useEffect(() => {
    // 审查：内容/选项变化 → 作废在途 execute（旧请求晚到不再覆盖新结果）
    runSeqRef.current += 1;
    // 云端动作 / 执行类动作：不自动跑。前者避免打开面板就发内容花钱，
    // 后者避免打开面板就执行副作用（打开浏览器/资源管理器）。
    if (isRemote || isAction) {
      setPreview({ state: "idle" });
      return;
    }
    let cancelled = false;
    const result = t.run(text, { ...opts, ...(html ? { html } : {}), ...(userTags ? { userTags } : {}) });
    if (result instanceof Promise) {
      setPreview({ state: "loading" });
      result.then((r) => {
        if (cancelled) return;
        setPreview(
          r.ok && r.output !== undefined
            ? { state: "ok", output: r.output, meta: r.meta }
            : { state: "err", message: r.message ?? "无法转换" }
        );
      });
    } else {
      setPreview(
        result.ok && result.output !== undefined
          ? { state: "ok", output: result.output, meta: result.meta }
          : { state: "err", message: result.message ?? "无法转换" }
      );
    }
    return () => { cancelled = true; };
  }, [t, text, opts, html, userTags, isRemote, isAction]);

  const hasOutput = preview.state === "ok";

  // 六大王牌 F：回复草稿的结果可能是多语气候选（---标题--- 分隔）。
  // 审查：按动作 id 触发（而不是按输出形状嗅探）——别的动作恰好输出两个 "---" 标题
  // 不会被误切成候选卡（且候选路径丢失编辑/反馈/截断提示）。
  const previewCandidates =
    preview.state === "ok" && t.id === "ai-reply-draft" ? parseReplyCandidates(preview.output) : [];
  const isMultiCandidate = previewCandidates.length > 1;

  return (
    <div className={styles.card}>
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
        <span className={styles.score}>{Math.round(score * 100)}%</span>
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
              <div className={styles.aiRunning} style={{ marginBottom: 7 }}>
                <Loader2 size={13} className="spin" />
                <span>AI 思考中</span>
                <span className={styles.dots} aria-hidden="true">
                  <i /><i /><i />
                </span>
                {aiStatus.model && <span className={styles.runModel}>{aiStatus.model}</span>}
              </div>
              <div className={`${styles.streamBox} ${styles.skelBox}`} aria-hidden="true">
                <div className={styles.skel} style={{ width: "62%" }} />
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
