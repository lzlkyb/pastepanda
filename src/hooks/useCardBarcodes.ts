/**
 * useCardBarcodes — 主窗口卡片图片条目的二维码/条码懒解码（与 useCardOcr 同构）。
 *
 * 职责：
 * - 只对「可视窗口内、后端未回填 barcodes、且无缓存」的图片条目发起解码；
 * - 串行队列（同一时刻只跑 1 个 rxing 解码，避免 CPU 突发叠加）；
 * - 模块级内存缓存（path → 结果）：滚动回滚 / 多窗口共享，不重复解码；
 * - 结果以 item.id 为键返回，Card.tsx 渲染时与后端回填的 barcodes 合并决策。
 *
 * 后端 detect_barcodes_cached 自带数据库缓存（image_barcode_cache 表）：
 * 本 hook 只负责「何时触发」，解码与持久化都在后端完成。
 * 本地解码，不联网（规则 16.4，同 OCR）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { HistoryItem } from "@/stores/appStore";
import { detectBarcodesCached } from "@/lib/api";
import type { BarcodeHit, ImageBarcodeState } from "@/lib/utils";

/** 模块级内存缓存：path → 结果。会话内滚动回滚不重查库，多窗口共享。 */
const memCache = new Map<string, { status: "done" | "fail"; hits: BarcodeHit[] }>();

/** 可视窗口缓冲外扩量：与 useCardOcr / 缩略图懒加载（±4）一致。 */
const VIEW_BUFFER = 4;

export function useCardBarcodes(
  items: HistoryItem[],
  thumbFirst: number,
  thumbLast: number,
): Record<string, ImageBarcodeState> {
  const [byId, setById] = useState<Record<string, ImageBarcodeState>>({});
  const pendingRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<{ id: string; path: string }[]>([]);
  const runningRef = useRef(false);

  const drain = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    while (queueRef.current.length > 0) {
      const job = queueRef.current.shift()!;
      try {
        const hits = await detectBarcodesCached(job.path);
        memCache.set(job.path, { status: "done", hits });
        setById((prev) => ({ ...prev, [job.id]: { status: "done", hits } }));
      } catch {
        // 解码失败：本次会话不再重试（与 useCardOcr 同纪律，防反复失败刷屏）
        memCache.set(job.path, { status: "fail", hits: [] });
        setById((prev) => ({ ...prev, [job.id]: { status: "fail" } }));
      } finally {
        pendingRef.current.delete(job.id);
      }
    }
    runningRef.current = false;
  }, []);

  useEffect(() => {
    const jobs: { id: string; path: string }[] = [];
    const first = Math.max(0, thumbFirst - VIEW_BUFFER);
    const last = thumbLast + VIEW_BUFFER;
    for (let i = first; i <= last && i < items.length; i++) {
      const it = items[i];
      if (!it || it.type !== "image" || !it.content) continue;
      // 后端已持久化（含「解码过但无码」的空数组）→ 不触发。
      // ⚠️ 用 != null：Rust Option::None 序列化为 null（useCardOcr 同款教训）。
      if (it.barcodes != null) continue;
      if (memCache.has(it.content)) continue;
      if (pendingRef.current.has(it.id)) continue;
      pendingRef.current.add(it.id);
      jobs.push({ id: it.id, path: it.content });
    }
    if (jobs.length === 0) return;
    for (const j of jobs) {
      setById((prev) => ({ ...prev, [j.id]: { status: "decode" } }));
    }
    queueRef.current.push(...jobs);
    drain();
  }, [items, thumbFirst, thumbLast, drain]);

  return byId;
}
