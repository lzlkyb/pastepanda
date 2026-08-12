import { useState, useMemo, useCallback, useEffect, useDeferredValue } from "react";
import { motion } from "framer-motion";
import { X, Copy, Check } from "lucide-react";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { pasteTextGuarded } from "@/lib/api";
import { safeApplyRegex, validateRegex, updateCustomRule, REGEX_TIME_BUDGET_MS, type RegexRule } from "@/lib/regexRules";
import styles from "./RegexPreviewDialog.module.css";
import { FocusTrap } from "@/components/FocusTrap";

interface RegexPreviewDialogProps {
  text: string;
  rule: RegexRule;
  onClose: () => void;
}

export function RegexPreviewDialog({ text, rule, onClose }: RegexPreviewDialogProps) {
  const { toast } = useToast();
  const anim = useDialogAnim();
  const [pattern, setPattern] = useState(rule.pattern);
  const [replacement, setReplacement] = useState(rule.replacement);
  const [flags, setFlags] = useState(rule.flags);
  const [previewTimeout, setPreviewTimeout] = useState(false);

  // 延迟值：输入框立即响应，重计算在延迟值上异步执行，避免每次击键同步阻塞
  const dPattern = useDeferredValue(pattern);
  const dReplacement = useDeferredValue(replacement);
  const dFlags = useDeferredValue(flags);

  // 验证正则
  const regexError = useMemo(() => validateRegex(pattern, flags), [pattern, flags]);

  // 执行替换（分块 + 时间预算，超时自动中止）
  const preview = useMemo(() => {
    if (regexError) return null;
    try {
      const r = safeApplyRegex(text, dPattern, dReplacement, dFlags);
      setPreviewTimeout(false);
      return r;
    } catch (e) {
      setPreviewTimeout(e instanceof Error && e.message.includes("正则执行超时"));
      return null;
    }
  }, [text, dPattern, dReplacement, dFlags, regexError]);

  // 高亮原文中的匹配部分（带时间预算，每 200 次迭代检查一次）
  const highlightedOriginal = useMemo(() => {
    if (regexError || !dPattern) return null;
    try {
      const regex = new RegExp(dPattern, dFlags.includes("g") ? dFlags : dFlags + "g");
      const parts: { text: string; matched: boolean }[] = [];
      let lastIdx = 0;
      let m: RegExpExecArray | null;
      let iters = 0;
      const deadline = performance.now() + REGEX_TIME_BUDGET_MS;
      const input = text.slice(0, 100000);
      while ((m = regex.exec(input)) !== null) {
        if (++iters % 200 === 0 && performance.now() > deadline) return null;
        if (m.index > lastIdx) parts.push({ text: input.slice(lastIdx, m.index), matched: false });
        parts.push({ text: m[0], matched: true });
        lastIdx = regex.lastIndex;
        if (m[0].length === 0) { regex.lastIndex++; }
      }
      if (lastIdx < input.length) parts.push({ text: input.slice(lastIdx), matched: false });
      return parts;
    } catch {
      return null;
    }
  }, [text, dPattern, dFlags, regexError]);

  // 键盘关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleCopyResult = useCallback(async () => {
    if (!preview) return;
    try {
      await navigator.clipboard.writeText(preview.result);
      toast("已复制替换结果", "success");
    } catch { toast("复制失败", "error"); }
  }, [preview, toast]);

  const handlePaste = useCallback(async () => {
    if (!preview) return;
    // U49：确认粘贴时把调好的参数写回规则（此前编辑仅存在于弹窗内，关闭即丢失）。
    // 仅自定义规则可写回（预设规则不改动）；正则无效或未修改时跳过
    if (!regexError && rule.id.startsWith("c_") &&
        (pattern !== rule.pattern || replacement !== rule.replacement || flags !== rule.flags)) {
      updateCustomRule(rule.id, { pattern, replacement, flags });
    }
    // U1：仅粘贴成功时弹成功提示并关闭（pasteText 失败时已自行弹错误 toast，保留对话框便于重试）
    const ok = await pasteTextGuarded(preview.result);
    if (ok) {
      toast("已粘贴替换结果", "success");
      onClose();
    }
  }, [preview, toast, onClose, regexError, rule, pattern, replacement, flags]);

  return (
    <motion.div
      {...anim.backdrop}
      className="dialog-backdrop" onClick={onClose}>
      <FocusTrap>
      <motion.div
        {...anim.panel}
        className={`dialog-box ${styles.previewDialog}`}
        onClick={(e) => e.stopPropagation()}>

          {/* Header */}
          <div className="dialog-header">
            <h2 className="dialog-title">🔍 正则替换预览 — {rule.name}</h2>
            <button onClick={onClose} className="dialog-close"><X size={16} /></button>
          </div>

          {/* Regex input bar */}
          <div className={styles.regexBar}>
            <div className={styles.regexField}>
              <label>匹配</label>
              <input
                className={`${styles.regexInput}${regexError ? ` ${styles.regexInputError}` : ""}`}
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                spellCheck={false}
              />
            </div>
            <div className={styles.regexField}>
              <label>替换</label>
              <input
                className={styles.regexInput}
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                spellCheck={false}
              />
            </div>
            <div className={styles.regexField} style={{ flex: "0 0 70px" }}>
              <label>标志</label>
              <input
                className={`${styles.regexInput} ${styles.regexFlags}`}
                value={flags}
                onChange={(e) => setFlags(e.target.value)}
                spellCheck={false}
              />
            </div>
          </div>

          {/* Error */}
          {regexError && <div className={styles.errorMsg}>⚠ {regexError}</div>}
          {previewTimeout && !regexError && (
            <div className={styles.errorMsg}>⏱ 正则执行超时（&gt;{REGEX_TIME_BUDGET_MS}ms），已自动中止 — 该正则可能存在灾难性回溯，请简化表达式</div>
          )}

          {/* Preview panes */}
          <div className={styles.previewBody}>
            <div className={styles.previewCol}>
              <div className={styles.paneLabel}>原文</div>
              <div className={styles.previewPane}>
                {highlightedOriginal
                  ? highlightedOriginal.map((p, i) =>
                      p.matched
                        ? <span key={i} className={styles.highlight}>{p.text}</span>
                        : <span key={i}>{p.text}</span>
                    )
                  : text.slice(0, 5000)}
              </div>
            </div>
            <div className={styles.previewCol}>
              <div className={styles.paneLabel}>替换结果</div>
              <div className={styles.previewPane}>
                {preview ? preview.result.slice(0, 5000) : "—"}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className={styles.footer}>
            <div className={styles.footerInfo}>
              {preview ? <>匹配 <b>{preview.matchCount}</b> 处{preview.truncated ? " · 文本已截断预览" : ""}</> : "—"}
            </div>
            <div className={styles.footerBtns}>
              <button className={styles.btn} onClick={handleCopyResult} disabled={!preview}>
                <Copy size={13} /> 复制结果
              </button>
              <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handlePaste} disabled={!preview}>
                <Check size={13} /> 确认粘贴
              </button>
            </div>
          </div>
        </motion.div>
        </FocusTrap>
      </motion.div>
  );
}
