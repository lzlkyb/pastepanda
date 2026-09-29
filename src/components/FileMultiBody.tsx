/**
 * FileMultiBody — 文件详情弹框的多文件主体：汇总信息 + 可滚动文件列表 + 批量操作。
 *
 * 从 FileDetailDialog.tsx 提出（拆件守规则 #7 的 300 行红线）。
 * 行内/批量的打开、定位、复制全部走 `lib/fileActions.ts`（旧实现里这三件动作与
 * 单文件壳、预览面板各写了一份，口径互相漂移）。
 */
import { useCallback, useEffect, useState } from "react";
import { Copy, ExternalLink, FolderOpen, Loader } from "lucide-react";
import { useToast } from "@/components/Toast";
import SourceBadge from "@/components/SourceBadge";
import { HistoryItem } from "@/stores/appStore";
import { getFileIcon, getFileIconColor } from "@/lib/source-mappings";
import { FileActionBtn, RowIconBtn } from "@/components/FileDetailBits";
import { formatSize, nameOf, type FileMeta } from "@/lib/fileDetail";
import { copyAllPaths, copyPath, getFileMeta, openAllFolders, openFileWithSystem, revealInFolder } from "@/lib/fileActions";

export function MultiFileBody({ paths, item, onSelectPreview, selectedPath }: {
  paths: string[]; item: HistoryItem; onSelectPreview: (p: string) => void; selectedPath: string;
}) {
  const { toast } = useToast();
  const [infoMap, setInfoMap] = useState<Record<string, FileMeta>>({});
  /** U3.5（多文件版）：查失败的那几个。原先它们被当成 `exists:false`，
   *  汇总行会报「⚠ N 已移动」——把「没查成」累加成了一个关于用户文件的肯定断言。 */
  const [failedPaths, setFailedPaths] = useState<Set<string>>(new Set());
  const [busyPath, setBusyPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const failed = new Set<string>();
      const entries = await Promise.all(paths.map(async (p) => {
        try {
          const info = await getFileMeta(p);
          return [p, info] as const;
        } catch {
          failed.add(p);
          return [p, { size: 0, exists: false }] as const;
        }
      }));
      if (!cancelled) { setInfoMap(Object.fromEntries(entries)); setFailedPaths(failed); }
    })();
    return () => { cancelled = true; };
  }, [paths]);

  const loaded = Object.keys(infoMap).length > 0;
  const okCount = paths.filter((p) => infoMap[p]?.exists).length;
  const failedCount = paths.filter((p) => failedPaths.has(p)).length;
  const missingCount = paths.length - okCount - failedCount;
  const totalSize = paths.reduce((s, p) => s + (infoMap[p]?.exists ? infoMap[p].size : 0), 0);

  const openFile = useCallback(async (p: string) => {
    if (busyPath) return;
    setBusyPath(p);
    try { await openFileWithSystem(p, toast); }
    finally { setBusyPath(null); }
  }, [busyPath, toast]);

  const openFolder = useCallback(async (p: string) => {
    if (busyPath) return;
    setBusyPath(p);
    try { await revealInFolder(p, toast); }
    finally { setBusyPath(null); }
  }, [busyPath, toast]);

  const copyOne = useCallback((p: string) => { void copyPath(p, toast); }, [toast]);

  const handleCopyAll = useCallback(() => { void copyAllPaths(paths, toast); }, [paths, toast]);

  /** 没查到状态的也包进来（U3.5）：它们不是「确认不存在」，真开不成计入 failedTotal。 */
  const isOpenable = useCallback(
    (p: string) => infoMap[p]?.exists === true || failedPaths.has(p),
    [infoMap, failedPaths],
  );

  const handleOpenAllFolders = useCallback(() => {
    void openAllFolders(paths, isOpenable, toast);
  }, [paths, isOpenable, toast]);

  return (
    <div className="fd-body" style={{ gap: 12 }}>
      {/* 汇总信息 */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        padding: "8px 12px", borderRadius: 8, background: "var(--section-bg)",
      }}>
        <span style={{ fontSize: 20 }}>🗂</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{paths.length} 个文件</span>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>共 {loaded ? formatSize(totalSize) : "…"}</span>
        {loaded && (
          <>
            <span style={{ fontSize: 11, color: "var(--success)" }}>✓ {okCount} 正常</span>
            {missingCount > 0 && <span style={{ fontSize: 11, color: "var(--danger)" }}>⚠ {missingCount} 已移动</span>}
            {/* 单列一档：它不是「文件没了」，而是「我没问出来」，用中性色。 */}
            {failedCount > 0 && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>? {failedCount} 没查到</span>}
          </>
        )}
        <span style={{ marginLeft: "auto" }}>
          {item.source ? <SourceBadge source={item.source} /> : null}
        </span>
      </div>

      {/* 文件列表（点击行切换预览） */}
      <div style={{
        display: "flex", flexDirection: "column", gap: 8,
        maxHeight: 240, overflowY: "auto", paddingRight: 4,
      }}>
        {paths.map((p) => {
          const info = infoMap[p];
          const failed = failedPaths.has(p);
          const exists = info?.exists === true;
          // 查失败的不算 missing（否则行上会红着写「已移动或不存在」）。
          const missing = info?.exists === false && !failed;
          const name = nameOf(p);
          const busy = busyPath === p;
          const isSelected = p === selectedPath;
          return (
            <div
              key={p}
              onClick={() => onSelectPreview(p)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelectPreview(p); }}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
                borderRadius: 8, cursor: "pointer",
                border: `1px solid ${isSelected ? "var(--accent)" : "var(--border-color)"}`,
                background: isSelected ? "color-mix(in srgb, var(--accent) 8%, var(--card-bg))" : "var(--card-bg)",
                transition: "border-color 0.15s, background 0.15s",
              }}>
              <div style={{
                width: 34, height: 34, borderRadius: 8, background: getFileIconColor(name),
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0,
              }}>{getFileIcon(name)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p}>
                  {name}
                </div>
                <div style={{ fontSize: 11, marginTop: 4, color: missing ? "var(--danger)" : "var(--text-muted)" }}>
                  {!info ? "检查中…" : failed ? "? 没查到状态" : exists ? `${formatSize(info.size)} · 正常` : "⚠ 已移动或不存在"}
                </div>
              </div>
              {/* 没查到状态的行不置灰：让用户去试，真打不开会自己报错。 */}
              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                <RowIconBtn title="打开文件" disabled={(!exists && !failed) || busy} onClick={(e) => { e.stopPropagation(); void openFile(p); }}>
                  {busy ? <Loader size={13} className="spin" /> : <ExternalLink size={13} />}
                </RowIconBtn>
                <RowIconBtn title="打开文件夹" disabled={(!exists && !failed) || busy} onClick={(e) => { e.stopPropagation(); void openFolder(p); }}>
                  <FolderOpen size={13} />
                </RowIconBtn>
                <RowIconBtn title="复制路径" onClick={(e) => { e.stopPropagation(); copyOne(p); }}>
                  <Copy size={13} />
                </RowIconBtn>
              </div>
            </div>
          );
        })}
      </div>

      {/* 批量操作 */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <FileActionBtn
          icon={<FolderOpen size={14} />}
          label="打开全部文件夹"
          onClick={handleOpenAllFolders}
          primary
          disabled={!loaded || (okCount === 0 && failedCount === 0)}
        />
        <FileActionBtn
          icon={<Copy size={14} />}
          label="复制全部路径"
          onClick={handleCopyAll}
        />
      </div>
    </div>
  );
}
