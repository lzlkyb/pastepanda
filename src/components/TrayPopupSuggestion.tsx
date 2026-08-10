/**
 * TrayPopupSuggestion.tsx —— v6.2 主动建议（托盘弹窗版）。
 *
 * 复用主窗口同一套建议引擎（suggest / recommend / sceneOf），
 * 弹窗打开时基于最新记录（recents[0]）给出 top-1 建议——这正是规划原文
 * 「复制后托盘弹窗直接显示一个最可能的动作」的落地。
 *
 * 与主窗口建议条的差异（弹窗是"点了就用"的快速场景）：
 * - 「使用」：text/序列 → 变换结果**直接粘贴到前台**（save_foreground + pasteText），
 *   与弹窗内其他粘贴操作一致；action 类 → 直接执行；
 * - ✕ → 写入「不再推荐」并记住（与主窗口同一张表）。
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Lightbulb, X, ArrowRight } from "lucide-react";
import { suggestTop1, suggestSequence, type Suggestion } from "@/lib/suggest";
import { loadRecommendState, refreshRecommendState, sceneOf } from "@/lib/recommend";
import { getTransform } from "@/lib/transforms";
import { actionDismissAdd } from "@/lib/api/actionEvents";
import { pasteText } from "@/lib/api";
import { invoke } from "@tauri-apps/api/core";
import styles from "./TrayPopupSuggestion.module.css";

/** 弹窗建议条依赖的最少字段（与 TrayPopup.RecentItem 解耦） */
export interface SuggestItem {
  id?: string;
  text: string;
  type: string;
  source?: string;
  contentType?: string;
}

/** 建议去重 key（M4 加了 chain 变体后，三种类型字段不同，统一收口） */
function suggestionKey(s: Suggestion): string {
  if (s.kind === "chain") return `${s.kind}:${s.chainId}:${s.text}`;
  return `${s.kind}:${s.transformId}:${s.kind === "action" ? s.text : s.mergedText}`;
}

export const TrayPopupSuggestion = memo(function TrayPopupSuggestion({
  item,
  recents,
  onToast,
  onHide,
}: {
  item: SuggestItem | undefined;
  recents: SuggestItem[];
  onToast: (message: string, type: "success" | "error" | "info", duration?: number) => void;
  onHide: () => void;
}) {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string>("");
  const lastKeyRef = useRef<string>("");

  // 弹窗是常驻（hide 不销毁），首次挂载时拉一次推荐数据即可
  useEffect(() => {
    void loadRecommendState().catch(() => {});
  }, []);

  // 最新记录变化 → 重算建议
  useEffect(() => {
    if (!item || item.type !== "text") {
      if (suggestion) setSuggestion(null);
      return;
    }
    const text = (item.text || "").trim();
    if (!text) {
      if (suggestion) setSuggestion(null);
      return;
    }
    const ctx = { text, contentType: item.contentType || "text" };
    const scene = sceneOf(new Date().getHours(), item.source || "");

    const top1 = suggestTop1(ctx, scene);
    const seq = top1
      ? null
      : suggestSequence(recents.slice(0, 3).map((r) => ({ text: r.text || "" })));
    const s = top1 ?? seq;
    if (!s || s.kind === "chain") {
      // 托盘不做链建议（链需要多步预览，不适合"点了就用"的快速场景）
      if (suggestion) setSuggestion(null);
      return;
    }
    const key = suggestionKey(s);
    // 刚被 ✕ 否决过的同一条建议不再出现（本次会话）
    if (key === dismissedKey) {
      if (suggestion) setSuggestion(null);
      return;
    }
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    setSuggestion(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.text, item?.id, dismissedKey]);

  /** 使用：text/序列 → 变换结果粘贴前台；action → 直接执行 */
  const handleUse = useCallback(async () => {
    if (!suggestion) return;
    if (suggestion.kind === "chain") return; // 托盘不做链建议（类型守卫）
    const t = getTransform(suggestion.transformId);
    if (!t) return;

    if (suggestion.kind === "action") {
      const r = await t.run(suggestion.text);
      onToast(r.ok ? `已执行「${suggestion.label}」` : r.message || "执行失败", r.ok ? "success" : "error", 1200);
    } else {
      // 序列/text：产出文本 → 粘贴到前台（与弹窗其他粘贴一致）
      const r = await t.run(suggestion.mergedText);
      if (!r.ok || r.output === undefined) {
        onToast(r.message || "变换失败", "error", 1500);
        return;
      }
      try {
        await invoke("save_foreground");
        const ok = await pasteText(r.output);
        onToast(ok ? `已粘贴「${suggestion.label}」结果` : "粘贴失败", ok ? "success" : "error", 1000);
      } catch {
        onToast("粘贴失败", "error", 1200);
      }
    }
    setSuggestion(null);
    onHide();
  }, [suggestion, onToast, onHide]);

  /** 否决：写入「不再推荐」+ 刷新 + 本次会话不再显示 */
  const handleDismiss = useCallback(async () => {
    if (!suggestion) return;
    if (suggestion.kind === "chain") return; // 托盘不做链建议（类型守卫）
    const ct = item?.contentType || "text";
    await actionDismissAdd(suggestion.transformId, ct).catch(() => {});
    await refreshRecommendState().catch(() => {});
    setDismissedKey(suggestionKey(suggestion));
    setSuggestion(null);
    onToast(`不再建议「${suggestion.label}」`, "info", 1000);
  }, [suggestion, item, onToast]);

  if (!suggestion) return null;

  return (
    <div className={styles.bar}>
      <span className={styles.icon}><Lightbulb size={12} /></span>
      <span className={styles.text}>
        {suggestion.kind === "sequence"
          ? `把 ${suggestion.texts.length} 个同类内容合并成「${suggestion.label}」？`
          : `用「${suggestion.label}」处理这段内容？`}
      </span>
      <button className={styles.useBtn} onClick={() => void handleUse()}>
        使用 <ArrowRight size={11} />
      </button>
      <button className={styles.xBtn} onClick={() => void handleDismiss()} title="不再建议这个">
        <X size={12} />
      </button>
    </div>
  );
});
