/**
 * BatchReplaceDialog.tsx — 文件级批量查找替换。
 * 选择文件 → 输入查找/替换 → 预览命中 → 执行替换（自动备份 .bak）。
 */
import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, FolderOpen, Search, Replace, CheckCircle2, XCircle } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import { logger } from "@/lib/logger";
import styles from "./BatchReplaceDialog.module.css";

interface MatchInfo {
  line: number;
  col: number;
  context: string;
}

interface PreviewResult {
  path: string;
  match_count: number;
  matches: MatchInfo[];
  error: string | null;
}

interface ReplaceResult {
  path: string;
  ok: boolean;
  replaced_count: number;
  backup_path: string | null;
  error: string | null;
}

export function BatchReplaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [paths, setPaths] = useState<string[]>([]);
  const [pattern, setPattern] = useState("");
  const [replacement, setReplacement] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(true);
  const [previewResults, setPreviewResults] = useState<PreviewResult[] | null>(null);
  const [replaceResults, setReplaceResults] = useState<ReplaceResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const anim = useDialogAnim();

  const selectFiles = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ multiple: true });
      if (!selected) return;
      const arr = Array.isArray(selected) ? selected : [selected];
      setPaths(arr as string[]);
      setPreviewResults(null);
      setReplaceResults(null);
    } catch (e) {
      logger.warn("选择文件失败", e);
    }
  }, []);

  const selectFolder = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true });
      if (!dir) return;
      const { readDir } = await import("@tauri-apps/plugin-fs");
      const entries = await readDir(dir as string);
      const filePaths = entries
        .filter((e) => e.isFile)
        .map((e) => `${dir}/${e.name}`);
      setPaths(filePaths);
      setPreviewResults(null);
      setReplaceResults(null);
      toast(`已选择 ${filePaths.length} 个文件`, "info");
    } catch (e) {
      logger.warn("选择文件夹失败", e);
    }
  }, [toast]);

  const doPreview = useCallback(async () => {
    if (paths.length === 0 || !pattern) return;
    setLoading(true);
    try {
      const r = await invoke<PreviewResult[]>("preview_replace", {
        paths,
        pattern,
        isRegex,
        caseSensitive,
      });
      setPreviewResults(r);
      setReplaceResults(null);
    } catch (e) {
      logger.warn("预览失败", e);
      toast("预览失败", "error");
    } finally {
      setLoading(false);
    }
  }, [paths, pattern, isRegex, caseSensitive, toast]);

  const doReplace = useCallback(async () => {
    if (paths.length === 0 || !pattern) return;
    setLoading(true);
    try {
      const r = await invoke<ReplaceResult[]>("execute_replace", {
        paths,
        pattern,
        replacement,
        isRegex,
        caseSensitive,
      });
      setReplaceResults(r);
      const okCount = r.filter((x) => x.ok).length;
      const totalReplaced = r.reduce((sum, x) => sum + x.replaced_count, 0);
      toast(`替换完成：${okCount}/${r.length} 文件，共 ${totalReplaced} 处`, "success");
    } catch (e) {
      logger.warn("替换失败", e);
      toast("替换失败", "error");
    } finally {
      setLoading(false);
    }
  }, [paths, pattern, replacement, isRegex, caseSensitive, toast]);

  const totalMatches = previewResults?.reduce((s, r) => s + r.match_count, 0) ?? 0;

  return (
    <AnimatePresence>
      {open && (
        <motion.div {...anim.backdrop} className="dialog-backdrop" onClick={onClose}>
          <FocusTrap>
            <motion.div {...anim.panel} className="dialog-box w460" onClick={(e) => e.stopPropagation()}>
              <div className="dialog-header">
                <h2 className="dialog-title">批量替换</h2>
                <button onClick={onClose} className="dialog-close"
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "")}>
                  <X size={16} />
                </button>
              </div>

              <div className="dialog-body" style={{ gap: 12 }}>
                {/* 文件选择 */}
                <div className={styles.fileActions}>
                  <button className={styles.btn} onClick={selectFiles}>
                    <FolderOpen size={14} /> 选择文件
                  </button>
                  <button className={styles.btn} onClick={selectFolder}>
                    <FolderOpen size={14} /> 选择文件夹
                  </button>
                  {paths.length > 0 && (
                    <span className={styles.fileCount}>{paths.length} 个文件</span>
                  )}
                </div>

                {/* 查找/替换输入 */}
                <div className={styles.inputGroup}>
                  <div className={styles.inputRow}>
                    <Search size={14} className={styles.inputIcon} />
                    <input
                      className={styles.input}
                      placeholder="查找内容…"
                      value={pattern}
                      onChange={(e) => setPattern(e.target.value)}
                    />
                  </div>
                  <div className={styles.inputRow}>
                    <Replace size={14} className={styles.inputIcon} />
                    <input
                      className={styles.input}
                      placeholder="替换为…（支持 $1 $2 捕获组）"
                      value={replacement}
                      onChange={(e) => setReplacement(e.target.value)}
                    />
                  </div>
                </div>

                {/* 选项 */}
                <div className={styles.options}>
                  <label className={styles.checkLabel}>
                    <input type="checkbox" checked={isRegex} onChange={(e) => setIsRegex(e.target.checked)} />
                    正则表达式
                  </label>
                  <label className={styles.checkLabel}>
                    <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
                    区分大小写
                  </label>
                </div>

                {/* 操作按钮 */}
                <div className={styles.actions}>
                  <button className={styles.previewBtn} disabled={!pattern || paths.length === 0 || loading} onClick={doPreview}>
                    预览
                  </button>
                  <button className={styles.replaceBtn} disabled={!pattern || paths.length === 0 || loading} onClick={doReplace}>
                    {loading ? "执行中…" : "执行替换"}
                  </button>
                </div>

                {/* 预览结果 */}
                {previewResults && (
                  <div className={styles.preview}>
                    <div className={styles.previewHeader}>
                      共 {totalMatches} 处匹配
                    </div>
                    <div className={styles.previewList}>
                      {previewResults.filter((r) => r.match_count > 0).map((r) => (
                        <div key={r.path} className={styles.previewFile}>
                          <div className={styles.previewFileName}>
                            {r.path.split(/[/\\]/).pop()} ({r.match_count})
                          </div>
                          {r.matches.slice(0, 5).map((m, i) => (
                            <div key={i} className={styles.previewMatch}>
                              <span className={styles.matchLoc}>L{m.line}:{m.col}</span>
                              <span className={styles.matchCtx}>{m.context}</span>
                            </div>
                          ))}
                          {r.matches.length > 5 && (
                            <div className={styles.previewMore}>…还有 {r.matches.length - 5} 处</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 替换结果 */}
                {replaceResults && (
                  <div className={styles.results}>
                    {replaceResults.map((r) => (
                      <div key={r.path} className={`${styles.resultRow} ${r.ok ? styles.resultOk : styles.resultErr}`}>
                        {r.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                        <span className={styles.resultName}>{r.path.split(/[/\\]/).pop()}</span>
                        {r.ok && r.replaced_count > 0 && (
                          <span className={styles.resultCount}>{r.replaced_count} 处</span>
                        )}
                        {r.error && <span className={styles.resultError}>{r.error}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
