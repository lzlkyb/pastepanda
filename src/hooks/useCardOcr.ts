/**
 * useCardOcr — 主窗口卡片图片条目的 OCR 懒识别（方案 B：持久化）。
 *
 * 职责：
 * - 只对「可视窗口内、后端未回填 ocr_text、且无缓存」的图片条目发起识别；
 * - 串行队列（同一时刻只跑 1 个 WinRT OCR，避免阻塞线程叠加）；
 * - 模块级内存缓存（path → 结果）：滚动回滚 / 多窗口共享，不重复识别；
 * - 结果以 item.id 为键返回，Card.tsx 渲染时与后端回填的 ocr_text 合并决策。
 *
 * 后端 ocr_image_cached 自带数据库缓存（image_ocr_cache 表）：
 * 本 hook 只负责「何时触发」，识别与持久化都在后端完成。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { HistoryItem } from "@/stores/appStore";
import { ocrImageCached } from "@/lib/api";
import type { ImageOcrState } from "@/lib/utils";

/** 模块级内存缓存：path → 结果。会话内滚动回滚不重查库，多窗口（主窗/托盘）共享。 */
const memCache = new Map<string, { status: "done" | "fail"; text: string }>();

/** 可视窗口缓冲外扩量：与缩略图懒加载（±4）一致，滚动方向提前识别。 */
const VIEW_BUFFER = 4;

export function useCardOcr(
  items: HistoryItem[],
  thumbFirst: number,
  thumbLast: number,
): Record<string, ImageOcrState> {
  const [byId, setById] = useState<Record<string, ImageOcrState>>({});
  // 已在排队/进行中的条目 id（防同一 id 重复入队）
  const pendingRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<{ id: string; path: string }[]>([]);
  const runningRef = useRef(false);

  const drain = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    while (queueRef.current.length > 0) {
      const job = queueRef.current.shift()!;
      try {
        const text = await ocrImageCached(job.path);
        memCache.set(job.path, { status: "done", text });
        setById((prev) => ({ ...prev, [job.id]: { status: "done", text } }));
      } catch {
        // 识别失败：回退文件名态，且本次会话不再重试（防反复失败刷屏）
        memCache.set(job.path, { status: "fail", text: "" });
        setById((prev) => ({ ...prev, [job.id]: { status: "fail" } }));
      } finally {
        pendingRef.current.delete(job.id);
      }
    }
    runningRef.current = false;
  }, []);

  // 可视窗口 ± 缓冲内的图片条目收集（依赖 items 引用 + 窗口范围）
  useEffect(() => {
    const jobs: { id: string; path: string }[] = [];
    const first = Math.max(0, thumbFirst - VIEW_BUFFER);
    const last = thumbLast + VIEW_BUFFER;
    for (let i = first; i <= last && i < items.length; i++) {
      const it = items[i];
      if (!it || it.type !== "image" || !it.content) continue;
      // 后端已持久化（含「识别过但无文字」的空串）→ 不触发。
      // ⚠️ 用 != null 而不是 !== undefined：Rust Option::None 序列化为 null，
      // null !== undefined 为 true，会把未识别的条目误判成「已有结果」而永不触发。
      if (it.ocr_text != null) continue;
      if (memCache.has(it.content)) continue;
      if (pendingRef.current.has(it.id)) continue;
      pendingRef.current.add(it.id);
      jobs.push({ id: it.id, path: it.content });
    }
    if (jobs.length === 0) return;
    for (const j of jobs) {
      setById((prev) => ({ ...prev, [j.id]: { status: "ocr" } }));
    }
    queueRef.current.push(...jobs);
    drain();
  }, [items, thumbFirst, thumbLast, drain]);

  return byId;
}
