/**
 * SuggestionBar.tsx —— v6.2 主动建议（三条硬约束的组件落地）：
 *
 * 1. **绝不弹窗**：只在主窗口（用户已打开、正在看列表时）以一行 inline 条出现，
 *    不打断任何前台操作；
 * 2. **只给 top-1**：一次只显示一个建议（单条 top-1 或序列合并），不给列表；
 * 3. **一眼可否决**：✕ 立即写入「不再推荐」并消失——否决被记住，同类内容不再烦你。
 *
 * 触发：新内容进入 history[0]（clipboard-changed → prependItem）时计算建议。
 * 同一条内容只建议一次（key = 内容 + 动作），8 秒无操作自动收起。
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Lightbulb, X, ArrowRight } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { useDialogStore } from "@/stores/dialogStore";
import { suggestTop1, suggestSequence, suggestChain, type Suggestion } from "@/lib/suggest";
import { getTransform } from "@/lib/transforms";
import { actionDismissAdd } from "@/lib/api/actionEvents";
import { aiFeedbackStats, actionPrefsAll } from "@/lib/api/aiFeedback";
import { useToast } from "@/components/Toast";
import { sceneOf } from "@/lib/recommend";
import styles from "./SuggestionBar.module.css";

/** 无操作自动收起时长 */
const AUTO_HIDE_MS = 8000;

/** 被改率 ≥ 该值 = "常被改"，建议降权（除非已设偏好指令） */
const EDIT_RATE_BAD = 0.4;

/** 反馈统计与偏好的模块级缓存（建议条是高频触发，避免每次 invoke） */
let fbCache: { actionId: string; editRate: number }[] | null = null;
let prefActions: Set<string> | null = null;
let fbCacheLoadedAt = 0;

/** 拉取反馈/偏好（60s 缓存） */
async function loadFeedback(): Promise<{ fb: typeof fbCache; prefs: typeof prefActions }> {
  const now = Date.now();
  if (fbCache && prefActions && now - fbCacheLoadedAt < 60_000) {
    return { fb: fbCache, prefs: prefActions };
  }
  const [stats, prefs] = await Promise.all([
    aiFeedbackStats(30).catch(() => []),
    actionPrefsAll().catch(() => []),
  ]);
  fbCache = stats.filter((s) => s.total >= 5);
  prefActions = new Set(prefs.map((p) => p.actionId));
  fbCacheLoadedAt = now;
  return { fb: fbCache, prefs: prefActions };
}

/** 建议条文案：动作 → 单步；序列 → 合并；链（M4）→ 多步一次跑完 */
function describe(s: Suggestion): string {
  if (s.kind === "sequence") {
    return `把 ${s.texts.length} 个同类内容合并成「${s.label}」？`;
  }
  if (s.kind === "chain") {
    return `用「${s.label}」链一次跑完（${s.stepCount} 步）？`;
  }
  return `用「${s.label}」处理这段内容？`;
}

export const SuggestionBar = memo(function SuggestionBar() {
  const { toast } = useToast();
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const lastKeyRef = useRef<string>("");

  // 最新条目（history[0] 是剪贴板最新捕获）
  const topItem = useAppStore((s) => s.history[0]);

  // 新内容到达 → 计算建议（单条 top-1 优先，其次序列，最后跑链）
  useEffect(() => {
    if (!topItem || topItem.type !== "text") return;
    const text = (topItem.text || "").trim();
    if (!text) return;

    const ctx = {
      text,
      contentType: topItem.content_type || topItem.type,
    };
    // v6.2 场景感知：当前小时 + 来源应用 → 时段桶 × 来源类别
    const scene = sceneOf(new Date().getHours(), topItem.source);

    void (async () => {
      const { fb, prefs } = await loadFeedback();
      const history = useAppStore.getState().history.slice(0, 3).map((h) => ({ text: h.text || "" }));

      // top-1 优先；若该动作"常被改"且用户没给它设偏好指令 → 放弃（宁可漏报，不推不满意的）
      const top1Raw = suggestTop1(ctx, scene);
      let top1: ReturnType<typeof suggestTop1> = top1Raw;
      if (top1Raw && top1Raw.kind === "action") {
        const stat = fb?.find((s) => s.actionId === top1Raw.transformId);
        if (stat && stat.editRate >= EDIT_RATE_BAD && !prefs?.has(top1Raw.transformId)) {
          top1 = null;
        }
      }

      const seq = top1 ? null : suggestSequence(history);
      const chain = !top1 && !seq ? suggestChain(ctx) : null;
      const s = top1 ?? seq ?? chain;
      if (!s) {
        if (suggestion) setSuggestion(null);
        return;
      }

      // 同一条内容 + 同一建议不重复（避免连续复制相同内容反复弹）
      const key =
        s.kind === "chain"
          ? `${s.kind}:${s.chainId}:${s.text}`
          : s.kind === "action"
            ? `${s.kind}:${s.transformId}:${s.text}`
            : `${s.kind}:${s.transformId}:${s.mergedText}`;
      if (key === lastKeyRef.current) return;
      lastKeyRef.current = key;
      setSuggestion(s);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topItem?.id, topItem?.text]);

  // 8 秒无操作自动收起
  useEffect(() => {
    if (!suggestion) return;
    const t = window.setTimeout(() => setSuggestion(null), AUTO_HIDE_MS);
    return () => window.clearTimeout(t);
  }, [suggestion]);

  /** 使用建议：链 → 打开运行器并预选；执行类 → 直接 run；其余 → 打开枢纽定位 */
  const handleUse = useCallback(async () => {
    if (!suggestion) return;
    const store = useAppStore.getState();
    const item = store.history[0];
    const targetText =
      suggestion.kind === "action" || suggestion.kind === "chain"
        ? suggestion.text
        : suggestion.mergedText;

    if (suggestion.kind === "chain") {
      // 跑链建议（M4）：打开运行器并预选这条链
      useDialogStore.getState().openChain(targetText, suggestion.chainId);
    } else if (suggestion.kind === "action" && suggestion.transformId === "act-open-url") {
      // 执行类：直接 run（与卡片动作条一致）
      const t = getTransform(suggestion.transformId);
      if (t) {
        const r = await t.run(targetText);
        toast(r.ok ? `已执行「${suggestion.label}」` : r.message || "执行失败", r.ok ? "success" : "error");
      }
    } else {
      // text 类 / 序列：打开变换枢纽并定位（用户仍可预览/选择/否决）
      if (item) {
        useDialogStore.getState().openHub(item, targetText);
      }
    }
    setSuggestion(null);
  }, [suggestion, toast]);

  /** 否决：动作类写入「不再推荐」；链类低频、仅本次收起（不持久，避免链名污染动作表） */
  const handleDismiss = useCallback(async () => {
    if (!suggestion) return;
    if (suggestion.kind !== "chain") {
      const ct = useAppStore.getState().history[0]?.content_type || "text";
      await actionDismissAdd(suggestion.transformId, ct).catch(() => {});
      const { refreshRecommendState } = await import("@/lib/recommend");
      await refreshRecommendState().catch(() => {});
    }
    setSuggestion(null);
    toast(`不再建议「${suggestion.label}」`, "info");
  }, [suggestion, toast]);

  return (
    <AnimatePresence>
      {suggestion && (
        <motion.div
          key={lastKeyRef.current}
          className={styles.bar}
          initial={{ opacity: 0, y: -8, height: 0 }}
          animate={{ opacity: 1, y: 0, height: "auto" }}
          exit={{ opacity: 0, y: -8, height: 0 }}
          transition={{ duration: 0.18 }}
        >
          <span className={styles.icon}><Lightbulb size={13} /></span>
          <span className={styles.text}>{describe(suggestion)}</span>
          <span className={styles.spacer} />
          <button className={styles.useBtn} onClick={() => void handleUse()}>
            使用 <ArrowRight size={12} />
          </button>
          <button className={styles.xBtn} onClick={() => void handleDismiss()} title="不再建议这个">
            <X size={13} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
});
