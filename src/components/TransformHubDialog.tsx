/**
 * TransformHubDialog.tsx —— 变换枢纽（卡片流，方案 A）。
 *
 * 由右键「变换为…」经 dialogStore.openHub(item) 打开：
 * 把当前内容命中的所有注册变换（applicableTransforms，按匹配度排序）
 * 逐个渲染为独立卡片——每张卡自带选项 chip、实时预览、复制 / 粘贴按钮。
 *
 * 交互模型（针对"悬停即选中 → 待复制内容被误切换"的修复）：
 * - 没有全局"选中态"，鼠标悬停只高亮卡片边框，不改变任何待复制内容；
 * - 每张卡的复制按钮只复制本卡产物，复制后不关闭，可连续复制多个；
 * - Esc 关闭。
 *
 * 卡片本体已拆到 `transform/TransformCard.tsx`（本文件曾超过项目规则 #7 的 300 行上限）。
 *
 * 挂载方式仿 ExtractDialog（常挂载 + 内部 AnimatePresence 门控退场动画）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Sparkles, Loader2, RotateCw, Workflow, Lock, QrCode } from "lucide-react";
import { AiMark } from "@/components/ai/AiMark";
import { useDialogStore } from "@/stores/dialogStore";
import { confirmDialog } from "@/lib/confirm";
import {
  type ScoredTransform,
  type Transform,
  type TransformContext,
  type TransformResultMeta,
} from "@/lib/transforms";
import { isPinnedAction, recommendScored, sceneOf } from "@/lib/recommend";
import { manualTagsOpt } from "@/lib/aiTags";
import { ocrImage, pasteTextGuarded } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import { MelodyEmpty } from "@/components/MelodyEmpty";
import { TransformCard } from "@/components/transform/TransformCard";
import { CodecEditor } from "@/components/editors/CodecEditor";
import { QREditor } from "@/components/editors/QREditor";
import { NlCommandBar } from "@/components/NlCommandBar";
import { requestPlannedChain } from "@/lib/chains/planRequest";
import { isAiAvailable } from "@/lib/transforms/aiTransforms";
import { getSession, mergeSessionTexts } from "@/lib/sessionContext";
import type { NlParseResult } from "@/lib/nlActionParser";
import { specsFor, defaultOptsFromSpecs } from "@/components/transform/transformOptions";
import { useActionEventLog } from "@/hooks/useActionEventLog";
import styles from "./TransformHub.module.css";

export function TransformHubDialog() {
  const item = useDialogStore((s) => s.hubItem);
  // 图片预览里框选一块后传进来的文字；有它就不再自己 OCR
  const override = useDialogStore((s) => s.hubText);
  const open = !!item;
  const anim = useDialogAnim();
  const { toast } = useToast();

  // 每个变换各自维护选项（id → {key: value}），互不影响
  const [opts, setOpts] = useState<Record<string, Record<string, string>>>({});
  // 刚完成复制的卡片（仅用于按钮"已复制"反馈，与选中无关）
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Tier1 编解码工作台开关（从枢纽打开独立工具弹窗）
  const [showCodec, setShowCodec] = useState(false);
  // Tier2 二维码双向工作台开关（生成 + 识图解码）
  const [showQr, setShowQr] = useState(false);

  const close = useCallback(() => {
    setShowCodec(false);
    setShowQr(false);
    useDialogStore.getState().closeHub();
  }, []);

  // ===== 图片：先本地 OCR，再把识别出的文字交给整套变换 =====
  //
  // 这样不用为图片另造一套动作：翻译/解释报错/提取要点那些现成的东西直接就能用。
  // OCR 是本地引擎，**不受 AI 总开关影响**——关掉 AI 也能识别，只是下面没云端动作可选。
  const isImage = item?.type === "image";
  const [ocrText, setOcrText] = useState("");
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState("");

  const runOcr = useCallback(async () => {
    const path = item?.content;
    if (!path) return;
    setOcrLoading(true);
    setOcrError("");
    try {
      const r = await ocrImage(path);
      const text = r.fullText.trim();
      setOcrText(text);
      if (!text) {
        setOcrError("这张图里没识别出文字。手写、艺术字、分辨率太低都会这样。");
      }
    } catch (e) {
      setOcrError(e instanceof Error ? e.message : String(e));
    } finally {
      setOcrLoading(false);
    }
  }, [item?.content]);

  // 换条目时重置；图片且没有覆盖文本时自动识别一次
  useEffect(() => {
    setOcrText("");
    setOcrError("");
    if (open && isImage && !override) void runOcr();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, open, isImage, override]);

  /** 真正拿去做变换的文本：框选覆盖 > 图片 OCR > 条目自带的文本 */
  const sourceText = override ?? (isImage ? ocrText : item?.text || "");

  // 变换上下文（动态选项解析的输入，如 SQL IN 的可选字段来自对象数组实际字段）
  const ctx = useMemo<TransformContext>(
    () => ({
      text: sourceText,
      // 图片 OCR 出来的就是普通文本，不能再拿 image 当类型（否则没一个变换会命中）
      contentType: isImage ? "text" : item ? item.content_type || item.type : "",
      // 标签参与打分：自动标签里的语言级（Rust/Java/SQL…）是 content_type 给不了的粒度；
      // 手工标签能把 ai-reply-draft / ai-weekly-report 这类靠意图的动作浮上来（见 tagBoost）。
      tags: item?.tags?.map((t) => ({ name: t.name, source: t.source })),
      // P2 文档管线：doc/rich 条目把 CF_HTML 片段透传给文档类变换
      html: item && (item.type === "doc" || item.type === "rich") ? item.content : undefined,
    }),
    [item, sourceText, isImage],
  );

  // 当前内容命中的变换（v6.1：个性化排序 = 静态分 × 个人使用频次，含负反馈剔除），过滤 < 0.3 的噪声
  // learnRev 是负反馈后的刷新信号：点了「不再推荐」就 +1 触发重算
  const [learnRev, setLearnRev] = useState(0);
  const scored = useMemo(
    () =>
      item
        ? recommendScored(ctx, sceneOf(new Date().getHours(), item.source)).filter(
            // 置顶的动作**无条件绕过 0.3 门槛**。
            //
            // 不这么做会出一个必然 bug：现在五因子里四个因无行为数据而恒为 1，
            // score 就等于基础分，而基础分算的是“能不能处理这类内容”——
            // 很多真正常用的工具分数并不高。用户置顶了却看不到它，比不做还糟。
            (s) => s.score >= 0.3 || isPinnedAction(s.transform.id),
          )
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [item, ctx, learnRev],
  );

  /**
   * 负反馈：「不再推荐这个」。
   * 记录到本地后刷新推荐状态 + 本组件重算排序（该卡片随即消失）。
   */
  const handleDismiss = useCallback(
    async (actionId: string) => {
      try {
        const { actionDismissAdd } = await import("@/lib/api/actionEvents");
        await actionDismissAdd(actionId, ctx.contentType);
        const { refreshRecommendState } = await import("@/lib/recommend");
        await refreshRecommendState();
        setLearnRev((v) => v + 1);
        toast(`不再推荐「${actionId}」`, "success");
      } catch (e) {
        toast(`操作失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
    [ctx.contentType, toast],
  );

  /**
   * 正向偏好：置顶 / 取消置顶。走与 `handleDismiss` 同一条刷新路径。
   *
   * 后端的 `action_pin_add` 会顺手清掉该动作的 dismiss，所以这里不用再调一次。
   */
  const handleTogglePin = useCallback(
    async (actionId: string, next: boolean) => {
      try {
        const { actionPinAdd, actionPinRemove } = await import("@/lib/api/actionEvents");
        // 全局置顶：contentType 传空串
        if (next) await actionPinAdd(actionId, "");
        else await actionPinRemove(actionId, "");
        const { refreshRecommendState } = await import("@/lib/recommend");
        await refreshRecommendState();
        setLearnRev((v) => v + 1);
        toast(next ? "已设为常用，以后排在最前" : "已取消常用", "success");
      } catch (e) {
        toast(`操作失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
    [toast],
  );

  // 分区：常用（置顶）→ 推荐（≥0.6）→ 其他工具（<0.6）
  //
  // 置顶是**分组前置**而不是再乘一个因子：乘因子会被其它因子稀释，做不到“恒排最前”。
  // 组内部仍沿用 recommendScored 的原有排序（filter 天然保持顺序），不再发明一套置顶内部序。
  const pinned = useMemo(() => scored.filter((s) => isPinnedAction(s.transform.id)), [scored]);
  const recommended = useMemo(
    () => scored.filter((s) => !isPinnedAction(s.transform.id) && s.score >= 0.6),
    [scored],
  );
  const others = useMemo(
    () => scored.filter((s) => !isPinnedAction(s.transform.id) && s.score < 0.6),
    [scored],
  );

  // P2：doc/rich 条目的 HTML 片段，注入到变换的 opts 供 run() 取用
  const itemHtml = item && (item.type === "doc" || item.type === "rich") ? item.content : undefined;
  /** 手工标签名，与 itemHtml 同一条路透传给 TransformCard → 后端的 ai_tags_as_context */
  const itemUserTags = manualTagsOpt(item?.tags);

  // 打开 / 切换内容时重置选项与复制反馈
  useEffect(() => {
    const init: Record<string, Record<string, string>> = {};
    for (const { transform: t } of scored) init[t.id] = defaultOptsFromSpecs(specsFor(t, ctx));
    setOpts(init);
    setCopiedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  const optsFor = useCallback(
    (t: Transform) => opts[t.id] ?? defaultOptsFromSpecs(specsFor(t, ctx)),
    [opts, ctx],
  );
  const setOpt = useCallback(
    (id: string, key: string, value: string) =>
      setOpts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), [key]: value } })),
    [],
  );

  /**
   * 记一笔动作事件（v6.0 action_events 表）。
   *
   * fire-and-forget：写不进去也只是少一条统计，绝不能拖慢复制/粘贴本身。
   * 只记「动作 + 内容类型 + 来源应用 + 时段 + 结果」，不含任何内容文本。
   */
  const logEvent = useActionEventLog(ctx.contentType, item?.source, item?.id);

  /**
   * 复制卡片**已经算好的**产物。
   *
   * 不在这里重跑 `t.run()`：本地变换重跑是白费一次计算，
   * 云端动作重跑则是多一次网络往返。
   */
  const copyOutput = useCallback(
    async (t: Transform, output: string, meta?: TransformResultMeta) => {
      try {
        await navigator.clipboard.writeText(output);
        // 复制成功 = 用户认可这个动作的产物，记一笔（fire-and-forget）
        logEvent(t, "copied");
        const n = meta?.count;
        toast(n ? `已复制「${t.label}」（${n} 个值）` : `已复制「${t.label}」`, "success");
        setCopiedId(t.id);
        setTimeout(() => setCopiedId((cur) => (cur === t.id ? null : cur)), 1200);
      } catch {
        toast("复制失败", "error");
      }
    },
    [toast, logEvent],
  );

  /** 把卡片已算好的产物直接粘贴到前台窗口 */
  const pasteOutput = useCallback(
    async (t: Transform, output: string) => {
      const ok = await pasteTextGuarded(output);
      if (ok) {
        toast(`已粘贴「${t.label}」`, "success");
        // 粘贴成功 = 内容真正被用上，这是最有价值的「有价值」信号
        logEvent(t, "pasted");
      }
    },
    [toast, logEvent],
  );

  // Esc 关闭（其余导航键交由卡片按钮 / Tab 处理）。
  // 编解码 / 二维码工作台打开时不接 Esc：它们自己也在 window 上监听 Escape，
  // preventDefault 不会阻止同级 listener，两边都跑的话按一下 Esc 会把工作台和枢纽一起关掉。
  useEffect(() => {
    if (!open || showCodec || showQr) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close, showCodec, showQr]);

  // v6.3 自然语言动作定位：命中动作卡片滚动到可视区 + 短暂高亮
  const [activeActionId, setActiveActionId] = useState<string | null>(null);

  /**
   * B：让 AI 编一条链。
   *
   * **不做自动触发**——自动编链 = 每次复制都调一次云端，既花钱又把内容发出去，
   * 而用户十次里有九次不需要链。编完也不直接跑：交给运行器预选，
   * 用户看完步骤再点「运行」（红线①：永不自动执行）。
   */
  const [planning, setPlanning] = useState(false);
  const planChain = useCallback(async () => {
    if (planning || !sourceText.trim()) return;
    setPlanning(true);
    try {
      // v6.5 记忆×编链：把工作记忆会话拼进输入，模型能看出"这是连续内容"
      // （后端会做 1500 字采样，这里只拼会话的前 800 字，避免被采样截掉主体）
      const session = getSession();
      const sessionTail =
        session && session.texts.length > 1
          ? mergeSessionTexts(session).slice(0, 800)
          : null;
      const planInput = sessionTail
        ? `${sourceText}\n\n--- 之前连续复制的上下文（供参考，不用全部处理） ---\n${sessionTail}`
        : sourceText;
      let r = await requestPlannedChain(planInput);
      // 敏感内容：确认后带 force 重试一次（不递归，就一次）
      if (r.status === "needsConfirm") {
        const ok = await confirmDialog({
          title: "确认发送",
          message: r.reason,
          confirmText: "确认发送",
          variant: "warning",
        });
        if (!ok) return;
        r = await requestPlannedChain(planInput, true);
      }
      if (r.status === "needsConfirm") return; // 带了 force 还要确认 → 当作放弃
      if (r.status === "budgetExceeded") {
        toast(
          `今天的 AI 预算用完了（已花 ¥${r.spentCny.toFixed(2)} / ¥${r.budgetCny.toFixed(2)}）`,
          "error",
        );
        return;
      }
      if (r.status === "unusable") {
        // 不是故障，是“它没想出来”，文案要分开
        toast("模型没编出可用的链——它给的步骤我们都没有", "info");
        return;
      }
      // 静默丢弃会让人以为模型就是这么编的，得说一声
      if (r.dropped.length > 0) {
        toast(`已跳过 ${r.dropped.length} 个我们没有的动作：${r.dropped.join("、")}`, "info");
      }
      if (r.truncated) {
        toast("模型输出被截断，这条链可能不完整", "warning");
      }
      useDialogStore.getState().openChain(sourceText, undefined, r.chain);
    } catch (e) {
      toast(`编链失败：${e}`, "error");
    } finally {
      setPlanning(false);
    }
  }, [planning, sourceText, toast]);
  const actionRefs = useRef(new Map<string, HTMLDivElement>());
  const activeTimerRef = useRef<number | null>(null);
  // 审查：卸载时清理定位高亮 timer（避免卸载后 setState）
  useEffect(() => {
    return () => {
      if (activeTimerRef.current !== null) window.clearTimeout(activeTimerRef.current);
    };
  }, []);

  /** NL 指令结果处理：未命中/AI 未启用 → 提示；命中 → 预填参数 + 滚动定位 */
  const handleNlApply = useCallback(
    (r: NlParseResult) => {
      if (!r.actionId) {
        toast("没听懂，试试：改得正式一点 / 翻译成英文 / 总结要点", "info");
        return;
      }
      if (r.aiDisabled) {
        toast("AI 未启用——先到设置里启用并配置服务商", "info");
        return;
      }
      // 预填参数（如 tone=formal），用户点运行即生效
      if (r.params) {
        setOpts((prev) => ({
          ...prev,
          [r.actionId!]: { ...(prev[r.actionId!] ?? {}), ...r.params! },
        }));
      }
      const el = actionRefs.current.get(r.actionId!);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        setActiveActionId(r.actionId!);
        if (activeTimerRef.current !== null) window.clearTimeout(activeTimerRef.current);
        activeTimerRef.current = window.setTimeout(() => setActiveActionId(null), 1800);
      }
      toast(`已定位「${r.label ?? r.actionId}」`, "success");
    },
    [toast],
  );

  const renderCard = ({ transform: t, score, reason }: ScoredTransform) => (
    <div
      key={t.id}
      ref={(el) => {
        if (el) actionRefs.current.set(t.id, el);
        else actionRefs.current.delete(t.id);
      }}
      className={activeActionId === t.id ? styles.cardActiveWrap : undefined}
    >
      <TransformCard
        t={t}
        score={score}
        text={sourceText}
        html={itemHtml}
        userTags={itemUserTags}
        opts={optsFor(t)}
        specs={specsFor(t, ctx)}
        copied={copiedId === t.id}
        onSetOpt={(k, v) => setOpt(t.id, k, v)}
        onCopy={(output, meta) => void copyOutput(t, output, meta)}
        onPaste={(output) => void pasteOutput(t, output)}
        contentType={ctx.contentType}
        reason={reason}
        onDismiss={(id) => void handleDismiss(id)}
        pinned={isPinnedAction(t.id)}
        onTogglePin={(id, next) => void handleTogglePin(id, next)}
      />
    </div>
  );

  // 常挂载，open=false 时由 AnimatePresence 驱动退场后再卸载
  return (
    <>
    <AnimatePresence>
      {open && item && (
        <motion.div {...anim.backdrop} className="dialog-backdrop" onClick={close}>
          <FocusTrap>
            <motion.div
              {...anim.panel}
              className={`dialog-box w460 ${styles.hub}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="dialog-header">
                <span className={styles.headerIcon}><Sparkles size={16} /></span>
                <h2 className="dialog-title">变换为…</h2>
                <span className={styles.headerSub}>{scored.length} 个可用变换</span>
                <button onClick={close} className="dialog-close"
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "")}>
                  <X size={16} />
                </button>
              </div>

              {/* v6.3 自然语言动作：一句话定位到对应变换 */}
              <NlCommandBar onResult={handleNlApply} />

              {/* 链入口：两者曾经是 dialog-header 里的两个小按钮，主窗口 480px 下
                  那行只有 408px 可用而内容已 ~406px，「编链中…」态直接把关闭按钮顶到弹窗外。
                  下移到独立一行后拿到整行 420px，顺便把原本只在 title 里的说明携到了可见处。
                  位置在 NlCommandBar 与卡片区之间：三者都回答“怎么处理这段内容”，
                  从一句话 → 一条链 → 单个变换，粒度递减。 */}
              <div className={styles.chainRow}>
                <button
                  className={styles.chainTile}
                  onClick={() => useDialogStore.getState().openChain(sourceText)}
                >
                  <span className={styles.chainTileIcon}><Workflow size={15} /></span>
                  <span className={styles.chainTileText}>
                    <span className={styles.chainTileName}>动作链</span>
                    <span className={styles.chainTileDesc}>多步流程一键跑完</span>
                  </span>
                </button>
                {/* 让 AI 根据当前内容编一条链（手动触发，编完仍需确认才跑） */}
                <button
                  className={styles.chainTile}
                  onClick={planChain}
                  disabled={planning || !sourceText.trim() || !isAiAvailable()}
                >
                  <span className={styles.chainTileIcon} data-ai="1">
                    {planning ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
                  </span>
                  <span className={styles.chainTileText}>
                    <span className={styles.chainTileName}>
                      {/* “AI”走全站统一的品牌渐变（AiMark），不在这里另写一份 */}
                      <AiMark shape="text" text={planning ? "编链中…" : "AI 编链"} />
                    </span>
                    {/* 禁用时说**原因**而不是只变灏——否则用户不知道为什么点不了，会反复点 */}
                    <span className={styles.chainTileDesc}>
                      {!isAiAvailable()
                        ? "AI 功能未开启"
                        : !sourceText.trim()
                          ? "没有可处理的文字"
                          : planning
                            ? "正在让 AI 看内容…"
                            : "让 AI 看内容配流水线"}
                    </span>
                  </span>
                </button>
              </div>

              {/* Tier2 二维码双向工作台入口：生成 + 识图解码（qrcode + jsqr） */}
              <button
                onClick={() => setShowQr(true)}
                style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 10,
                  border: "1px solid var(--border-color)", background: "var(--card-bg)", cursor: "pointer",
                  fontFamily: "inherit", textAlign: "left", width: "100%",
                }}
              >
                <QrCode size={16} style={{ color: "var(--accent)" }} />
                <span style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>📱 二维码工作台</span>
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>文本↔二维码 · 识图解码（全程本地）</span>
                </span>
              </button>

              {/* Tier1 编解码工作台入口：复用 codecTransforms，双栏实时互转 */}
              <button
                onClick={() => setShowCodec(true)}
                style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 10,
                  border: "1px solid var(--border-color)", background: "var(--card-bg)", cursor: "pointer",
                  fontFamily: "inherit", textAlign: "left", width: "100%",
                }}
              >
                <Lock size={16} style={{ color: "var(--accent)" }} />
                <span style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>🔐 编解码工作台</span>
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Base64 / URL / JWT / 时间戳 实时互转</span>
                </span>
              </button>

              <div className={styles.cards}>
                {/* 图片：把本地识别结果摆出来并允许修改。
                    让用户先看一眼再决定要不要发给模型——识别错了就没必要花这个钱。 */}
                {isImage && !override && (
                  <div className={styles.ocrBox}>
                    <div className={styles.ocrHead}>
                      {ocrLoading ? (
                        <>
                          <Loader2 size={12} className="spin" /> 本地识别中…
                        </>
                      ) : (
                        <>本地识别结果（可修改）</>
                      )}
                      <button
                        className={styles.ocrRetry}
                        disabled={ocrLoading}
                        onClick={() => void runOcr()}
                      >
                        <RotateCw size={11} /> 重新识别
                      </button>
                    </div>
                    {!ocrLoading && (
                      <textarea
                        className={styles.ocrText}
                        value={ocrText}
                        placeholder="识别不出来时可以自己敲"
                        onChange={(e) => setOcrText(e.target.value)}
                      />
                    )}
                    {ocrError && <div className={styles.ocrErr}>{ocrError}</div>}
                    <div className={styles.ocrNote}>
                      图片不会被发送，只有上面这段文字会交给变换。
                    </div>
                  </div>
                )}

                {scored.length === 0 && !ocrLoading && (
                  <div className={styles.empty}>
                    <MelodyEmpty size={64} />
                    {isImage && !sourceText ? "没有可用的文字，先试试重新识别或手动输入" : "此内容暂无可用变换"}
                  </div>
                )}
                {/* 常用（置顶）排最前。没置顶时整组不渲染，不留空标题。 */}
                {pinned.length > 0 && (
                  <>
                    <div className={styles.sectionLabel}>常用</div>
                    {pinned.map(renderCard)}
                  </>
                )}
                {recommended.length > 0 && (
                  <>
                    <div className={styles.sectionLabel}>推荐</div>
                    {recommended.map(renderCard)}
                  </>
                )}
                {others.length > 0 && (
                  <>
                    <div className={styles.sectionLabel}>其他工具</div>
                    {others.map(renderCard)}
                  </>
                )}
              </div>
            </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>
    {open && item && showCodec && (
      <CodecEditor initialText={sourceText} onClose={() => setShowCodec(false)} />
    )}
    {open && item && showQr && (
      <QREditor initialText={sourceText} onClose={() => setShowQr(false)} />
    )}
    </>
  );
}
