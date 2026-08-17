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
import { suggestTop1, suggestSequence, suggestChain, suggestIntent, suggestSession, loadFeedback, suppressByEditRate, invalidateLearningCache, type Suggestion } from "@/lib/suggest";
import { getSession, pushToSession, resetSession } from "@/lib/sessionContext";
import { getTransform } from "@/lib/transforms";
import { actionDismissAdd } from "@/lib/api/actionEvents";
import { useToast } from "@/components/Toast";
import { sceneOf } from "@/lib/recommend";
import { cleanSourceName } from "@/lib/source-mappings";
import styles from "./SuggestionBar.module.css";

/** 无操作自动收起时长 */
const AUTO_HIDE_MS = 8000;

/** 审查：学习数据被清空/修改后（LearningsDialog 等）调用，立即失效缓存 */
export function invalidateSuggestionFeedbackCache(): void {
  invalidateLearningCache();
}

/** 建议条文案：意图 → 任务级；动作 → 单步；序列 → 合并；链（M4）→ 多步一次跑完；会话（v6.1）→ 正在拼 */
function describe(s: Suggestion): string {
  if (s.kind === "intent") {
    return `${s.label}——要连着「${s.actionsText}」一起做吗？`;
  }
  if (s.kind === "sequence") {
    return `把 ${s.texts.length} 个同类内容合并成「${s.label}」？`;
  }
  if (s.kind === "chain") {
    return `用「${s.label}」链一次跑完（${s.stepCount} 步）？`;
  }
  if (s.kind === "session") {
    return `看起来你在拼 ${s.texts.length} 段内容——要「${s.label}」成一份吗？`;
  }
  return `用「${s.label}」处理这段内容？`;
}

export const SuggestionBar = memo(function SuggestionBar() {
  const { toast } = useToast();
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  /** 鼠标在建议条上（用于暂停自动收起） */
  const [hovered, setHovered] = useState(false);
  const lastKeyRef = useRef<string>("");
  /** 审查：否决时用的 contentType —— 记录建议计算那一刻的（点击时 history[0] 可能已漂移） */
  const dismissContentTypeRef = useRef<string>("");

  // 最新条目（history[0] 是剪贴板最新捕获）
  const topItem = useAppStore((s) => s.history[0]);

  // 新内容到达 → 计算建议（意图 > top-1 > 序列 > 会话 > 跑链）
  useEffect(() => {
    if (!topItem) return;
    // V6.19 截图场景感知：图片条目（截图）用 OCR 全文参与建议，让"代码/链接/英文"内容
    // 也能触发建议（此前 type!=="text" 直接跳过，截图永远没建议）
    const text = (
      topItem.type === "image" ? topItem.ocr_text || "" : topItem.text || ""
    ).trim();
    if (!text) return;

    // v6.1 工作记忆：新内容进会话桶（90s 间隔聚合，纯内存不落盘）
    pushToSession(text, topItem.content_type || topItem.type);

    // v6.4 审查：#4 竞态防护——内容快速切换时，旧内容的异步建议晚返回直接丢弃
    let cancelled = false;

    const ctx = {
      text,
      contentType: topItem.content_type || topItem.type,
    };
    // v6.2 场景感知：当前小时 + 来源应用 → 时段桶 × 来源类别
    // 审查 #2：与学习端一致，先 cleanSourceName 再分类（记录端 actionEvents.ts 也是清洗后存），
    // 避免"学的和用的对不上"（如 "WeChat.exe" 与 "WeChat" 各归各）
    const scene = sceneOf(new Date().getHours(), cleanSourceName(topItem.source || ""));

    void (async () => {
      const { fb, prefs } = await loadFeedback();
      const history = useAppStore
        .getState()
        .history.slice(0, 3)
        .map((h) => ({
          // V6.19：截图条目用 OCR 全文参与序列/会话建议
          text: h.type === "image" && h.ocr_text ? h.ocr_text : h.text || "",
        }));

      // 意图识别优先（V3-A：任务级理解）；主动作"常被改"且无偏好 → 放弃意图
      let intent = suggestIntent(ctx, scene, history);
      if (intent && intent.kind === "intent") {
        const mainAction = intent.actionIds[0];
        const stat = fb?.find((s) => s.actionId === mainAction);
        if (stat && stat.editRate >= 0.4 && !prefs?.has(mainAction)) {
          intent = null;
        }
      }

      // top-1 优先；若该动作"常被改"且用户没给它设偏好指令 → 放弃（宁可漏报，不推不满意的）
      const top1 = suppressByEditRate(suggestTop1(ctx, scene), fb, prefs);

      const seq = top1 ? null : suggestSequence(history);
      // v6.1 会话感知：连续同类复制（正在拼内容）→ AI 合并建议
      const session = !top1 && !seq ? suggestSession(getSession()) : null;
      const chain = !top1 && !seq && !session ? suggestChain(ctx) : null;
      const s = intent ?? top1 ?? seq ?? session ?? chain;
      if (cancelled) return; // 内容已切换，丢弃过期建议
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
            : s.kind === "intent"
              ? `${s.kind}:${s.intentId}:${s.text}`
              : `${s.kind}:${s.transformId}:${s.mergedText}`;
      if (key === lastKeyRef.current) return;
      lastKeyRef.current = key;
      dismissContentTypeRef.current = topItem?.content_type || topItem?.type || "text";
      setSuggestion(s);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topItem?.id, topItem?.text]);

  /**
   * 自动收起。**鼠标悬在条上时暂停计时**，离开后重新计时。
   *
   * 8 秒对“解释报错”这类要先读懂内容的建议太短，而鼠标移到条上
   * 就是“我在看”的明确信号——此时把它抽走是敌意的。
   *
   * **有意不把“自动收起”当作弱负反馈记下来**：窗口可能在后台、用户可能
   * 正在别处打字、也可能只是离开了座位——噪比信号大。把这种数据喂进推荐
   * 权重，违反的正是本模块自己写的“宁可漏报不可误报”。
   * 真实的否决只有一个入口：用户点 ✕。
   */
  useEffect(() => {
    if (!suggestion || hovered) return;
    const t = window.setTimeout(() => setSuggestion(null), AUTO_HIDE_MS);
    return () => window.clearTimeout(t);
  }, [suggestion, hovered]);

  /** 使用建议：意图 → 执行主动作；链 → 打开运行器并预选；执行类 → 直接 run；其余 → 打开枢纽定位 */
  const handleUse = useCallback(async () => {
    if (!suggestion) return;
    const store = useAppStore.getState();
    const item = store.history[0];
    const targetText =
      suggestion.kind === "action" ||
      suggestion.kind === "chain" ||
      suggestion.kind === "intent"
        ? suggestion.text
        : suggestion.mergedText;

    if (suggestion.kind === "chain") {
      // 跑链建议（M4）：打开运行器并预选这条链
      useDialogStore.getState().openChain(targetText, suggestion.chainId);
    } else if (suggestion.kind === "session" && suggestion.planChainId) {
      // v6.6 会话级编排：打开运行器预选编排链 + 填入会话内容
      useDialogStore.getState().openChain(targetText, suggestion.planChainId);
    } else if (
      (suggestion.kind === "action" && suggestion.transformId === "act-open-url") ||
      (suggestion.kind === "intent" && suggestion.actionIds[0] === "act-open-url")
    ) {
      // 执行类：直接 run（与卡片动作条一致）
      const tid =
        suggestion.kind === "intent" ? suggestion.actionIds[0] : suggestion.transformId;
      const t = getTransform(tid);
      if (t) {
        const r = await t.run(targetText);
        toast(r.ok ? `已执行「${t.label}」` : r.message || "执行失败", r.ok ? "success" : "error");
      }
    } else {
      // text 类 / 序列 / 意图 / 会话：打开变换枢纽并定位（用户仍可预览/选择/否决）
      if (item) {
        useDialogStore.getState().openHub(item, targetText);
      }
    }
    // 会话建议被使用 → 任务已承接，清空工作记忆（内容本来就不该留着）
    if (suggestion.kind === "session") resetSession();
    setSuggestion(null);
  }, [suggestion, toast]);

  /**
   * 否决：动作类写入「不再推荐」；链类/意图类低频、仅本次收起（不持久，避免污染动作表）。
   *
   * **文案必须跟着分岔**：只本次收起却告诉用户「不再建议」，下次它又冒出来，
   * 用户得到的结论是“这功能坏了”——而路线图约束③ 的原文是「否决被记住」，
   * 紧接着写的是「做错一次用户就永久关掉这个功能」。取舍可以不持久，但不能说谎。
   */
  const handleDismiss = useCallback(async () => {
    if (!suggestion) return;
    // 会话/链/意图类低频、仅本次收起（不持久，避免污染动作表）
    const persisted =
      suggestion.kind !== "chain" &&
      suggestion.kind !== "intent" &&
      suggestion.kind !== "session";
    if (persisted) {
      // 审查：用建议计算时的 contentType（而非点击时的 history[0]——8 秒内复制新内容会记错类型）
      const ct = dismissContentTypeRef.current || "text";
      await actionDismissAdd(suggestion.transformId, ct).catch(() => {});
      const { refreshRecommendState } = await import("@/lib/recommend");
      await refreshRecommendState().catch(() => {});
    }
    // 会话被否决 → 也清掉工作记忆（下次同批内容重新聚合，不重复打扰）
    if (suggestion.kind === "session") resetSession();
    setSuggestion(null);
    toast(persisted ? `不再建议「${suggestion.label}」` : "已收起", "info");
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
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
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
