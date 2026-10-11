import { useEffect, useState, type RefObject } from "react";

/** Both QR entry points share generation, empty-input and stale-result handling. */
export function useQrCanvas(canvas: RefObject<HTMLCanvasElement | null>, text: string, width: number, enabled = true) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const empty = text.length === 0;
  const textBytes = new TextEncoder().encode(text).length;
  const tooLong = textBytes > 2000;

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError(false);
    if (!enabled || empty) return;
    if (tooLong) { setError(true); return; }
    import("qrcode").then((QRCode) => {
      if (cancelled || !canvas.current) return;
      QRCode.toCanvas(canvas.current, text, {
        width, margin: 2,
        color: { dark: "#0F172A", light: "#FFFFFF" }, // ui-rule-ok: 二维码导出像素必须固定深色与白色静区，不能随界面主题改变。
        errorCorrectionLevel: "M",
      }, (err) => {
        if (cancelled) return;
        if (err) { setError(true); return; }
        setReady(true);
      });
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [canvas, text, width, enabled, empty, tooLong, retryKey]);

  return { ready, error, empty, textBytes, tooLong, retry: () => setRetryKey((key) => key + 1) };
}
