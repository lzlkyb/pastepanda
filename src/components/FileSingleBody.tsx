/**
 * FileSingleBody — 文件详情弹框的单文件主体：元信息收进可折叠紧凑条。
 *
 * 从 FileDetailDialog.tsx 提出（拆件守规则 #7 的 300 行红线）。
 * 打开/定位/复制路径全部走 `lib/fileActions.ts`（旧实现里这套 handler 与预览面板、
 * 多文件列表各写了一份，口径互相漂移）。
 */
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, ExternalLink, FolderOpen, Loader, ChevronDown } from "lucide-react";
import { useToast } from "@/components/Toast";
import SourceBadge from "@/components/SourceBadge";
import { HistoryItem } from "@/stores/appStore";
import { getFileIcon, getFileIconColor } from "@/lib/source-mappings";
import { FileActionBtn, InfoRow } from "@/components/FileDetailBits";
import { formatSize, nameOf, type FileMeta } from "@/lib/fileDetail";
import { copyPath, getFileMeta, openFileWithSystem, revealInFolder } from "@/lib/fileActions";

export function SingleFileBody({ path, item, metaOpen, setMetaOpen }: {
  path: string; item: HistoryItem; metaOpen: boolean; setMetaOpen: (v: boolean) => void;
}) {
  const { toast } = useToast();
  const [fileInfo, setFileInfo] = useState<FileMeta | null>(null);
  /** U3.5：查询本身挂了。原先 catch 里直接 `{ exists: false }`，
   *  界面于是斩钉截铁地打出「⚠ 已移动或不存在」并把两个打开按钮置灰——
   *  而文件可能好好的，只是那一次 IPC 没回。这比空态更坏：它是一个**肯定句**。 */
  const [infoError, setInfoError] = useState(false);
  const [openingFile, setOpeningFile] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await getFileMeta(path);
        if (!cancelled) { setFileInfo(info); setInfoError(false); }
      } catch {
        if (!cancelled) { setFileInfo(null); setInfoError(true); }
      }
    })();
    return () => { cancelled = true; };
  }, [path]);

  const fileName = nameOf(path);
  const fileExists = fileInfo?.exists === true;
  /** 没查到状态时**不拦**操作：让用户去试，真打不开时 open_file_with_system
   *  自己会报错——那比凭一次失败的检查就把路封死要强。 */
  const canAct = fileExists || infoError;
  const fileIcon = getFileIcon(fileName);
  const iconColor = getFileIconColor(fileName);

  const handleOpenFile = useCallback(async () => {
    if (openingFile || !canAct) return;
    setOpeningFile(true);
    try { await openFileWithSystem(path, toast); }
    finally { setOpeningFile(false); }
  }, [openingFile, canAct, path, toast]);

  const handleOpenFolder = useCallback(async () => {
    if (openingFolder || !canAct) return;
    setOpeningFolder(true);
    try { await revealInFolder(path, toast); }
    finally { setOpeningFolder(false); }
  }, [openingFolder, canAct, path, toast]);

  const handleCopyPath = useCallback(() => { void copyPath(path, toast); }, [path, toast]);

  return (
    <div className="fd-body">
      {/* 可折叠紧凑条 */}
      <div
        className="fd-strip"
        role="button"
        tabIndex={0}
        onClick={() => setMetaOpen(!metaOpen)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setMetaOpen(!metaOpen); }}>
        <div className="fd-strip-icon" style={{ background: iconColor }}>{fileIcon}</div>
        <div className="fd-strip-main">
          <div className="fd-strip-name" title={fileName}>{fileName}</div>
          <div className="fd-strip-sub">
            {infoError
              // U3.5：「没查到」不能写成「不存在」。括号里那句是必要的——
              // 不加的话一行告警同样会被读成「文件出事了」。
              ? "⚠ 没查到文件状态（文件本身不一定有问题，可以直接试着打开）"
              : fileInfo === null
                ? "检查中…"
                : fileExists
                  // 语义名统一：--green 是色名，换成 --success（U6：新代码只用语义名）
                  ? <><Check size={11} style={{ marginRight: 4, color: "var(--success)" }} /> 文件正常</>
                  : "⚠ 已移动或不存在"}
          </div>
        </div>
        <ChevronDown size={16} className={`fd-strip-chev ${metaOpen ? "open" : ""}`} />
      </div>

      {metaOpen && (
        <>
          <div className="fd-info-rows">
            <InfoRow label="完整路径" value={path} mono />
            {/* infoError 时不能留着「…」不动——那是一个永远转下去的加载态。 */}
            <InfoRow label="文件大小" value={infoError ? "没查到" : fileInfo ? formatSize(fileInfo.size) : "…"} />
            <InfoRow label="复制时间" value={item.time || "未知"} />
            <InfoRow label="来源" value={item.source ? <SourceBadge source={item.source} /> : "未知"} />
          </div>
          <div className="fd-actions">
            <FileActionBtn
              icon={openingFile ? <Loader size={14} className="spin" /> : <ExternalLink size={14} />}
              label={openingFile ? "打开中…" : "打开文件"}
              onClick={() => void handleOpenFile()}
              primary
              disabled={!canAct || openingFile}
            />
            <FileActionBtn
              icon={openingFolder ? <Loader size={14} className="spin" /> : <FolderOpen size={14} />}
              label={openingFolder ? "打开中…" : "打开文件夹"}
              onClick={() => void handleOpenFolder()}
              disabled={!canAct || openingFolder}
            />
            <FileActionBtn icon={<Copy size={14} />} label="复制路径" onClick={handleCopyPath} />
          </div>
        </>
      )}
    </div>
  );
}
