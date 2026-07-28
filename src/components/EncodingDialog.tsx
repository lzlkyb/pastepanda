/**
 * EncodingDialog.tsx — 编码检测与批量转码。
 * 选择文件 → 检测编码 → 选目标编码 → 预览 → 执行转换（自动备份 .bak）。
 */
import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, FolderOpen, RefreshCw, CheckCircle2, XCircle } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import { logger } from "@/lib/logger";
import styles from "./EncodingDialog.module.css";

interface DetectResult {
  path: string;
  encoding: string;
  confidence: number;
  has_bom: boolean;
}

interface ConvertResult {
  path: string;
  ok: boolean;
  backup_path: string | null;
  error: string | null;
}

const TARGET_ENCODINGS = [
  { value: "utf-8", label: "UTF-8" },
  { value: "gbk", label: "GBK" },
  { value: "big5", label: "Big5" },
  { value: "shift_jis", label: "Shift_JIS" },
  { value: "euc-kr", label: "EUC-KR" },
  { value: "iso-8859-1", label: "ISO-8859-1" },
];

export function EncodingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [files, setFiles] = useState<DetectResult[]>([]);
  const [targetEnc, setTargetEnc] = useState("utf-8");
  const [removeBom, setRemoveBom] = useState(false);
  const [converting, setConverting] = useState(false);
  const [results, setResults] = useState<ConvertResult[] | null>(null);
  const { toast } = useToast();
  const anim = useDialogAnim();

  const selectFiles = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const paths = await open({
        multiple: true,
        filters: [{ name: "文本文件", extensions: ["txt", "sql", "properties", "yaml", "yml", "json", "xml", "csv", "log", "conf", "ini", "env", "md"] }],
      });
      if (!paths || (Array.isArray(paths) && paths.length === 0)) return;
      const pathArr = Array.isArray(paths) ? paths : [paths];
      const detected: DetectResult[] = [];
      for (const p of pathArr) {
        try {
          const r = await invoke<DetectResult>("detect_file_encoding", { path: p });
          detected.push(r);
        } catch (e) {
          logger.warn(`检测编码失败: ${p}`, e);
        }
      }
      setFiles(detected);
      setResults(null);
    } catch (e) {
      logger.warn("选择文件失败", e);
    }
  }, []);

  const selectFolder = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true });
      if (!dir) return;
      // 读取目录下所有文本文件
      const { readDir } = await import("@tauri-apps/plugin-fs");
      const entries = await readDir(dir as string);
      const textExts = new Set(["txt", "sql", "properties", "yaml", "yml", "json", "xml", "csv", "log", "conf", "ini", "env", "md"]);
      const detected: DetectResult[] = [];
      for (const entry of entries) {
        if (!entry.isFile) continue;
        const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
        if (!textExts.has(ext)) continue;
        const fullPath = `${dir}/${entry.name}`;
        try {
          const r = await invoke<DetectResult>("detect_file_encoding", { path: fullPath });
          detected.push(r);
        } catch { /* skip unreadable */ }
      }
      setFiles(detected);
      setResults(null);
      if (detected.length === 0) toast("该目录下没有可识别的文本文件", "info");
    } catch (e) {
      logger.warn("选择文件夹失败", e);
    }
  }, [toast]);

  const executeConvert = useCallback(async () => {
    if (files.length === 0) return;
    setConverting(true);
    try {
      const paths = files.map((f) => f.path);
      const r = await invoke<ConvertResult[]>("batch_convert_encoding", {
        paths,
        targetEncoding: targetEnc,
        removeBom,
      });
      setResults(r);
      const okCount = r.filter((x) => x.ok).length;
      toast(`转换完成：${okCount}/${r.length} 成功`, okCount === r.length ? "success" : "info");
    } catch (e) {
      logger.warn("批量转码失败", e);
      toast("转码失败", "error");
    } finally {
      setConverting(false);
    }
  }, [files, targetEnc, removeBom, toast]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div {...anim.backdrop} className="dialog-backdrop" onClick={onClose}>
          <FocusTrap>
            <motion.div {...anim.panel} className="dialog-box w460" onClick={(e) => e.stopPropagation()}>
              <div className="dialog-header">
                <h2 className="dialog-title">编码转换</h2>
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
                </div>

                {/* 文件列表 */}
                {files.length > 0 && (
                  <div className={styles.fileList}>
                    {files.map((f) => (
                      <div key={f.path} className={styles.fileRow}>
                        <span className={styles.fileName} title={f.path}>
                          {f.path.split(/[/\\]/).pop()}
                        </span>
                        <span className={styles.encBadge}>{f.encoding}{f.has_bom ? " +BOM" : ""}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* 目标编码 */}
                <div className={styles.targetRow}>
                  <label className={styles.label}>目标编码</label>
                  <select className={styles.select} value={targetEnc} onChange={(e) => setTargetEnc(e.target.value)}>
                    {TARGET_ENCODINGS.map((enc) => (
                      <option key={enc.value} value={enc.value}>{enc.label}</option>
                    ))}
                  </select>
                  <label className={styles.checkLabel}>
                    <input type="checkbox" checked={removeBom} onChange={(e) => setRemoveBom(e.target.checked)} />
                    去除 BOM
                  </label>
                </div>

                {/* 执行按钮 */}
                <button
                  className={styles.convertBtn}
                  disabled={files.length === 0 || converting}
                  onClick={executeConvert}
                >
                  {converting ? <RefreshCw size={14} className={styles.spin} /> : <RefreshCw size={14} />}
                  {converting ? "转换中…" : `转换为 ${TARGET_ENCODINGS.find((e) => e.value === targetEnc)?.label}`}
                </button>

                {/* 结果 */}
                {results && (
                  <div className={styles.results}>
                    {results.map((r) => (
                      <div key={r.path} className={`${styles.resultRow} ${r.ok ? styles.resultOk : styles.resultErr}`}>
                        {r.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                        <span className={styles.resultName}>{r.path.split(/[/\\]/).pop()}</span>
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
