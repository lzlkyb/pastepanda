/**
 * FileDetailDialog — 文件详情弹框外壳（shell only）。
 *
 *  本文件只管：路径解析 → 预览加载（含 asset 授权）→ 路由到三个主体。
 *  主体各自拆家：`FileSingleBody`（单文件）/ `FileMultiBody`（多文件）/
 *  `FilePreviewPanel`（Tier2 快速预览主区）。
 *
 *  拆件前本文件 870 行（≈3 倍红线），且「打开/定位/复制」在三个主体里各写了一份
 *  try/catch + toast，口径互相漂移；现动作收口在 `lib/fileActions.ts`，
 *  纯判断收口在 `lib/fileDetail.ts`（规则 #11.1）。
 */
import { useState, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { useDialogAnim } from "@/lib/dialogMotion";
import { relativeTime, parseFilePaths } from "@/lib/utils";
import { HistoryItem } from "@/stores/appStore";
import { getImageDataUrl } from "@/lib/api";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogEscape } from "@/hooks/useDialogEscape";
import { SingleFileBody } from "@/components/FileSingleBody";
import { MultiFileBody } from "@/components/FileMultiBody";
import { PreviewPanel } from "@/components/FilePreviewPanel";
import {
  isImageFile, isPdfFile, isPlayableMedia,
  type TextPreviewData,
} from "@/lib/fileDetail";
import { allowMediaAsset, readTextPreview } from "@/lib/fileActions";

export function FileDetailDialog({ item, onClose }: { item: HistoryItem; onClose: () => void }) {
  const anim = useDialogAnim();
  // 多文件支持：content 可能是 JSON 数组 / 换行分隔的多路径，也可能是单路径。
  const paths = useMemo(() => {
    const p = parseFilePaths(item?.content || "");
    return p.length > 0 ? p : (item?.content ? [item.content] : []);
  }, [item?.content]);
  const isMulti = paths.length > 1;
  const time = relativeTime(item.time);
  const [metaOpen, setMetaOpen] = useState(false);

  // ④ 快速预览共享状态：单文件模式默认选中唯一路径，多文件模式默认选中第一个。
  const [previewPath, setPreviewPath] = useState<string>(paths[0] || "");
  const [previewData, setPreviewData] = useState<TextPreviewData | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string>("");
  const [mediaUrl, setMediaUrl] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  /** U3.5：读预览抛异常。原先 catch 只把 data 置 null，而文本类文件的渲染分支
   *  全都挂在 `data?.kind` 上——null 时**一个分支都不命中**，预览区就完全空白，
   *  没有任何文字告诉用户发生了什么。 */
  const [previewError, setPreviewError] = useState(false);

  useEffect(() => {
    if (!paths.length) { setPreviewPath(""); return; }
    if (!paths.includes(previewPath)) setPreviewPath(paths[0]);
  }, [paths, previewPath]);

  useEffect(() => {
    setPreviewData(null);
    setPreviewError(false);
    setImagePreviewUrl("");
    setMediaUrl("");
    if (!previewPath) return;
    let cancelled = false;
    // loading 必须在同步阶段就置起来：留在下面的 async IIFE 里的话，
    // 本次 commit 会带着 loading=false + 空 url 先渲染一帧，
    // 把「无法内嵌播放 / 无法加载图片预览」这类兜底态闪一下再被真数据顶掉。
    setPreviewLoading(true);
    (async () => {
      try {
        if (isImageFile(previewPath)) {
          const url = await getImageDataUrl(previewPath);
          if (!cancelled) setImagePreviewUrl(url || "");
        } else if (isPdfFile(previewPath)) {
          // PDF 由 PdfViewer 自行加载（pdfjs-dist），不读后端文本预览
        } else if (isPlayableMedia(previewPath)) {
          // 音视频不读后端内容，走 asset 协议直接喂给 <video>/<audio>。
          // 但 tauri.conf 的 assetProtocol.scope 只有 $APPDATA/**，用户复制进来的原始
          // 路径在 scope 外会被拦成 403 —— 而 convertFileSrc 只是字符串拼接，永远"成功"，
          // 表现就是播放器静默不动。所以先让 Rust 按需把这个文件加进白名单（同一套
          // canonicalize + 扩展名校验），拿回规范化路径再转 asset://。
          const allowed = await allowMediaAsset(previewPath);
          const { convertFileSrc } = await import("@tauri-apps/api/core");
          const url = convertFileSrc(allowed);
          if (!cancelled) setMediaUrl(url || "");
        } else {
          const data = await readTextPreview(previewPath);
          if (!cancelled) setPreviewData(data);
        }
      } catch {
        if (!cancelled) { setPreviewData(null); setPreviewError(true); }
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [previewPath]);

  // Esc 关闭（公共 hook：捕获期 + stopPropagation）。
  // 原先是普通冒泡监听，App 的 Esc 链不认识本弹窗，会跟着落到链尾隐藏主窗口。
  useDialogEscape(onClose);

  // U51：向全局键盘层广播开关状态
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("app-filedetail-open"));
    return () => {
      window.dispatchEvent(new CustomEvent("app-filedetail-close"));
    };
  }, [onClose]);

  if (!item) return null;

  return (
    <motion.div
      {...anim.backdrop}
      className="dialog-backdrop" onClick={onClose}>
      <FocusTrap>
      <motion.div
        {...anim.panel}
        className={`dialog-box w420 fd-dialog`}
        onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="dialog-header">
          <h2 className="dialog-title">{isMulti ? `📁 文件详情 · ${paths.length} 个文件` : "📁 文件详情"}</h2>
          <button className="dialog-close" onClick={onClose}><X size={16} /></button>
        </div>

        {isMulti
          ? <MultiFileBody paths={paths} item={item} onSelectPreview={setPreviewPath} selectedPath={previewPath} />
          : <SingleFileBody path={paths[0] || item.content || ""} item={item} metaOpen={metaOpen} setMetaOpen={setMetaOpen} />}

        {/* ④ 快速预览 —— 改为占据主区（flex:1） */}
        <PreviewPanel
          path={previewPath}
          data={previewData}
          error={previewError}
          imageUrl={imagePreviewUrl}
          mediaUrl={mediaUrl}
          loading={previewLoading}
          item={item}
        />

        {/* Footer */}
        <div className="dialog-footer">
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{time}</span>
          <button className="btn-primary" onClick={onClose}>关闭</button>
        </div>
      </motion.div>
      </FocusTrap>
    </motion.div>
  );
}
