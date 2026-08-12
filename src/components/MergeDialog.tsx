/**
 * MergeDialog.tsx —— v6.4 C 连续合并粘贴：多选历史 → 合并成一份 → 预览 → 粘贴/复制。
 *
 * 场景：写周报从 5 处复制素材、整理资料拼接分散段落、客服拼话术。
 * 规则版（本组件）：分隔符/编号拼接 + 实时预览 + 一键粘贴/复制，纯本地零成本。
 * AI 版（去重+顺排+润色）留待后续：需要后端动作，且用户未明确要求。
 */
import { memo, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Copy, CornerDownLeft } from "lucide-react";
import { pasteTextGuarded } from "@/lib/api";
import { aiRun } from "@/lib/api/ai";
import { isAiAvailable } from "@/lib/transforms/aiTransforms";
import { mergeTexts, type MergeSeparator } from "@/lib/mergeText";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import { Sparkles, Loader2 } from "lucide-react";
import styles from "./MergeDialog.module.css";

export interface MergeItem {
  id: string;
  text: string;
}

const SEP_LABELS: Record<MergeSeparator, string> = {
  newline: "换行",
  comma: "逗号",
  semicolon: "分号",
  numbered: "编号列表",
  custom: "自定义",
};

export const MergeDialog = memo(function MergeDialog({
  items,
  onClose,
}: {
  items: MergeItem[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { backdrop, panel } = useDialogAnim();
  const [separator, setSeparator] = useState<MergeSeparator>("newline");
  const [customSep, setCustomSep] = useState("、");
  // v6.4 C AI 增强：AI 合并结果覆盖预览（规则版保留在 merged）
  const [aiMerged, setAiMerged] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  // 审查：切换分隔符/自定义分隔后清掉旧 AI 结果（否则显示的是旧参数的合并，label 也不对）
  useEffect(() => {
    setAiMerged(null);
  }, [separator, customSep]);

  // 合并结果（实时预览）
  const merged = useMemo(
    () => mergeTexts(items.map((i) => i.text), separator, customSep),
    [items, separator, customSep],
  );
  const display = aiMerged ?? merged;

  /** AI 合并（去重+顺排+润色）。规则 15：未启用不调用；失败退回规则版。 */
  const aiMerge = async () => {
    if (!isAiAvailable()) {
      toast("AI 未启用——先到设置里启用", "info");
      return;
    }
    setAiLoading(true);
    try {
      const r = await aiRun("ai-merge-polish", merged);
      if (r.status === "ok" && r.content.trim()) {
        setAiMerged(r.content.trim());
        toast("AI 已整理（去重+顺排+润色）", "success");
      } else if (r.status === "budgetExceeded") {
        // v6.9：内置免费额度不足 → 引导签到/兑换；否则原预算提示
        toast(r.isQuota ? "免费额度已用完，去设置 → AI 签到或兑换" : "超出本月 AI 预算", "info");
      } else {
        toast("AI 合并失败，已保留规则版", "info");
      }
    } catch {
      toast("AI 合并失败，已保留规则版", "info");
    } finally {
      setAiLoading(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(display);
      toast(`已复制 ${items.length} 条合并结果`, "success");
    } catch {
      toast("复制失败", "error");
    }
  };

  const paste = async () => {
    const ok = await pasteTextGuarded(display);
    if (ok) {
      toast("已粘贴合并结果", "success");
      onClose();
    }
  };

  return (
    <AnimatePresence>
      <motion.div {...backdrop} className="dialog-backdrop" onClick={onClose}>
        <FocusTrap>
          <motion.div
            {...panel}
            className={`dialog-box w460 ${styles.box}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dialog-header">
              <h2 className="dialog-title">合并粘贴</h2>
              <span className={styles.headerSub}>{items.length} 条已选</span>
              <button onClick={onClose} className="dialog-close" aria-label="关闭">
                <X size={16} />
              </button>
            </div>

            {/* 分隔符选项 */}
            <div className={styles.seps}>
              {(Object.keys(SEP_LABELS) as MergeSeparator[]).map((s) => (
                <button
                  key={s}
                  className={`${styles.sepBtn}${separator === s ? ` ${styles.sepBtnActive}` : ""}`}
                  onClick={() => setSeparator(s)}
                >
                  {SEP_LABELS[s]}
                </button>
              ))}
              {separator === "custom" && (
                <input
                  className={styles.customInput}
                  value={customSep}
                  onChange={(e) => setCustomSep(e.target.value)}
                  placeholder="自定义分隔符"
                  autoFocus
                />
              )}
            </div>

            {/* 预览 */}
            <div className={styles.previewWrap}>
              <div className={styles.previewLabel}>
                {aiMerged ? "AI 整理结果" : "预览"}
              </div>
              <pre className={styles.preview}>{display || "（没有可合并的文本内容）"}</pre>
            </div>

            <div className={styles.actions}>
              {isAiAvailable() && (
                <button
                  className={styles.aiBtn}
                  onClick={() => void aiMerge()}
                  disabled={aiLoading}
                  title="AI 去重 + 顺排 + 润色（需要 AI 服务）"
                >
                  {aiLoading ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                  {aiLoading ? "整理中…" : aiMerged ? "重新整理" : "AI 整理"}
                </button>
              )}
              <button className={styles.pasteBtn} onClick={() => void paste()}>
                <CornerDownLeft size={13} /> 粘贴到前台
              </button>
              <button className={styles.copyBtn} onClick={() => void copy()}>
                <Copy size={13} /> 复制
              </button>
            </div>
          </motion.div>
        </FocusTrap>
      </motion.div>
    </AnimatePresence>
  );
});
