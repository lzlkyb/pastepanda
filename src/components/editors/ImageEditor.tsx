import { useEffect, useRef } from "react";
import { useImagePreview } from "@/hooks/useImagePreview";
import { ImagePreviewDialog } from "@/components/ImagePreviewDialog";
import type { CustomEditorProps } from "@/lib/editorRegistry";

/**
 * 图片编辑器（P3，customShell 变体）。
 * 薄包装：自持 useImagePreview 实例，mount 时打开预览；
 * 用户在弹窗内关闭（Esc / 遮罩点击 → hook 状态清空）后同步关闭统一编辑器。
 * 预览状态缓存已提升为模块级（useImagePreview.ts），关闭后仍按路径记忆缩放/旋转。
 */
export function ImageEditor({ item, onClose }: CustomEditorProps) {
  const preview = useImagePreview();
  const { openImagePreview, previewImage, previewLoading } = preview;
  const openedRef = useRef(false);

  // 挂载即打开预览（openImagePreview 依赖 [toast]，引用稳定）
  useEffect(() => {
    openImagePreview(item);
  }, [openImagePreview, item]);

  // hook 关闭（状态清空）→ 同步关闭统一编辑器。
  // 必须先观察到"已打开"再清空才关，避免 mount 初始空状态误触发。
  useEffect(() => {
    if (previewImage || previewLoading) {
      openedRef.current = true;
    } else if (openedRef.current) {
      onClose();
    }
  }, [previewImage, previewLoading, onClose]);

  return <ImagePreviewDialog preview={preview} />;
}
