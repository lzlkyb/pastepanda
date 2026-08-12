/**
 * ConfigDiffDialog.tsx — 配置语义对比。
 * 输入/粘贴两段配置（或选择文件）→ 自动识别格式 → key-value 对齐对比 → 高亮差异。
 * 支持跨格式对比（如 properties vs YAML）。
 */
import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, FolderOpen, ArrowLeftRight, Filter } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import { logger } from "@/lib/logger";
import styles from "./ConfigDiffDialog.module.css";

interface DiffEntry {
  key: string;
  left_value: string | null;
  right_value: string | null;
  status: "same" | "modified" | "left_only" | "right_only";
}

interface DiffResult {
  left_format: string;
  right_format: string;
  entries: DiffEntry[];
  same_count: number;
  modified_count: number;
  left_only_count: number;
  right_only_count: number;
}

type FilterMode = "all" | "diff";

const FORMAT_LABELS: Record<string, string> = {
  properties: "Properties",
  yaml: "YAML",
  json: "JSON",
};

export function ConfigDiffDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [leftText, setLeftText] = useState("");
  const [rightText, setRightText] = useState("");
  const [leftFile, setLeftFile] = useState<string | null>(null);
  const [rightFile, setRightFile] = useState<string | null>(null);
  const [result, setResult] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<FilterMode>("diff");
  const { toast } = useToast();
  const anim = useDialogAnim();

  const selectFile = useCallback(async (side: "left" | "right") => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const path = await openDialog({
        multiple: false,
        filters: [{ name: "配置文件", extensions: ["properties", "yaml", "yml", "json", "conf", "ini", "env", "cfg", "toml"] }],
      });
      if (!path) return;
      const p = Array.isArray(path) ? path[0] : path;
      if (side === "left") { setLeftFile(p); setLeftText(""); }
      else { setRightFile(p); setRightText(""); }
      setResult(null);
    } catch (e) {
      logger.warn("选择文件失败", e);
    }
  }, []);

  const runDiff = useCallback(async () => {
    setLoading(true);
    setResult(null);
    try {
      let r: DiffResult;
      if (leftFile && rightFile) {
        r = await invoke<DiffResult>("diff_config_files", { leftPath: leftFile, rightPath: rightFile });
      } else {
        const l = leftFile ? await readFilePath(leftFile) : leftText;
        const rt = rightFile ? await readFilePath(rightFile) : rightText;
        if (!l.trim() || !rt.trim()) {
          toast("请在两侧输入或选择配置内容", "error");
          setLoading(false);
          return;
        }
        r = await invoke<DiffResult>("diff_config", { left: l, right: rt });
      }
      setResult(r);
      setFilter("diff");
    } catch (e) {
      logger.warn("配置对比失败", e);
      toast(typeof e === "string" ? e : "对比失败", "error");
    } finally {
      setLoading(false);
    }
  }, [leftText, rightText, leftFile, rightFile, toast]);

  const swapSides = useCallback(() => {
    setLeftText(rightText);
    setRightText(leftText);
    setLeftFile(rightFile);
    setRightFile(leftFile);
    setResult(null);
  }, [leftText, rightText, leftFile, rightFile]);

  const visibleEntries = result
    ? filter === "all"
      ? result.entries
      : result.entries.filter((e) => e.status !== "same")
    : [];

  const shortName = (p: string) => p.split(/[/\\]/).pop() || p;

  return (
    <AnimatePresence>
      {open && (
        <motion.div {...anim.backdrop} className="dialog-backdrop" onClick={onClose}>
          <FocusTrap>
            <motion.div
              {...anim.panel}
              className={`dialog-box ${styles.dialogBox}`}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="dialog-header">
                <h2 className="dialog-title">配置对比</h2>
                <button onClick={onClose} className="dialog-close"
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "")}>
                  <X size={16} />
                </button>
              </div>

              <div className={styles.body}>
                {/* 输入区 */}
                {!result && (
                  <div className={styles.inputArea}>
                    <div className={styles.inputCol}>
                      <div className={styles.colHeader}>
                        <span className={styles.colLabel}>左侧配置</span>
                        <button className={styles.fileBtn} onClick={() => selectFile("left")} title="选择文件">
                          <FolderOpen size={13} />
                        </button>
                      </div>
                      {leftFile ? (
                        <div className={styles.fileChip}>{shortName(leftFile)}</div>
                      ) : (
                        <textarea
                          className={styles.textarea}
                          placeholder={"粘贴配置内容…\n支持 properties / YAML / JSON"}
                          value={leftText}
                          onChange={(e) => setLeftText(e.target.value)}
                          spellCheck={false}
                        />
                      )}
                    </div>

                    <button className={styles.swapBtn} onClick={swapSides} title="交换左右">
                      <ArrowLeftRight size={14} />
                    </button>

                    <div className={styles.inputCol}>
                      <div className={styles.colHeader}>
                        <span className={styles.colLabel}>右侧配置</span>
                        <button className={styles.fileBtn} onClick={() => selectFile("right")} title="选择文件">
                          <FolderOpen size={13} />
                        </button>
                      </div>
                      {rightFile ? (
                        <div className={styles.fileChip}>{shortName(rightFile)}</div>
                      ) : (
                        <textarea
                          className={styles.textarea}
                          placeholder={"粘贴配置内容…\n支持 properties / YAML / JSON"}
                          value={rightText}
                          onChange={(e) => setRightText(e.target.value)}
                          spellCheck={false}
                        />
                      )}
                    </div>
                  </div>
                )}

                {/* 对比按钮 */}
                {!result && (
                  <button className={styles.diffBtn} onClick={runDiff} disabled={loading}>
                    {loading ? "对比中…" : "开始对比"}
                  </button>
                )}

                {/* 结果区 */}
                {result && (
                  <div className={styles.resultArea}>
                    {/* 统计栏 */}
                    <div className={styles.statsBar}>
                      <div className={styles.statsLeft}>
                        <span className={styles.formatBadge}>{FORMAT_LABELS[result.left_format] || result.left_format}</span>
                        <span className={styles.vsText}>vs</span>
                        <span className={styles.formatBadge}>{FORMAT_LABELS[result.right_format] || result.right_format}</span>
                      </div>
                      <div className={styles.statsRight}>
                        <span className={styles.statItem}>
                          <i className={styles.dotModified} />{result.modified_count} 改
                        </span>
                        <span className={styles.statItem}>
                          <i className={styles.dotLeftOnly} />{result.left_only_count} 仅左
                        </span>
                        <span className={styles.statItem}>
                          <i className={styles.dotRightOnly} />{result.right_only_count} 仅右
                        </span>
                        <span className={styles.statItem}>
                          <i className={styles.dotSame} />{result.same_count} 同
                        </span>
                      </div>
                    </div>

                    {/* 过滤 + 返回 */}
                    <div className={styles.toolbar}>
                      <button
                        className={`${styles.filterBtn} ${filter === "diff" ? styles.filterActive : ""}`}
                        onClick={() => setFilter("diff")}
                      >
                        <Filter size={12} /> 仅差异
                      </button>
                      <button
                        className={`${styles.filterBtn} ${filter === "all" ? styles.filterActive : ""}`}
                        onClick={() => setFilter("all")}
                      >
                        全部
                      </button>
                      <button className={styles.backBtn} onClick={() => setResult(null)}>
                        重新对比
                      </button>
                    </div>

                    {/* Diff 表格 */}
                    <div className={styles.tableWrap}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th className={styles.thKey}>Key</th>
                            <th className={styles.thVal}>左侧值</th>
                            <th className={styles.thVal}>右侧值</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleEntries.map((entry) => (
                            <tr key={entry.key} className={styles[`row_${entry.status}`]}>
                              <td className={styles.tdKey}>{entry.key}</td>
                              <td className={styles.tdVal}>{entry.left_value ?? "—"}</td>
                              <td className={styles.tdVal}>{entry.right_value ?? "—"}</td>
                            </tr>
                          ))}
                          {visibleEntries.length === 0 && (
                            <tr>
                              <td colSpan={3} className={styles.emptyCell}>
                                {filter === "diff" ? "无差异，两侧配置完全一致" : "无数据"}
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
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

/** 读取文件内容（通过 Rust 的 read_file_text 或 diff_config_files 已处理文件路径场景） */
async function readFilePath(path: string): Promise<string> {
  // 复用 encoding 模块的读取能力：检测编码时已读取文件
  // 这里直接用 Rust 侧的 read_text_file command
  return invoke<string>("read_text_file", { path });
}
