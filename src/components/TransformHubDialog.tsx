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

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Sparkles, Loader2, RotateCw } from "lucide-react";
import { useDialogStore } from "@/stores/dialogStore";
import {
  type Transform,
  type TransformContext,
  type TransformResultMeta,
} from "@/lib/transforms";
import { recommendScored } from "@/lib/recommend";
import { ocrImage, pasteText } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import { MelodyEmpty } from "@/components/MelodyEmpty";
import { TransformCard } from "@/components/transform/TransformCard";
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

  const close = useCallback(() => useDialogStore.getState().closeHub(), []);

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
      // P2 文档管线：doc/rich 条目把 CF_HTML 片段透传给文档类变换
      html: item && (item.type === "doc" || item.type === "rich") ? item.content : undefined,
    }),
    [item, sourceText, isImage],
  );

  // 当前内容命中的变换（v6.1：个性化排序 = 静态分 × 个人使用频次，含负反馈剔除），过滤 < 0.3 的噪声
  // learnRev 是负反馈后的刷新信号：点了「不再推荐」就 +1 触发重算
  const [learnRev, setLearnRev] = useState(0);
  const scored = useMemo(
    () => (item ? recommendScored(ctx).filter((s) => s.score >= 0.3) : []),
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

  // 分区：推荐（≥0.6）vs 其他工具（0.3~0.6）
  const recommended = useMemo(() => scored.filter((s) => s.score >= 0.6), [scored]);
  const others = useMemo(() => scored.filter((s) => s.score < 0.6), [scored]);

  // P2：doc/rich 条目的 HTML 片段，注入到变换的 opts 供 run() 取用
  const itemHtml = item && (item.type === "doc" || item.type === "rich") ? item.content : undefined;

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
  const logEvent = useActionEventLog(ctx.contentType, item?.source);

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
      const ok = await pasteText(output);
      if (ok) {
        toast(`已粘贴「${t.label}」`, "success");
        // 粘贴成功 = 内容真正被用上，这是最有价值的「有价值」信号
        logEvent(t, "pasted");
      }
    },
    [toast, logEvent],
  );

  // Esc 关闭（其余导航键交由卡片按钮 / Tab 处理）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const renderCard = ({ transform: t, score }: { transform: Transform; score: number }) => (
    <TransformCard
      key={t.id}
      t={t}
      score={score}
      text={sourceText}
      html={itemHtml}
      opts={optsFor(t)}
      specs={specsFor(t, ctx)}
      copied={copiedId === t.id}
      onSetOpt={(k, v) => setOpt(t.id, k, v)}
      onCopy={(output, meta) => void copyOutput(t, output, meta)}
      onPaste={(output) => void pasteOutput(t, output)}
      contentType={ctx.contentType}
      onDismiss={(id) => void handleDismiss(id)}
    />
  );

  // 常挂载，open=false 时由 AnimatePresence 驱动退场后再卸载
  return (
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
  );
}
