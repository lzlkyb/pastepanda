import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Copy, Download } from "lucide-react";
import { useToast } from "@/components/Toast";
import styles from "./QRCodeDialog.module.css";
import { FocusTrap } from "@/components/FocusTrap";

/**
 * 二维码生成对话框
 * - 使用 qrcode 库将文本/URL 渲染为 QR Canvas
 * - 支持复制图片到剪贴板、保存为 PNG 文件
 */
export function QRCodeDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const { toast } = useToast();

  const isUrl = /^https?:\/\//i.test(text.trim());
  // 修复 U29：检测文本是否超出二维码容量（UTF-8 字节数），给出具体失败原因
  const textBytes = new TextEncoder().encode(text).length;
  const tooLong = textBytes > 2000;

  // 生成二维码
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError(false);
    import("qrcode").then((QRCode) => {
      if (cancelled || !canvasRef.current) return;
      QRCode.toCanvas(canvasRef.current, text, {
        width: 360,
        margin: 2,
        color: { dark: "#0F172A", light: "#FFFFFF" },
        errorCorrectionLevel: "M",
      }, (err) => {
        if (cancelled) return;
        if (err) { setError(true); return; }
        setReady(true);
      });
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [text, retryKey]);

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
    } catch { toast("复制失败", "error"); }
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
    } catch { toast("保存失败", "error"); }
  }, [toast]);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="dialog-backdrop" onClick={onClose}>
        <FocusTrap>
        <motion.div
          initial={{ scale: 0.96, opacity: 0, y: 10 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.96, opacity: 0, y: 10 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          className={`dialog-box ${styles.qrDialog}`}
          onClick={(e) => e.stopPropagation()}>

          <div className="dialog-header">
            <h2 className="dialog-title">📱 二维码</h2>
            <button onClick={onClose} className="dialog-close"><X size={16} /></button>
          </div>

          <div className={styles.qrBody}>
            <div className={styles.qrCanvasWrap}>
              <canvas ref={canvasRef} className={styles.qrCanvas} style={{ opacity: ready ? 1 : 0 }} />
              {!ready && !error && <div className={styles.qrLoading}>生成中…</div>}
              {error && (
                <div className={styles.qrError}>
                  <div className={styles.qrErrorMsg}>
                    {tooLong ? `文本过长（${textBytes} 字节），超出二维码容量` : "生成失败"}
                  </div>
                  {!tooLong && (
                    <button className={styles.qrRetryBtn} onClick={() => setRetryKey((k) => k + 1)}>
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
    </AnimatePresence>
  );
}
