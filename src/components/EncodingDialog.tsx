/**
 * EncodingDialog.tsx — 编码检测与批量转码。
 * 选择文件 → 检测编码 → 选目标编码 → 预览 → 执行转换（自动备份 .bak）。
 */
import { useState, useCallback, useRef } from "react";
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

/** 列表项 = 探测结果 + 失败标记。
 *  探测失败的文件以前直接不入列表（静默丢弃）：选 20 个、挂了 5 个，
 *  列表只剩 15 行，转换又报「15/15 成功」——用户合理地以为整目录都转完了，
 *  而那几个没转的文件会在别处炸掉。现在失败项也入列表、标「无法读取」且不参与转换。 */
type FileEntry = DetectResult & { failed?: boolean };

/** 无法读取时的占位行 */
const failedEntry = (path: string): FileEntry => ({
  path,
  encoding: "无法读取",
  confidence: 0,
  has_bom: false,
  failed: true,
});

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
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [targetEnc, setTargetEnc] = useState("utf-8");
  const [removeBom, setRemoveBom] = useState(false);
  const [converting, setConverting] = useState(false);
  const [results, setResults] = useState<ConvertResult[] | null>(null);
  // 扫描进度：200 个 .properties = 200 次串行 IPC，期间弹窗原本什么都不动，
  // 用户以为没点上会再点一次又起一轮。现在按钮禁用 + 显示「已扫描 37/200」。
  const [scanning, setScanning] = useState<{ done: number; total: number } | null>(null);
  // 取消标志（U1：>10s 的操作必须能中断）。用 ref 而非 state：
  // 循环里读的必须是最新值，state 在闭包里会永远是启动时的 false。
  const cancelledRef = useRef(false);
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
      cancelledRef.current = false;
      setScanning({ done: 0, total: pathArr.length });
      const detected: FileEntry[] = [];
      let failedCount = 0;
      for (const p of pathArr) {
        if (cancelledRef.current) break; // 用户点了「取消扫描」
        try {
          const r = await invoke<DetectResult>("detect_file_encoding", { path: p });
          detected.push(r);
        } catch (e) {
          logger.warn(`检测编码失败: ${p}`, e);
          detected.push(failedEntry(p)); // 不再静默丢弃
          failedCount++;
        }
        setScanning((s) => (s ? { ...s, done: s.done + 1 } : s));
      }
      setFiles(detected);
      setResults(null);
      if (failedCount > 0) {
        toast(`${failedCount} 个文件无法读取，已在列表中标出且不会参与转换`, "error");
      }
    } catch (e) {
      logger.warn("选择文件失败", e);
    } finally {
      setScanning(null);
    }
  }, [toast]);

  const selectFolder = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true });
      if (!dir) return;
      // 读取目录下所有文本文件
      const { readDir } = await import("@tauri-apps/plugin-fs");
      const entries = await readDir(dir as string);
      const textExts = new Set(["txt", "sql", "properties", "yaml", "yml", "json", "xml", "csv", "log", "conf", "ini", "env", "md"]);
      // 先把待扫清单算出来，才能给出分母（「37/200」而不是「已扫 37」）
      const targets = entries
        .filter((entry) => entry.isFile && textExts.has(entry.name.split(".").pop()?.toLowerCase() ?? ""))
        .map((entry) => `${dir}/${entry.name}`);
      cancelledRef.current = false;
      setScanning({ done: 0, total: targets.length });
      const detected: FileEntry[] = [];
      let failedCount = 0;
      for (const fullPath of targets) {
        if (cancelledRef.current) break;
        try {
          const r = await invoke<DetectResult>("detect_file_encoding", { path: fullPath });
          detected.push(r);
        } catch (e) {
          logger.warn(`检测编码失败: ${fullPath}`, e);
          detected.push(failedEntry(fullPath));
          failedCount++;
        }
        setScanning((s) => (s ? { ...s, done: s.done + 1 } : s));
      }
      setFiles(detected);
      setResults(null);
      if (detected.length === 0) toast("该目录下没有可识别的文本文件", "info");
      else if (failedCount > 0) {
        toast(`${failedCount} 个文件无法读取，已在列表中标出且不会参与转换`, "error");
      }
    } catch (e) {
      logger.warn("选择文件夹失败", e);
    } finally {
      setScanning(null);
    }
  }, [toast]);

  /** 可参与转换的文件：探测失败的必须排除，否则后端会拿到一个读不出编码的文件去重写 */
  const convertable = files.filter((f) => !f.failed);

  const executeConvert = useCallback(async () => {
    const targets = files.filter((f) => !f.failed);
    if (targets.length === 0) return;
    setConverting(true);
    try {
      const paths = targets.map((f) => f.path);
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
                {/* hover 背景交给 dialog.css 的 .dialog-close:hover；inline style 会压掉主题定制 */}
                <button onClick={onClose} className="dialog-close">
                  <X size={16} />
                </button>
              </div>

              <div className="dialog-body" style={{ gap: 12 }}>
                {/* 文件选择 */}
                <div className={styles.fileActions}>
                  {/* 扫描中两个「选择…」都禁用：否则用户以为没点中、再点一次会叠起第二轮扫描。
                      opacity 写在 inline：EncodingDialog.module.css 没有 .btn:disabled 规则，
                      光加 disabled 属性看上去和可点无异 */}
                  <button className={styles.btn} onClick={selectFiles} disabled={scanning !== null}
                    style={scanning ? { opacity: 0.5, cursor: "not-allowed" } : undefined}>
                    <FolderOpen size={14} /> 选择文件
                  </button>
                  <button className={styles.btn} onClick={selectFolder} disabled={scanning !== null}
                    style={scanning ? { opacity: 0.5, cursor: "not-allowed" } : undefined}>
                    <FolderOpen size={14} /> 选择文件夹
                  </button>
                  {/* 扫描中：进度 + 可中断。不给进度的话，200 个文件期间界面零变化，
                      看上去和「没点中」一模一样 */}
                  {scanning && (
                    <>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--text-secondary)" }}>
                        <RefreshCw size={12} className={styles.spin} /> 已扫描 {scanning.done}/{scanning.total}
                      </span>
                      <button className={styles.btn} onClick={() => { cancelledRef.current = true; }}>
                        取消扫描
                      </button>
                    </>
                  )}
                </div>

                {/* 文件列表 */}
                {files.length > 0 && (
                  <div className={styles.fileList}>
                    {files.map((f) => (
                      <div key={f.path} className={styles.fileRow}>
                        <span className={styles.fileName} title={f.path}>
                          {f.path.split(/[/\\]/).pop()}
                        </span>
                        {/* 失败行用危险色标出，并在 title 里说清楚它不会被转换（而不是静默消失） */}
                        <span
                          className={styles.encBadge}
                          style={f.failed ? { color: "var(--danger)" } : undefined}
                          title={f.failed ? "无法读取，本次转换会跳过该文件" : undefined}
                        >{f.encoding}{f.has_bom ? " +BOM" : ""}</span>
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
                  disabled={convertable.length === 0 || converting || scanning !== null}
                  onClick={executeConvert}
                >
                  {converting ? <RefreshCw size={14} className={styles.spin} /> : <RefreshCw size={14} />}
                  {converting ? "转换中…" : `转换 ${convertable.length} 个文件为 ${TARGET_ENCODINGS.find((e) => e.value === targetEnc)?.label}`}
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
