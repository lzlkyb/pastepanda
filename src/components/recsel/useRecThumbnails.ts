/**
 * useRecThumbnails — 把录像抽成 12 张缩略帧，铺到裁剪轨道上当衬底。
 *
 * 为什么要有：改前那条轨道只是一根色带，拖到哪一段全靠百分比猜；关键帧刻度能告诉你
 * 「切点能落在哪」，但不能告诉你「切点落在哪个画面」。帧带补的就是这一格信息。
 *
 * 实现是离屏 `<video>` + canvas 逐点 seek。三个必须记下来的约束：
 *
 * 1. **canvas 会跨域污染**。预览用的是 asset 协议（`http://asset.localhost/...`），
 *    与页面不同源，`drawImage` 后 `toDataURL` 会抛 SecurityError。Tauri 的 asset
 *    协议会回显 window origin（`tauri/src/protocol/asset.rs:21` 的
 *    `Access-Control-Allow-Origin`），所以带 `crossOrigin="anonymous"` 就能取像素；
 *    为防协议实现变化，失败时再退一轮不带 CORS —— 那一轮若被污染由 catch 折成 null。
 * 2. **不显式调 `video.load()`**：设置 `src` 本身就会开始加载，而 `load()` 在 jsdom
 *    里是未实现桩（每个用例刷一条 not-implemented），测试输出会被污染成假故障。
 * 3. **卸载要能打断 seek**。`register(kill)` 把「拆 src」交给调用方：`removeAttribute("src")`
 *    会派发 `emptied`，正挂着的 `seeked` 等待立刻以 false 结束，不必等满 1.5s 超时。
 *
 * 抽帧是**增益**：任何一步失败都退回 `status: "failed"`，时间轴回到原来的灰胶囊形态。
 */
import { useEffect, useState } from "react";

export type ThumbStatus = "idle" | "loading" | "ready" | "failed";

export interface Thumbs {
  frames: string[];
  status: ThumbStatus;
}

/** 一屏 12 格：840 宽窗下每格约 70px，再多只是把同一幅画面切碎。 */
const FRAMES = 12;
/** 每格只在屏上占 70–120px，168 已够 2× 屏。 */
const FRAME_W = 168;
const JPEG_Q = 0.62;
const META_TIMEOUT_MS = 6000;
const SEEK_TIMEOUT_MS = 1500;
/** 少于 3 帧不算成功：稀稀拉拉几条比灰胶囊更像坏掉。 */
const MIN_FRAMES = 3;
/** 时长归到 200ms 桶再进依赖（见 hook 内注释）。 */
const DURATION_BUCKET_MS = 200;

const EMPTY: Thumbs = { frames: [], status: "idle" };

type Kill = () => void;

export function useRecThumbnails(src: string, durationMs: number): Thumbs {
  const [state, setState] = useState<Thumbs>(EMPTY);
  // 时长有两个来源（moov 的 stts / video 的 loadedmetadata），两者常差几毫秒；
  // 直接拿原始毫秒进依赖会让帧带抽两遍。抽帧点偏 0.2s 用户看不出来。
  const bucket = durationMs > 0 ? Math.round(durationMs / DURATION_BUCKET_MS) : 0;
  const stableMs = bucket * DURATION_BUCKET_MS;

  useEffect(() => {
    if (!src || !stableMs) {
      setState(EMPTY);
      return;
    }
    let stopped = false;
    let kill: Kill | null = null;
    setState({ frames: [], status: "loading" });
    void (async () => {
      // 传**取反**后的谓词：`grab` 里一律写 `if (!alive())`，交给它的必须是「还活着」
      const frames = await grab(src, stableMs, () => !stopped, (fn) => {
        kill = fn;
      });
      if (stopped) return;
      setState(frames ? { frames, status: "ready" } : { frames: [], status: "failed" });
    })();
    return () => {
      stopped = true;
      kill?.();
    };
  }, [src, stableMs]);

  return state;
}

async function grab(
  src: string,
  durationMs: number,
  alive: () => boolean,
  register: (kill: Kill) => void,
): Promise<string[] | null> {
  for (const cors of [true, false]) {
    if (!alive()) return null;
    const frames = await grabOnce(src, durationMs, alive, register, cors);
    if (frames) return frames;
  }
  return null;
}

async function grabOnce(
  src: string,
  durationMs: number,
  alive: () => boolean,
  register: (kill: Kill) => void,
  cors: boolean,
): Promise<string[] | null> {
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  if (cors) video.crossOrigin = "anonymous";
  register(() => {
    video.removeAttribute("src");
  });

  const frames: string[] = [];
  try {
    video.src = src;
    if (!(await settle(video, "loadedmetadata", META_TIMEOUT_MS))) return null;
    if (!alive()) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    const canvas = document.createElement("canvas");
    canvas.width = FRAME_W;
    canvas.height = Math.max(1, Math.round((FRAME_W * vh) / vw));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    for (let i = 0; i < FRAMES; i += 1) {
      if (!alive()) return null;
      // 取每格**中心**而不是格首：末格的格首就是倒计时收尾，常是纯黑
      const at = (((i + 0.5) / FRAMES) * durationMs) / 1000;
      if (!(await seek(video, at))) {
        return frames.length >= MIN_FRAMES ? frames : null;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL("image/jpeg", JPEG_Q));
    }
    return frames;
  } catch {
    // 画布被污染时只有 toDataURL 会抛（SecurityError）：本轮算失败，外层换 CORS 再来
    return frames.length >= MIN_FRAMES ? frames : null;
  } finally {
    video.removeAttribute("src");
  }
}

/** 等一个媒体事件；超时或 `error` / `emptied`（被拆掉 src）都算失败。 */
function settle(el: HTMLVideoElement, on: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (ok: boolean) => {
      if (timer !== null) clearTimeout(timer);
      el.removeEventListener(on, pass);
      el.removeEventListener("error", fail);
      el.removeEventListener("emptied", fail);
      resolve(ok);
    };
    const pass = () => finish(true);
    const fail = () => finish(false);
    timer = setTimeout(() => finish(false), timeoutMs);
    el.addEventListener(on, pass);
    el.addEventListener("error", fail);
    el.addEventListener("emptied", fail);
  });
}

async function seek(video: HTMLVideoElement, seconds: number): Promise<boolean> {
  const total = video.duration;
  if (!Number.isFinite(total) || total <= 0) return false;
  // 末尾 40ms 常常还没解出可用帧，落在那儿会画出一张黑图
  const target = Math.min(Math.max(0, seconds), Math.max(0, total - 0.04));
  if (Math.abs(video.currentTime - target) < 0.002 && video.readyState >= 2) return true;
  const done = settle(video, "seeked", SEEK_TIMEOUT_MS);
  video.currentTime = target;
  return (await done) && video.readyState >= 2;
}
