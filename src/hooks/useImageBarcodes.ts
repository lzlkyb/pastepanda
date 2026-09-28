/**
 * useImageBarcodes — 预览弹窗的二维码/条码加载（与卡片侧 useCardBarcodes 不同源触发）。
 *
 * 卡片徽章通常已让后端缓存预热；这里只保证「任何打开预览的路径」都能拿到码：
 * - 后端回填的 item.barcodes 非 null → 直接用，零 IPC；
 * - 否则图片加载完成后调 detectBarcodesCached（后端 image_barcode_cache 命中即回）。
 *
 * 触发依赖 previewImage（state，加载完成才非空），路径读 previewContentRef.current —
 * 与 handleOcrRecognize 同一取值方式（裁剪/换图后 ref 即当前显示图的源路径）。
 */
import { useEffect, useState } from "react";
import { detectBarcodesCached } from "@/lib/api";
import type { BarcodeHit } from "@/lib/utils";

export interface ImageBarcodesState {
  hits: BarcodeHit[];
  loading: boolean;
}

export function useImageBarcodes(
  previewImage: string | null,
  previewContentRef: React.MutableRefObject<string | null>,
  itemBarcodes: BarcodeHit[] | null | undefined,
): ImageBarcodesState {
  const [hits, setHits] = useState<BarcodeHit[]>([]);
  const [loading, setLoading] = useState(false);

  // 后端回填优先（含空数组 = 解码过但无码）
  useEffect(() => {
    if (itemBarcodes != null) {
      setHits(itemBarcodes);
      setLoading(false);
      return;
    }
    setHits([]);
  }, [itemBarcodes]);

  useEffect(() => {
    if (!previewImage || itemBarcodes != null) return;
    const path = previewContentRef.current;
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    detectBarcodesCached(path)
      .then((r) => {
        if (!cancelled) setHits(r);
      })
      .catch(() => {
        // 后台自动解码失败保持静默（用户没主动要求识别；工具条上没有重试入口）
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // previewContentRef 由 useImagePreview 的 useRef 创建、逐层 props 传下，引用稳定；
    // 列入依赖无副作用（exhaustive-deps 不认 props 传入的 ref，必须显式列）。
  }, [previewImage, itemBarcodes, previewContentRef]);

  return { hits, loading };
}
