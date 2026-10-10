/**
 * QrCanvas — 把任意文本画成二维码画布的**唯一出口**（规则 11.1 收口）。
 *
 * 远程配对码（`RcShortCodeQr`）和关于页的「手机 App 下载」共用这一条渲染路径：
 * 懒加载 `qrcode` → `toCanvas`，口径钉死为**深块浅底、margin:2、errorCorrectionLevel "M"**
 * （对齐 NN/g 二维码判据：不反色、留静区边距）。改动出码口径只动这一处。
 *
 * 画不出来（canvas 不可用、qrcode 加载失败）不弹不闹：`data-ready=0` + `onError`，
 * 由调用方决定降级形态（配对码降级成明文码，下载码降级成「复制链接/打开下载页」）。
 * 出码成功经 `onReady` 回报——调用方要显示「生成中」占位（下载卡首次进关于页时
 * qrcode 是懒加载，中间那 ~百毫秒是空白）就靠它把占位收掉，而不必自己猜就绪状态。
 */
import { useEffect, useRef, useState } from "react";

export function QrCanvas({
  text,
  size = 140,
  className,
  ariaLabel = "二维码",
  onError,
  onReady,
}: {
  text: string;
  size?: number;
  className?: string;
  ariaLabel?: string;
  onError?: () => void;
  onReady?: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

  useEffect(() => {
    const canvas = ref.current;
    if (!text || !canvas) return;
    let cancelled = false;
    setReady(false);
    void (async () => {
      try {
        const QRCode = await import("qrcode");
        // 内容换了 / 组件没了就别往旧画布上画：两次到达顺序不保证，后画的会盖掉先画的
        if (cancelled) return;
        await QRCode.toCanvas(canvas, text, {
          width: size,
          margin: 2,
          errorCorrectionLevel: "M",
        });
        if (!cancelled) {
          setReady(true);
          readyRef.current?.();
        }
      } catch {
        if (!cancelled) errorRef.current?.();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [text, size]);

  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      aria-label={ariaLabel}
      className={className}
      data-ready={ready ? 1 : 0}
    />
  );
}
