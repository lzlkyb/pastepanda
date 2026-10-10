import { useEffect, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { X, Copy, Download } from "lucide-react";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { errText } from "@/lib/utils";
import styles from "./QRCodeDialog.module.css";
import { FocusTrap } from "@/components/FocusTrap";
import { useQrCanvas } from "@/hooks/useQrCanvas";

/**
 * 二维码生成对话框
 * - 使用 qrcode 库将文本/URL 渲染为 QR Canvas
 * - 支持复制图片到剪贴板、保存为 PNG 文件
 */
export function QRCodeDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { ready, error, empty, textBytes, tooLong, retry } = useQrCanvas(canvasRef, text, 360);
  const { toast } = useToast();
  const anim = useDialogAnim();

  const isUrl = /^https?:\/\//i.test(text.trim());

  // 键盘关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleCopyImage = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) { toast("复制失败", "error"); return; }
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("已复制二维码图片", "success");
    } catch (e) { toast("复制失败：" + errText(e, "未知错误"), "error"); }
  }, [toast]);

  const handleSavePng = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath: "qrcode.png",
        filters: [{ name: "PNG 图片", extensions: ["png"] }],
      });
      if (!path) return;
      const dataUrl = canvas.toDataURL("image/png");
      const base64 = dataUrl.split(",")[1];
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      await writeFile(path, bytes);
      toast("已保存 PNG", "success");
    } catch (e) { toast("保存失败：" + errText(e, "未知错误"), "error"); }
  }, [toast]);

  return (
    <motion.div
      {...anim.backdrop}
      className="dialog-backdrop" onClick={onClose}>
      <FocusTrap>
      <motion.div
        {...anim.panel}
        className={`dialog-box ${styles.qrDialog}`}
        onClick={(e) => e.stopPropagation()}>

          <div className="dialog-header">
            <h2 className="dialog-title">📱 二维码</h2>
            <button onClick={onClose} className="dialog-close"><X size={16} /></button>
          </div>

          <div className={styles.qrBody}>
            <div className={styles.qrCanvasWrap}>
              <canvas ref={canvasRef} className={styles.qrCanvas} style={{ opacity: ready ? 1 : 0 }} />
              {!ready && !error && <div className={styles.qrLoading}>{empty ? "等待文本内容" : "生成中…"}</div>}
              {error && (
                <div className={styles.qrError}>
                  <div className={styles.qrErrorMsg}>
                    {tooLong ? `文本过长（${textBytes} 字节），超出二维码容量` : "生成失败"}
                  </div>
                  {!tooLong && (
                    <button className={styles.qrRetryBtn} onClick={retry}>
                      重试
                    </button>
                  )}
                </div>
              )}
            </div>
            <span className={styles.qrTypeBadge}>{isUrl ? "🔗 URL" : "📝 文本"}</span>
            <div className={styles.qrContent}>{text.length > 200 ? text.slice(0, 200) + "…" : text}</div>
          </div>

          <div className={styles.qrFooter}>
            <button className={`${styles.qrBtn} ${styles.qrBtnPrimary}`} onClick={handleCopyImage} disabled={!ready}>
              <Copy size={13} /> 复制图片
            </button>
            <button className={styles.qrBtn} onClick={handleSavePng} disabled={!ready}>
              <Download size={13} /> 保存 PNG
            </button>
          </div>
        </motion.div>
        </FocusTrap>
      </motion.div>
  );
}
