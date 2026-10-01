/**
 * RcShowQr — 出示侧的二维码（次要形态）。
 *
 * 电脑端没有摄像头，扫不了它；它服务的是「另一台手机扫一下」的场景，
 * 省掉同类型设备之间肉眼转抄 8 位码。所以主形态始终是那串大字码
 * （`RcPairCard` 里），本组件只是附在下面的小方块。
 *
 * 画布失败不抛给上层：配对卡的人话提示走 `notice` 由调用方渲染，
 * 这里只负责把「尽力画、画不出来算了」这件事做完。
 */
import { useEffect, useRef } from "react";
import { pairQrPayload } from "@/lib/rcShortCode";
import styles from "./RcDevices.module.css";

// 载荷构造已收口到 lib/rcShortCode（桌面出示侧也用它）；这里 re-export
// 保持既有 import 路径与测试锚点不变。
export { pairQrPayload };

export function RcShowQr({ code }: { code: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!code || !canvas) return;
    let cancelled = false;
    void (async () => {
      try {
        const QRCode = await import("qrcode");
        // 码换了 / 组件没了就别往旧画布上画：后画的会盖掉先画的，而两次的到达顺序不保证
        if (cancelled) return;
        await QRCode.toCanvas(canvas, pairQrPayload(code), {
          width: 160,
          margin: 2,
          errorCorrectionLevel: "M",
        });
      } catch {
        /* 画不出来不弹不闹：大字码照样能转抄，这条路只是省事 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);
  return (
    <canvas
      ref={ref}
      className={styles.pairQr}
      aria-label="我的配对码二维码"
      data-ready={code ? 1 : 0}
    />
  );
}
