/**
 * RcShortCodeQr — 8 位会合码的二维码（`PP-XXXX-XXXX`，lib/rcShortCode 收口）。
 *
 * 桌面出示侧的「可扫形态」：手机「扫一扫」扫的就是它（2026-10-01 联调补上——
 * 此前二维码只在手机出示态有，电脑上只有明文，手机举着相机没东西可扫）。
 * 大字明文码始终是主形态，二维码是附在下面的省事形态。
 *
 * 画不出来（canvas 不可用等）不弹不闹：`data-ready=0` 隐藏，明文码照样能转抄。
 */
import { useEffect, useRef, useState } from "react";
import { pairQrPayload } from "@/lib/rcShortCode";
import styles from "./RemoteComputerA2.module.css";

export function RcShortCodeQr({ code, size = 140, onError }: { code: string; size?: number; onError?: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    const canvas = ref.current;
    if (!code || !canvas) return;
    let cancelled = false;
    setReady(false);
    void (async () => {
      try {
        const QRCode = await import("qrcode");
        // 码换了 / 组件没了就别往旧画布上画：两次到达顺序不保证，后画的会盖掉先画的
        if (cancelled) return;
        await QRCode.toCanvas(canvas, pairQrPayload(code), {
          width: size,
          margin: 2,
          errorCorrectionLevel: "M",
        });
        if (!cancelled) setReady(true);
      } catch {
        if (!cancelled) errorRef.current?.();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, size]);
  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      aria-label="配对码二维码"
      className={styles.pairQr}
      data-ready={ready ? 1 : 0}
    />
  );
}
