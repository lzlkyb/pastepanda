/**
 * useRcFrames — 拉帧合成 + fps/codec 统计 + H.264 回退。
 */
import { useEffect, useRef, useState } from "react";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import { rcLatestFrame, rcSendInput } from "@/lib/api/rc";
import { H264Decoder, base64ToBytes } from "@/lib/rcH264";
import { FpsMeter } from "@/lib/rcSessionStats";

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = url;
  });
}

export function useRcFrames(sessionId: string, canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  const visible = useWindowVisible();
  const [hasFrame, setHasFrame] = useState(false);
  const [statusText, setStatusText] = useState("等待对方画面…");
  const [codec, setCodec] = useState<"jpeg" | "h264">("jpeg");
  const [fps, setFps] = useState(0);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const contentRef = useRef({ w: 0, h: 0 });
  const lastAt = useRef(0);
  const lastFrameAt = useRef(0);
  const fpsMeter = useRef(new FpsMeter());

  useEffect(() => {
    setHasFrame(false);
    setStatusText("等待对方画面…");
    setCodec("jpeg");
    setFps(0);
    lastAt.current = 0;
    lastFrameAt.current = 0;
    contentRef.current = { w: 0, h: 0 };
    fpsMeter.current.reset();
    const c = canvasRef.current;
    if (c) c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
  }, [sessionId, canvasRef]);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    let h264: H264Decoder | null = null;
    let h264Miss = 0;
    const forceJpeg = () => {
      h264Miss = 0;
      void rcSendInput({ kind: "set_codec", codec: "jpeg" }).catch(() => {});
    };

    // in-flight 守卫：解码/加载慢时，若上一帧还没落地就跳过本次 tick，
    // 避免后发的 tick 先把新帧落地、早发的 tick 后落地造成的画面回跳。
    let inflight = false;
    const tick = async () => {
      if (inflight) return;
      inflight = true;
      try {
        const f = await rcLatestFrame();
        if (!alive || !f || f.at_ms === lastAt.current) return;
        lastAt.current = f.at_ms;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        if (f.codec === "h264") {
          setCodec("h264");
          h264 ??= new H264Decoder(
            (vf) => {
              const c = canvasRef.current;
              if (!c) return;
              const cx = c.getContext("2d");
              if (!cx) return;
              const w = vf.displayWidth || vf.codedWidth;
              const h = vf.displayHeight || vf.codedHeight;
              if (c.width !== w || c.height !== h) {
                c.width = w;
                c.height = h;
              }
              contentRef.current = { w, h };
              setSize({ w, h });
              cx.drawImage(vf, 0, 0);
              fpsMeter.current.push();
              lastFrameAt.current = Date.now();
              setFps(fpsMeter.current.fps());
              setHasFrame(true);
              setStatusText("");
            },
            () => {
              h264?.close();
              h264 = null;
              h264Miss += 1;
              if (h264Miss >= 3) forceJpeg();
            },
          );
          h264.ensureConfigured(f.width || 1280, f.height || 720);
          if (h264.available) {
            h264Miss = 0;
            h264.decode(base64ToBytes(f.jpeg_base64), f.key, f.at_ms);
            return;
          }
          h264Miss += 1;
          if (h264Miss >= 3) forceJpeg();
          return;
        }

        h264Miss = 0;
        setCodec("jpeg");
        const url = `data:image/jpeg;base64,${f.jpeg_base64}`;
        const img = await loadImage(url);
        if (!alive) return;

        if (f.full || !f.rect) {
          const w = f.width || img.naturalWidth;
          const h = f.height || img.naturalHeight;
          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
          }
          contentRef.current = { w, h };
          setSize({ w, h });
          ctx.drawImage(img, 0, 0);
        } else {
          if (contentRef.current.w === 0) return;
          if (canvas.width !== contentRef.current.w) {
            canvas.width = contentRef.current.w;
            canvas.height = contentRef.current.h;
          }
          const r = f.rect;
          ctx.drawImage(img, r.x, r.y);
        }
        fpsMeter.current.push();
        lastFrameAt.current = Date.now();
        setFps(fpsMeter.current.fps());
        setHasFrame(true);
        setStatusText("");
      } catch {
        /* 单帧失败不打断 */
      } finally {
        inflight = false;
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 100);
    return () => {
      alive = false;
      window.clearInterval(t);
      h264?.close();
    };
  }, [sessionId, visible, canvasRef]);

  return { hasFrame, statusText, codec, fps, contentRef, lastFrameAt, size };
}
