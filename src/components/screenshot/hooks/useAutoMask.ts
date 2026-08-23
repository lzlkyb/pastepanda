/**
 * 自动打码（P0）：OCR 定位隐私文本 -> 预览框逐个可排除 -> 确认后批量矩形马赛克。
 *
 * 从 ScreenshotOverlay 抽出来（claude.md 第 7 条 300 行上限）。与长截图同为**行为型
 * hook**：maskPreview 状态留在组件（JSX 要渲染预览框、resetShot 要清它）。
 *
 * 撤销栈不再由本 hook 自己写：调用方注入 pushUndoSnapshot ——「整批算一格撤销」这件事
 * 必须只有一处实现，否则自动打码与去水印各写一遍，改一处漏一处就是某类操作退不回去。
 *
 * 逻辑与注释按字节原样搬运，未改行为。
 */

import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";
import { ocrImage, type OcrResult } from "@/lib/api/images";
import { nextId } from "@/lib/screenshot/annotId";
import { canvasToDataUrl, loadImage } from "@/lib/screenshot/imageIo";
import { findPrivateSpans } from "@/lib/screenshot/privacy";
import type { Annotation, Rect, ScreenInfo } from "@/lib/screenshot/types";

/** 自动打码「预览式」：OCR 命中的隐私框（相对选区局部坐标），excluded=用户点掉不参与打码 */
export interface MaskBox {
  x: number;
  y: number;
  x2: number;
  y2: number;
  excluded: boolean;
}

export function useAutoMask(params: {
  ocr: OcrResult | null;
  setOcr: Dispatch<SetStateAction<OcrResult | null>>;
  screen: ScreenInfo | null;
  selRef: RefObject<Rect | null>;
  busy: boolean;
  mosaicStrength: number;
  setOcrStatus: Dispatch<SetStateAction<"idle" | "running" | "done" | "empty" | "failed">>;
  maskPreviewRef: RefObject<MaskBox[] | null>;
  setMaskPreview: Dispatch<SetStateAction<MaskBox[] | null>>;
  setAnnotations: Dispatch<SetStateAction<Annotation[]>>;
  showToast: (text: string, ok?: boolean) => void;
  /** 压入撤销快照并清空重做栈，返回快照。收口在组件里（见组件内注释）。 */
  pushUndoSnapshot: () => Annotation[];
}) {
  const {
    ocr,
    setOcr,
    screen,
    selRef,
    busy,
    mosaicStrength,
    setOcrStatus,
    maskPreviewRef,
    setMaskPreview,
    setAnnotations,
    showToast,
    pushUndoSnapshot,
  } = params;

  /* ===== 自动打码（P0）：OCR 定位隐私文本 → 批量矩形马赛克 ===== */

  /**
   * 确保已拿到选区 OCR 结果（复用「取文字」同一套管线：裁选区 → 存临时 PNG → ocrImage）。
   * - 已有结果直接返回（标注态进入时已提前 OCR，绝大多数情况走这里）；
   * - 否则现场跑一次（首屏未识别完就被点的兜底）。
   * 返回 null 表示识别不可用（图太小 / OCR 失败）。
   */
  const ensureRegionOcr = useCallback(async (): Promise<OcrResult | null> => {
    if (ocr && ocr.lines.length > 0) return ocr;
    const r = selRef.current;
    if (!r || r.w < 4 || r.h < 4 || !screen) return null;
    try {
      setOcrStatus("running");
      const img = await loadImage(screen.dataUrl);
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(r.w));
      out.height = Math.max(1, Math.round(r.h));
      const ctx = out.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);
      // 必须走 canvasToDataUrl（toBlob）—— out.toDataURL 是**同步**全尺寸 PNG 编码，
      // 2560×1440 的选区就是几百毫秒主线程冻结，用户此时点工具栏就是“点了不反应”。
      const dataUrl = await canvasToDataUrl(out);
      const tmpPath = await invoke<string>("save_screenshot_image", { dataBase64: dataUrl });
      void invoke("mark_ocr_temp", { path: tmpPath }).catch(() => {});
      const res = await ocrImage(tmpPath);
      setOcr(res);
      setOcrStatus(res.fullText?.trim() ? "done" : "empty");
      return res;
    } catch (e) {
      logger.warn("自动打码：OCR 失败", e);
      setOcrStatus("failed");
      return null;
    }
    // selRef / setOcr / setOcrStatus 是 hook 入参（原先是组件作用域，不必入表）；
    // ref 与 setState 引用恒定，补进来不会引起额外重建。
  }, [ocr, screen, selRef, setOcr, setOcrStatus]);

  /**
   * 一键自动打码：对图中命中的隐私词逐词生成矩形马赛克元素（单次撤销整体可退）。
   * 文本正则（手机/身份证/邮箱/银行卡/QQ/微信号/IP/车牌/姓名[带标签]/地址[带标签]）+ 二维码/条码，不含人脸（P0 范围）。
   */
  const runAutoMask = useCallback(async () => {
    if (busy) return; // 合成/保存中不做
    const res = await ensureRegionOcr();
    if (!res) {
      showToast("自动打码失败：文字识别未就绪", false);
      return;
    }
    const r = selRef.current;
    const baseW = r ? Math.round(r.w) : 0;
    const baseH = r ? Math.round(r.h) : 0;
    const pad = 4; // 物理像素外扩，确保整词被盖住
    const boxes: MaskBox[] = [];
    for (const line of res.lines) {
      // 隐私判定用**整行文本**：手机号/身份证/邮箱都是整串正则，拿单个字符去匹配
      // 永远命中不了（若用 w.text 判，自动打码会 100%「未发现隐私」）。
      // 但打码范围只取**命中的那几个字**：
      // ❌ 旧实现命中就盖整行，「客服电话 13800138000 工作时间 9:00-18:00」
      // 会被整条涂黑，用户想留的内容一起没了。
      if (!line.text) continue;
      const spans = findPrivateSpans(line.text);
      if (spans.length === 0) continue;
      // words 有两种形态：逐字符（后端给了 char_xn）与整行单框（兼容回退）。
      // 只有逐字形态才能定位到子串；整行单框只能退回盖整行。
      const perChar = line.words.length === Array.from(line.text).length;
      const ranges = perChar
        ? spans.map((s) => [s.start, s.end] as const)
        : ([[0, line.words.length]] as const as readonly (readonly [number, number])[]);
      for (const [from, to] of ranges) {
        let x1 = Infinity;
        let y1 = Infinity;
        let x2 = -Infinity;
        let y2 = -Infinity;
        for (let k = from; k < to; k++) {
          const w = line.words[k];
          if (!w) continue;
          x1 = Math.min(x1, w.x);
          y1 = Math.min(y1, w.y);
          x2 = Math.max(x2, w.x + w.width);
          y2 = Math.max(y2, w.y + w.height);
        }
        if (!Number.isFinite(x1)) continue;
        const x = Math.max(0, Math.round(x1) - pad);
        const y = Math.max(0, Math.round(y1) - pad);
        const xe = Math.min(baseW, Math.round(x2) + pad);
        const ye = Math.min(baseH, Math.round(y2) + pad);
        if (xe - x < 2 || ye - y < 2) continue;
        boxes.push({ x, y, x2: xe, y2: ye, excluded: false });
      }
    }
    // 二维码 / 条码：文本正则的盲区（DAMA/Snagit 都盖）。在选区位图上跑 jsQR，
    // 取 location 四角算包围盒加入预览——失败不阻断文本打码。
    try {
      if (screen && r && r.w >= 8 && r.h >= 8) {
        const img = await loadImage(screen.dataUrl);
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(r.w));
        cv.height = Math.max(1, Math.round(r.h));
        const cctx = cv.getContext("2d");
        if (cctx) {
          cctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, cv.width, cv.height);
          const id = cctx.getImageData(0, 0, cv.width, cv.height);
          const jsQR = (await import("jsqr")).default;
          const qr = jsQR(id.data, cv.width, cv.height, { inversionAttempts: "dontInvert" });
          if (qr && qr.location) {
            const loc = qr.location;
            const xs = [loc.topLeftCorner.x, loc.topRightCorner.x, loc.bottomLeftCorner.x, loc.bottomRightCorner.x];
            const ys = [loc.topLeftCorner.y, loc.topRightCorner.y, loc.bottomLeftCorner.y, loc.bottomRightCorner.y];
            const qx = Math.max(0, Math.round(Math.min(...xs)) - pad);
            const qy = Math.max(0, Math.round(Math.min(...ys)) - pad);
            const qxe = Math.min(baseW, Math.round(Math.max(...xs)) + pad);
            const qye = Math.min(baseH, Math.round(Math.max(...ys)) + pad);
            if (qxe - qx >= 2 && qye - qy >= 2) {
              boxes.push({ x: qx, y: qy, x2: qxe, y2: qye, excluded: false });
            }
          }
        }
      }
    } catch (e) {
      logger.warn("自动打码：二维码识别失败（不影响文本打码）", e);
    }

    if (boxes.length === 0) {
      showToast("未发现可打码的隐私信息（手机/身份证/邮箱/银行卡/座机/姓名/地址等）", false);
      return;
    }
    // 预览式（P3）：先显示橙色虚框轻预览，逐框可排除，确认才打马赛克，避免误伤普通文字
    maskPreviewRef.current = boxes;
    setMaskPreview(boxes);
    showToast(`识别到 ${boxes.length} 处隐私 · 点框可排除 · 全部确认即打码`, true);
  }, [ensureRegionOcr, busy, showToast, screen, selRef, maskPreviewRef, setMaskPreview]);

  /* 自动打码「预览式」：点框切换排除 / 全部确认即打码（整批一次 undo） */
  const toggleMaskBox = useCallback((i: number) => {
    setMaskPreview((prev) => {
      if (!prev) return prev;
      const next = prev.map((b, idx) => (idx === i ? { ...b, excluded: !b.excluded } : b));
      maskPreviewRef.current = next;
      return next;
    });
  }, [maskPreviewRef, setMaskPreview]);

  const applyMasks = useCallback(() => {
    const boxes = maskPreviewRef.current;
    if (!boxes) return;
    const active = boxes.filter((b) => !b.excluded);
    setMaskPreview(null);
    maskPreviewRef.current = null;
    if (active.length === 0) {
      showToast("已排除全部，未打码", false);
      return;
    }
    const els: Annotation[] = active.map((b) => ({
      id: nextId(),
      type: "mosaic",
      color: "",
      width: 0,
      x: b.x,
      y: b.y,
      x2: b.x2,
      y2: b.y2,
      strength: mosaicStrength,
      shape: "rect",
    }));
    // 整批一次入 undo，Ctrl+Z 一次性退回所有自动打码（不逐个占撤销栈）
    const prev = pushUndoSnapshot();
    setAnnotations([...prev, ...els]);
    showToast(`已自动打码 ${els.length} 处`, true);
  }, [
    mosaicStrength,
    showToast,
    pushUndoSnapshot,
    maskPreviewRef,
    setMaskPreview,
    setAnnotations,
  ]);

  // onSelectTool 不在这里：它是工具栏接线（自动打码只是它特判的一个分支），留在组件。
  return { ensureRegionOcr, runAutoMask, toggleMaskBox, applyMasks };
}
