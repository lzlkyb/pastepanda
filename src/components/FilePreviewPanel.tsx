/**
 * FilePreviewPanel — 文件详情弹框的快速预览主区（Tier2）。
 *
 * 分支族：图片 hero（点击放大 → 走统一图片编辑器）/ PDF 内嵌阅读 / 音视频内嵌播放 /
 * 文本预览（主体在 FileTextPreview）/ 二进制·缺失·空文件兜底。
 *
 * 从 FileDetailDialog.tsx 提出（原文件 870 行，拆件守规则 #7 的 300 行红线）。
 * 动作全部走 `lib/fileActions.ts`（打开/定位/复制收口一处）。
 */
import { useCallback } from "react";
import { Copy, ExternalLink, FolderOpen, Loader, Maximize2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import { useDialogStore } from "@/stores/dialogStore";
import { HistoryItem } from "@/stores/appStore";
import { PdfViewer } from "@/components/PdfViewer";
import { FileActionBtn } from "@/components/FileDetailBits";
import { TextPreviewBody } from "@/components/FileTextPreview";
import {
  formatSize, isAudioFile, isImageFile, isPdfFile, isPlayableMedia, isVideoFile,
  nameOf, type TextPreviewData,
} from "@/lib/fileDetail";
import { copyPath, openFileWithSystem, revealInFolder } from "@/lib/fileActions";

/** ④ 快速预览面板（主区版）：图片 hero / 音视频内嵌播放 / 文本高亮+搜索+复制全文+编辑器打开 / 二进制·缺失引导 */
export function PreviewPanel({ path, data, error, imageUrl, mediaUrl, loading, item }: {
  path: string; data: TextPreviewData | null; error: boolean; imageUrl: string; mediaUrl: string; loading: boolean; item: HistoryItem;
}) {
  const { toast } = useToast();
  const openEditor = useDialogStore((s) => s.openEditor);
  const isImage = isImageFile(path);
  const isPdf = isPdfFile(path);

  // PDF 由 PdfViewer 自行加载（pdfjs-dist，自带 loading/error 态），无需外壳 loading 遮罩

  const enlargeImage = useCallback(() => {
    openEditor({ ...item, id: `${item.id}-img`, type: "image", content: path } as HistoryItem);
  }, [openEditor, item, path]);

  const openSys = useCallback(() => { void openFileWithSystem(path, toast); }, [path, toast]);
  const openLoc = useCallback(() => { void revealInFolder(path, toast); }, [path, toast]);
  const copyP = useCallback(() => { void copyPath(path, toast); }, [path, toast]);

  if (!path) return null;

  return (
    <div className="file-preview-panel fd-preview">
      {loading && (
        <div className="file-preview-loading">
          <Loader size={13} className="spin" /> 加载预览…
        </div>
      )}

      {/* Tier2：PDF 内嵌阅读预览（pdfjs-dist，自带 loading/error 态） */}
      {isPdf && <PdfViewer path={path} />}

      {!loading && isImage && imageUrl && (
        <div className="file-preview-img-hero">
          <img src={imageUrl} alt={nameOf(path)} className="file-preview-img-big" onClick={enlargeImage} />
          <button className="file-preview-enlarge" onClick={enlargeImage} title="点击放大查看">
            <Maximize2 size={14} /> 放大查看
          </button>
        </div>
      )}

      {/* Tier2：可原生播放的音视频 → 内嵌播放器 */}
      {!loading && isVideoFile(path) && mediaUrl && (
        <div className="file-preview-media-wrap">
          <video className="file-preview-media" controls preload="metadata" src={mediaUrl}>
            当前环境不支持内嵌播放，请点「用系统播放」。
          </video>
          <div className="file-preview-toolbar">
            <FileActionBtn icon={<Copy size={14} />} label="复制路径" onClick={copyP} />
            <FileActionBtn icon={<ExternalLink size={14} />} label="用系统播放" onClick={openSys} primary />
            <FileActionBtn icon={<FolderOpen size={14} />} label="打开文件夹" onClick={openLoc} />
          </div>
        </div>
      )}

      {!loading && isAudioFile(path) && mediaUrl && (
        <div className="file-preview-media-wrap">
          <audio className="file-preview-media audio" controls preload="metadata" src={mediaUrl}>
            当前环境不支持内嵌播放，请点「用系统播放」。
          </audio>
          <div className="file-preview-toolbar">
            <FileActionBtn icon={<Copy size={14} />} label="复制路径" onClick={copyP} />
            <FileActionBtn icon={<ExternalLink size={14} />} label="用系统播放" onClick={openSys} primary />
            <FileActionBtn icon={<FolderOpen size={14} />} label="打开文件夹" onClick={openLoc} />
          </div>
        </div>
      )}

      {/* 音视频拿不到可播放源（asset 授权失败 / 文件已不在）时给出口，
          否则这一路会什么都不渲染 —— 用户只看到一片空白，不知道该点哪儿。 */}
      {!loading && isPlayableMedia(path) && !mediaUrl && (
        <div className="file-preview-empty fd-empty">
          <span>无法内嵌播放此文件</span>
          <FileActionBtn icon={<ExternalLink size={14} />} label="用系统播放" onClick={openSys} />
        </div>
      )}

      {!loading && isImage && !imageUrl && (
        <div className="file-preview-empty fd-empty">
          <span>无法加载图片预览</span>
          <FileActionBtn icon={<ExternalLink size={14} />} label="用系统打开" onClick={openSys} />
        </div>
      )}

      {/* U3.5：读失败——下面那几个分支全靠 data?.kind，data 为 null 时谁都不命中，
          结果是一块空白。图片 / 音视频 / PDF 各自有兜底态，这里只管其余。 */}
      {!loading && error && !isImage && !isPdf && !isPlayableMedia(path) && (
        <div className="file-preview-empty fd-empty">
          <span>没能读出预览内容</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>文件本身不一定有问题，可以直接用系统打开看看</span>
          <FileActionBtn icon={<ExternalLink size={14} />} label="用系统打开" onClick={openSys} />
        </div>
      )}

      {!loading && !isImage && data?.kind === "text" && data.lines.length > 0 && (
        <TextPreviewBody data={data} path={path} />
      )}

      {!loading && !isImage && data?.kind === "binary" && (
        <div className="file-preview-empty fd-empty">
          <span>🧩 二进制文件 · {formatSize(data.file_size)}</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>无法内联预览，可在系统中打开查看</span>
          <FileActionBtn icon={<ExternalLink size={14} />} label="用系统打开" onClick={openSys} />
        </div>
      )}

      {!loading && !isImage && data?.kind === "missing" && (
        <div className="file-preview-empty fd-empty">
          <span style={{ color: "var(--danger)" }}>⚠ 文件不存在或已移动</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>可打开原所在文件夹确认</span>
          <FileActionBtn icon={<FolderOpen size={14} />} label="打开所在文件夹" onClick={openLoc} />
        </div>
      )}

      {!loading && !isImage && data?.kind === "text" && data.lines.length === 0 && (
        <div className="file-preview-empty fd-empty">空文件</div>
      )}
    </div>
  );
}
