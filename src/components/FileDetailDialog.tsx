import { useState, useEffect, useCallback, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, FolderOpen, Copy, ExternalLink, Loader, Check } from "lucide-react";
import { useToast } from "@/components/Toast";
import { relativeTime } from "@/lib/utils";
import SourceBadge from "@/components/SourceBadge";
import { HistoryItem } from "@/stores/appStore";
import { getFileIcon, getFileIconColor } from "@/lib/source-mappings";
import { FocusTrap } from "@/components/FocusTrap";

// 预加载 Tauri API 模块
let _invoke: any = null;
let _openUrl: any = null;
const preloadApi = async () => {
  if (!_invoke) {
    const core = await import("@tauri-apps/api/core");
    _invoke = core.invoke;
  }
  if (!_openUrl) {
    const opener = await import("@tauri-apps/plugin-opener");
    _openUrl = opener.openUrl;
  }
};

export function FileDetailDialog({ item, onClose }: { item: HistoryItem; onClose: () => void }) {
  const { toast } = useToast();
  const [fileInfo, setFileInfo] = useState<{ size: number; exists: boolean } | null>(null);
  const [openingFile, setOpeningFile] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [apiReady, setApiReady] = useState(false);

  // 预加载 API + 获取文件信息
  useEffect(() => {
    preloadApi().then(() => setApiReady(true));
    async function getInfo() {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const info = await invoke<{ size: number; exists: boolean }>("get_file_info", { path: item.content });
        setFileInfo(info);
      } catch {
        setFileInfo({ size: 0, exists: false });
      }
    }
    if (item?.content) getInfo();
  }, [item]);

  // U51：Esc 关闭 + 向全局键盘层广播开关状态（本弹窗由 CardList 管理，
  // App 的 dialogStatesRef 感知不到，需靠事件让列表导航键在弹窗打开时让位）
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("app-filedetail-open"));
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.dispatchEvent(new CustomEvent("app-filedetail-close"));
    };
  }, [onClose]);

  const handleCopyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(item.content);
      toast("路径已复制", "success");
    } catch { toast("复制失败", "error"); }
  }, [item.content, toast]);

  const handleOpenFile = useCallback(async () => {
    if (openingFile || !fileInfo?.exists) return;
    setOpeningFile(true);
    try {
      await preloadApi();
      await _invoke("open_file_with_system", { path: item.content });
      toast(`已打开 ${fileName}`, "success");
    } catch (e: any) {
      toast(e?.toString?.() || "无法打开文件", "error");
    } finally {
      setOpeningFile(false);
    }
  }, [item.content, openingFile, fileInfo, toast]);

  const handleOpenFolder = useCallback(async () => {
    if (openingFolder || !fileInfo?.exists) return;
    setOpeningFolder(true);
    try {
      await preloadApi();
      await _invoke("open_file_location", { path: item.content });
    } catch (e: any) {
      toast(e?.toString?.() || "无法打开文件夹", "error");
    } finally {
      setOpeningFolder(false);
    }
  }, [item.content, openingFolder, fileInfo, toast]);

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "未知";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return `${size.toFixed(1)} ${units[i]}`;
  };

  const fileName = item.content?.split(/[\\/]/).pop() || "文件";
  const filePath = item.content || "";
  const time = relativeTime(item.time);
  const fileExists = fileInfo?.exists === true;
  const fileMissing = fileInfo?.exists === false;
  const fileIcon = getFileIcon(fileName);
  const iconColor = getFileIconColor(fileName);

  if (!item) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="dialog-backdrop" onClick={onClose}>
        <FocusTrap>
        <motion.div
          initial={{ scale: 0.96, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.96, opacity: 0, y: 20 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          className="dialog-box w380"
          onClick={(e) => e.stopPropagation()}>

          {/* Header */}
          <div className="dialog-header">
            <h2 className="dialog-title">文件详情</h2>
            <button onClick={onClose} className="dialog-close"><X size={16} /></button>
          </div>

          {/* Body */}
          <div className="dialog-body" style={{ "--dialog-body-gap": "16px" } as React.CSSProperties}>
            {/* 文件图标 + 名称 */}
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{
                width: 48, height: 48, borderRadius: 12,
                background: iconColor,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 22, flexShrink: 0,
              }}>{fileIcon}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {fileName}
                </div>
                <div style={{ fontSize: 11, marginTop: 2, color: fileMissing ? "var(--danger, #EF4444)" : "var(--text-muted)" }}>
                  {fileInfo === null ? "检查中…" : fileExists ? <><Check size={12} style={{marginRight:2,color:"#34C759"}} /> 文件正常</> : "⚠ 文件不存在或已移动"}
                </div>
              </div>
            </div>

            {/* 信息列表 */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <InfoRow label="完整路径" value={filePath} mono />
              <InfoRow label="文件大小" value={fileInfo ? formatSize(fileInfo.size) : "…"} />
              <InfoRow label="复制时间" value={item.time || "未知"} />
              <InfoRow label="来源" value={item.source ? <SourceBadge source={item.source} /> : "未知"} />
            </div>

            {/* 操作按钮 */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <FileActionBtn
                icon={openingFile ? <Loader size={14} className="spin" /> : <ExternalLink size={14} />}
                label={openingFile ? "打开中…" : "打开文件"}
                onClick={handleOpenFile}
                primary
                disabled={!fileExists || openingFile || !apiReady}
              />
              <FileActionBtn
                icon={openingFolder ? <Loader size={14} className="spin" /> : <FolderOpen size={14} />}
                label={openingFolder ? "打开中…" : "打开文件夹"}
                onClick={handleOpenFolder}
                disabled={!fileExists || openingFolder || !apiReady}
              />
              <FileActionBtn
                icon={<Copy size={14} />}
                label="复制路径"
                onClick={handleCopyPath}
              />
            </div>
          </div>

          {/* Footer */}
          <div className="dialog-footer">
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{time}</span>
            <button className="btn-primary" onClick={onClose}>关闭</button>
          </div>
        </motion.div>
        </FocusTrap>
      </motion.div>
    </AnimatePresence>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
      <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0, minWidth: 60 }}>{label}</span>
      <span style={{
        fontSize: 12, color: "var(--text-primary)", textAlign: "right", wordBreak: "break-all",
        fontFamily: mono ? "'SF Mono', Consolas, monospace" : "inherit",
        lineHeight: 1.5,
      }}>{value}</span>
    </div>
  );
}

function FileActionBtn({ icon, label, onClick, primary, disabled }: {
  icon: React.ReactNode; label: string; onClick: () => void; primary?: boolean; disabled?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8,
      border: primary ? "none" : "1px solid var(--border-color)",
      background: primary ? (disabled ? "var(--text-muted)" : "var(--accent)") : "var(--card-bg)",
      color: primary ? "#fff" : (disabled ? "var(--text-muted)" : "var(--text-secondary)"),
      fontSize: 12, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer",
      fontFamily: "inherit", transition: "all 0.15s",
      boxShadow: primary && !disabled ? "0 2px 8px rgba(0,120,212,0.25)" : "none",
      opacity: disabled ? 0.5 : 1,
    }}>
      {icon}{label}
    </button>
  );
}
