/**
 * useQrScan — 手机端「扫一扫」：摄像头帧 → jsqr → 文本。
 *
 * 只为配对卡服务（扫电脑/另一台手机出示的「PP-XXXX-XXXX」码），所以它不是
 * 通用扫码器：拿到结果立即停（见下面 🔴），不做连续扫码。
 *
 * # 为什么用定时拉帧而不是 requestAnimationFrame
 *
 * 摄像头出帧是 30fps，jsqr 解一张 480px 宽的图要 10~30ms——按帧解码会长期
 * 占着 CPU 让页面发烫。4 帧/秒足够覆盖「把镜头对准码」这个动作，代价是
 * 识别最多慢 250ms，人感觉不到。
 *
 * # 🔴 停下来的四条路，少一条就是「关了口还在拍」
 *
 * ① 扫到了；② 组件卸载；③ 用户主动取消；④ 切后台（隐私 + 耗电，回前台
 * 自动续扫）。四条都必须 `track.stop()`——只清定时器的话摄像头指示灯一直
 * 亮着（移动端浏览器/WebView 的实际行为）。④ 与 ③ 分开：只有用户明确取消
 * 才清「想扫」的意图，后台暂停不清，回前台据此恢复。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { permissionErrorInfo } from "@/lib/utils";

export type ScanState =
  /** 没开扫（默认；摄像头没动） */
  | "idle"
  /** 正在要摄像头权限 / 起流 */
  | "starting"
  /** 取到流，正在拉帧解码 */
  | "scanning"
  /** 用户或系统拒绝了权限 */
  | "denied"
  /** 这台设备没有摄像头（或 https/安全上下文不满足） */
  | "unavailable"
  /** 扫到了（调用方应收拾界面） */
  | "found";

export function useQrScan(onFound: (text: string) => void) {
  const [state, setState] = useState<ScanState>("idle");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream |null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const aliveRef = useRef(true);
  /** 找到一次就够：防同一帧被多个 tick 重复命中。 */
  const foundRef = useRef(false);
  /** 用户还想扫（start 置位、用户取消清位；后台暂停不清）。 */
  const wantScanRef = useRef(false);

  /** 只停摄像头，不动意图——后台暂停与扫到后的收尾都走这里。 */
  const stopCamera = useCallback(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = undefined;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  /** 用户主动取消：连「想扫」的意图一起清，回前台不再续扫。 */
  const stop = useCallback(() => {
    wantScanRef.current = false;
    stopCamera();
  }, [stopCamera]);

  useEffect(() => {
    aliveRef.current = true;
    // 卸载即停：不等调用方记得收（规则 15.2 的反面——这里没有"假定自己一直活着"）
    return () => {
      aliveRef.current = false;
      stopCamera();
    };
  }, [stopCamera]);

  const start = useCallback(async () => {
    if (streamRef.current) return;
    wantScanRef.current = true;
    foundRef.current = false;
    setState("starting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
    } catch (error) {
      // 没摄像头、被占用或不支持安全上下文，都不能要求用户去「开权限」。
      if (!aliveRef.current) return;
      setState(permissionErrorInfo(error, "camera")?.kind === "camera" ? "denied" : "unavailable");
      return;
    }
    if (!aliveRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    streamRef.current = stream;
    setState("scanning");
    const video = videoRef.current;
    if (video) {
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        /* 自动播放被拦也继续：muted + playsInline 下多数放行；真放行不了下面拉帧会拿到 0×0 */
      }
    }

    // jsqr 动态加载：不占设备页首屏 bundle（与桌面截图兜底解码同一条路径）
    const jsQR = (await import("jsqr")).default;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      stopCamera();
      setState("unavailable");
      return;
    }

    timerRef.current = window.setInterval(() => {
      if (foundRef.current || !aliveRef.current) return;
      const v = videoRef.current;
      if (!v || !v.videoWidth || !v.videoHeight) return;
      // 长边压到 480：解码耗时随像素平方涨，而二维码不需要高分辨率
      const scale = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight));
      const w = Math.round(v.videoWidth * scale);
      const h = Math.round(v.videoHeight * scale);
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(v, 0, 0, w, h);
      try {
        const res = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, {
          inversionAttempts: "dontInvert",
        });
        if (res?.data && aliveRef.current) {
          foundRef.current = true;
          setState("found");
          stopCamera();
          onFound(res.data);
        }
      } catch {
        /* 单帧解失败不吭声：下一帧再来。jsqr 只对无法解析的输入抛错 */
      }
    }, 250);
  }, [onFound, stopCamera]);

  // 切后台停拍（隐私 + 耗电），回前台按「还想扫」自动续扫；恢复失败如实转错误态。
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        stopCamera();
      } else if (wantScanRef.current && !foundRef.current && aliveRef.current) {
        void start();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [start, stopCamera]);

  return { state, videoRef, start, stop };
}
