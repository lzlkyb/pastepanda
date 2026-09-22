/**
 * useRcFrames — 拉帧合成 + fps/codec 统计 + H.264 回退。
 *
 * 🔴 2026-09-19 重做取帧路径：旧实现 80~200ms 轮询 `rc_latest_frame`，
 * 帧以 base64 字符串过 JSON IPC（几百 KB/帧），再加异步 <img> 解码，
 * 每帧白添 50~150ms——拖动窗口时叠加被控端帧间隔，体感就是 PPT。
 * 现在：后端 outbox 攒帧 → `rc-frame-ready` 事件唤醒 → `rc_drain_frames`
 * 一次取走**全部**待显示帧（原始二进制，无 base64），JPEG 用
 * `createImageBitmap` 直解，H.264 走 WebCodecs。短轮询仅作事件丢失的兜底。
 *
 * 为什么必须「排队全取」而不是「取最新」：H.264 的 P 帧互相引用、
 * JPEG 脏块帧各管一块画布——丢一帧就是花屏/缺块，只能全序逐帧应用。
 *
 * P0-1 A2：抖动缓冲的延迟**整批只睡一次**——放在逐帧循环里会把
 * 一批 N 帧的等待放大 N 倍（批量越大越卡，正是它要防的场景）。
 * P0-1 A3：帧龄用时钟偏差校准（后端 pong 带回 hts 估算，EMA 进 status）；
 * 未校准（skew=0）时负帧龄被丢弃，显示值标「≈」。
 * P0-2：延迟四段拆分（采集 cap / 编码 enc / 网络 net≈ / 解码 dec），
 * 前三段来自后端随帧遥测，解码段本地实测，网络段 = 总龄 − 三段。
 * P0-1 B4：等关键帧看门狗——等待超过 3s 说明关键帧永远不会来
 *（编码器重开/链路异常），强制回 JPEG 兜底。R2：按时间判不按帧数
 *（90 帧阈值在 120fps 下只有 750ms，会误杀）。
 * P4：操作延迟 ≈ 输入发出到下一帧到达的间隔（EMA，纯本机时钟无偏差问题）。
 */
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import { rcDrainFrames, parseFrameBatch, rcSendInput, type RcBinFrame } from "@/lib/api/rc";
import { H264Decoder, type HwCodec } from "@/lib/rcH264";
import { FpsMeter } from "@/lib/rcSessionStats";

export function useRcFrames(
  sessionId: string,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  opts?: {
    /** P0-1 A3：时钟偏差（被控端 − 本机，ms）。来自 rcStatus.clock_skew_ms。 */
    clockSkewMs?: number;
    /** P4：最近一次键鼠输入发出的本地时刻（ms）；0 = 尚无输入。useRcInput 提供。 */
    lastInputAt?: React.RefObject<number>;
    /** D4：当前画质档名。fps120 档解码配置要抬 H.264 level（L5.1）。 */
    qualityHint?: string;
  },
) {
  const visible = useWindowVisible();
  const [hasFrame, setHasFrame] = useState(false);
  const [statusText, setStatusText] = useState("等待对方画面…");
  const [codec, setCodec] = useState<"jpeg" | "h264" | "hevc">("jpeg");
  const [fps, setFps] = useState(0);
  /** P2-10：画面链路延迟（采集→上屏，EMA）。0 = 尚无样本。 */
  const [latencyMs, setLatencyMs] = useState(0);
  /** 画面码率估计（kbps，1s 窗口）。0 = 尚无样本。 */
  const [bitrateKbps, setBitrateKbps] = useState(0);
  /** P0-2 延迟分段（各段 EMA；0 = 尚无样本不显示）。 */
  const [segCapMs, setSegCapMs] = useState(0);
  const [segEncMs, setSegEncMs] = useState(0);
  const [segNetMs, setSegNetMs] = useState(0);
  const [segDecMs, setSegDecMs] = useState(0);
  /** P4：操作延迟近似（输入→下一帧到达，EMA）。0 = 尚无样本。 */
  const [respMs, setRespMs] = useState(0);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const contentRef = useRef({ w: 0, h: 0 });
  const lastFrameAt = useRef(0);
  const fpsMeter = useRef(new FpsMeter());

  // skew / 输入时刻 / 画质档提示不参与取帧循环的依赖——用 ref 透传，
  // status 刷新或换档不打断播放循环
  const skewRef = useRef(0);
  const lastInputRef = useRef<React.RefObject<number> | null>(null);
  const qualityRef = useRef(opts?.qualityHint ?? "");
  useEffect(() => {
    skewRef.current = opts?.clockSkewMs ?? 0;
  }, [opts?.clockSkewMs]);
  useEffect(() => {
    lastInputRef.current = opts?.lastInputAt ?? null;
  }, [opts?.lastInputAt]);
  useEffect(() => {
    qualityRef.current = opts?.qualityHint ?? "";
  }, [opts?.qualityHint]);

  useEffect(() => {
    setHasFrame(false);
    setStatusText("等待对方画面…");
    setCodec("jpeg");
    setFps(0);
    setLatencyMs(0);
    setBitrateKbps(0);
    setSegCapMs(0);
    setSegEncMs(0);
    setSegNetMs(0);
    setSegDecMs(0);
    setRespMs(0);
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
    // P0-2：解码断链后等关键帧——期间的 delta 帧拦下不解（解了也是花屏），
    // 已向被控端要过 ForceKeyFrame，key 一到即恢复。
    let waitingKey = false;
    // R2 看门狗起点（进入等待的时刻）。❗按**时间**判不按帧数：90 帧阈值是按
    // 30fps 标定的，fps120 下只有 750ms，比 1s GOP 还短——会把好端端的会话
    // 误降级成 JPEG。
    let waitingSinceMs = 0;
    // 当前流的标准（看门狗用）：HEVC 等不到关键帧先退 H.264，H.264 才砸 JPEG
    let curStd: "h264" | "hevc" = "h264";
    // P1-10：脏块 miss 时 request_key 的限频（1s/次）
    let lastDirtyMissAt = 0;
    const forceJpeg = () => {
      h264Miss = 0;
      waitingKey = false;
      waitingSinceMs = 0;
      void rcSendInput({ kind: "set_codec", codec: "jpeg" }).catch(() => {});
    };
    // Q3：HEVC 解不动（解码器不支持/连续出错）→ 先退 H.264，别直接砸 JPEG——
    // H.264 生态稳得多；H.264 再失败由原有 forceJpeg 链兜底。
    const forceH264 = () => {
      h264Miss = 0;
      waitingKey = false;
      waitingSinceMs = 0;
      h264?.close();
      h264 = null;
      setCodec("h264");
      void rcSendInput({ kind: "set_codec", codec: "h264" }).catch(() => {});
    };

    // P2-10：画面链路延迟 EMA（采集→上屏）。at_ms 是被控端抓屏时刻（对方时钟），
    // P0-1 A3：加上时钟偏差校准（skew = 对端时钟 − 本机时钟）
    let latEma = 0;
    // P0-2 分段 EMA
    let capEma = 0;
    let encEma = 0;
    let decEma = 0;
    let netEma = 0;
    const noteLatency = (atMs: number, capMs: number, encMs: number) => {
      const age = Date.now() - atMs + skewRef.current;
      if (age < 0 || age > 10_000) return; // 时钟偏差/停顿后的一帧不算
      latEma = latEma === 0 ? age : (latEma * 7 + age) / 8;
      setLatencyMs(Math.round(latEma));
      if (capMs > 0) capEma = capEma === 0 ? capMs : (capEma * 7 + capMs) / 8;
      if (encMs > 0) encEma = encEma === 0 ? encMs : (encEma * 7 + encMs) / 8;
      // 网络段 = 总龄 − 采集 − 编码 − 解码（解码段是本地实测 EMA）。
      // 负值说明校准不足或对端没带遥测，clamp 到 0。
      if (capMs > 0 || encMs > 0) {
        const net = Math.max(0, age - capMs - encMs - decEma);
        netEma = netEma === 0 ? net : (netEma * 7 + net) / 8;
        setSegNetMs(Math.round(netEma));
      }
      setSegCapMs(Math.round(capEma));
      setSegEncMs(Math.round(encEma));
      setSegDecMs(Math.round(decEma));
    };
    // P4：操作延迟近似——输入发出 → 下一帧到达（纯本机时钟）
    const noteResponse = () => {
      const t0 = lastInputRef.current?.current ?? 0;
      if (!t0) return;
      const d = Date.now() - t0;
      if (d <= 0 || d > 500) return; // 只统计「正在等响应」的帧
      setRespMs((prev) => Math.round(prev === 0 ? d : prev * 0.7 + d * 0.3));
    };
    // P0-4：画面码率估计（1s 窗口，EMA）
    let bytesWindow = 0;
    let windowStart = 0;
    let brEma = 0;
    const noteBytes = (n: number) => {
      bytesWindow += n;
      const now = Date.now();
      if (windowStart === 0) windowStart = now;
      const span = now - windowStart;
      if (span >= 1000) {
        const kbps = Math.round((bytesWindow * 8) / span);
        brEma = brEma === 0 ? kbps : (brEma * 7 + kbps) / 8;
        setBitrateKbps(brEma);
        bytesWindow = 0;
        windowStart = now;
      }
    };

    // P1-8：自适应微抖动缓冲。弱网帧到达忽快忽慢，直接到一帧画一帧必抖；
    // 按最近 8 个到达间隔的离散度缓一点上屏（LAN 平稳时为 0）。
    const arrivalGaps: number[] = [];
    let lastArrival = 0;
    let renderDelayMs = 0;
    const computeRenderDelay = () => {
      const now = Date.now();
      if (lastArrival > 0) {
        const gap = now - lastArrival;
        if (gap > 250) {
          // M3：空闲退避把轮询间隔（最高 200ms）拉出来的 gap 不是网络抖动，
          // 混进样本会让恢复后的前几帧背上 ~50ms 的假缓冲——清空重来
          arrivalGaps.length = 0;
        } else if (gap > 0) {
          arrivalGaps.push(gap);
          if (arrivalGaps.length > 8) arrivalGaps.shift();
        }
      }
      lastArrival = now;
      if (arrivalGaps.length >= 4) {
        const max = Math.max(...arrivalGaps);
        const avg = arrivalGaps.reduce((a, b) => a + b, 0) / arrivalGaps.length;
        const target = Math.min(Math.max((max - avg) * 0.5, 0), 60);
        renderDelayMs = renderDelayMs * 0.7 + target * 0.3;
      }
      return renderDelayMs > 5 ? Math.round(renderDelayMs) : 0;
    };

    // 「门铃」：后端 outbox 有新帧时 emit rc-frame-ready。挂起一次唤醒
    //（waitNext 里 race），事件丢了也有下面的短轮询兜底。
    let unlisten: (() => void) | undefined;
    let wake: (() => void) | null = null;
    void listen("rc-frame-ready", () => {
      wake?.();
    }).then((u) => {
      if (!alive) {
        u();
        return;
      }
      unlisten = u;
    });

    const noteFrameShown = () => {
      fpsMeter.current.push();
      lastFrameAt.current = Date.now();
      setFps(fpsMeter.current.fps());
      setHasFrame(true);
      setStatusText("");
    };

    const drawJpegFrame = async (f: RcBinFrame, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
      const bmp = await createImageBitmap(new Blob([f.data], { type: "image/jpeg" }));
      try {
        if (!alive) return;
        if (f.full || !f.rect) {
          const w = f.width || bmp.width;
          const h = f.height || bmp.height;
          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
          }
          contentRef.current = { w, h };
          // 宽高没变就不 setState：fps120 下这是每帧路径，无谓的 setState
          // 会让会话视图整树按帧率重渲染
          setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
          ctx.drawImage(bmp, 0, 0);
        } else {
          // P1-10：脏块帧无基准画布 → 禁止静默丢（丢一块 = 花屏缺块）。
          // 记一次 miss 并限频向被控端要关键帧（等 full / key 自愈）。
          if (contentRef.current.w === 0) {
            const now = Date.now();
            if (now - lastDirtyMissAt > 1000) {
              lastDirtyMissAt = now;
              void rcSendInput({ kind: "request_key" }).catch(() => {});
            }
            return;
          }
          if (canvas.width !== contentRef.current.w) {
            canvas.width = contentRef.current.w;
            canvas.height = contentRef.current.h;
          }
          const r = f.rect;
          ctx.drawImage(bmp, r.x, r.y);
        }
        noteFrameShown();
      } finally {
        bmp.close();
      }
    };

    const handleH264Frame = (f: RcBinFrame) => {
      setCodec(f.codec);
      const std: HwCodec = f.codec === "hevc" ? "hevc" : "h264";
      curStd = std;
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
          setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
          cx.drawImage(vf, 0, 0);
          noteFrameShown();
        },
        () => {
          h264?.close();
          h264 = null;
          if (!waitingKey) {
            // P0-2：向被控端要一个强制 IDR（≤1s 内必到），别急着退 JPEG
            waitingKey = true;
            waitingSinceMs = Date.now();
            void rcSendInput({ kind: "request_key" }).catch(() => {});
          }
          h264Miss += 1;
          // Q3：HEVC 解码连续失败先退 H.264（生态稳），H.264 再失败才 JPEG。
          // P1-8：必须看**当前** curStd——解码器创建时的 isHevc 快照在中途换码后是错的
          //（先 HEVC 后 H.264 会误 forceH264，反之会跳过 H.264 直接砸 JPEG）。
          if (h264Miss >= 3) (curStd === "hevc" ? forceH264 : forceJpeg)();
        },
      );
      h264.ensureConfigured(
        f.width || 1280,
        f.height || 720,
        qualityRef.current === "fps120" ? 120 : 0,
        std,
      );
      if (h264.available) {
        h264Miss = 0;
        h264.decode(f.data, f.key, f.at_ms);
        return;
      }
      h264Miss += 1;
      if (h264Miss >= 3) (curStd === "hevc" ? forceH264 : forceJpeg)();
    };

    // 等待下一轮：新帧事件（立即）或兜底轮询（空闲时指数退避，最低 16ms）。
    let pollMs = 16;
    let idleMs = 0;
    const waitNext = () =>
      new Promise<void>((resolve) => {
        const timer = window.setTimeout(() => {
          wake = null;
          resolve();
        }, pollMs);
        wake = () => {
          window.clearTimeout(timer);
          wake = null;
          resolve();
        };
      });

    const tick = async () => {
      try {
        const frames = parseFrameBatch(await rcDrainFrames());
        if (!alive) return;
        if (frames.length === 0) {
          // 空转退避：静止时少跑 IPC；一有事件立刻回 16ms
          idleMs += pollMs;
          pollMs = idleMs > 1000 ? 200 : idleMs > 250 ? 64 : 16;
          return;
        }
        idleMs = 0;
        pollMs = 16;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        // P0-1 A2：弱网抖动缓冲**整批只等一次**——放在逐帧循环里会被放大 N 倍
        const delay = computeRenderDelay();
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        for (const f of frames) {
          if (f.codec !== "jpeg") {
            // P0-2：等关键帧期间拦下 delta 帧
            if (waitingKey && !f.key) {
              // R2 看门狗：等了 >3s 还没等到关键帧 → 关键帧不会来了
              //（编码器重开失败/链路异常），按当前流的标准走回退链：
              // HEVC 先退 H.264 再说，H.264 才砸 JPEG（与即时失败路径同序，
              // 2026-09-19 审查：曾一律 forceJpeg 跳过 H.264 这一级）
              if (Date.now() - waitingSinceMs > 3000) {
                if (curStd === "hevc") forceH264();
                else forceJpeg();
              }
              continue;
            }
            if (f.key) {
              waitingKey = false;
              waitingSinceMs = 0;
            }
            const decT0 = Date.now();
            handleH264Frame(f);
            const decMs = Date.now() - decT0;
            // 解码是异步产出（VideoFrame 回调）才算完——这里量的是排队+提交，
            // 回调里的绘制不计。取 EMA 时以提交耗时为主即可（量级正确）。
            if (decMs > 0) decEma = decEma === 0 ? decMs : (decEma * 7 + decMs) / 8;
            noteBytes(f.data.length);
            noteLatency(f.at_ms, f.cap_ms, f.enc_ms);
            noteResponse();
            continue;
          }
          h264Miss = 0;
          setCodec("jpeg");
          await drawJpegFrame(f, canvas, ctx);
          noteBytes(f.data.length);
          noteLatency(f.at_ms, f.cap_ms, f.enc_ms);
          noteResponse();
        }
      } catch {
        /* 单轮失败不打断 */
      }
    };

    const run = async () => {
      while (alive) {
        await tick();
        if (!alive) break;
        await waitNext();
      }
    };
    void run();

    return () => {
      alive = false;
      wake?.();
      unlisten?.();
      h264?.close();
    };
  }, [sessionId, visible, canvasRef]);

  return {
    hasFrame,
    statusText,
    codec,
    fps,
    contentRef,
    lastFrameAt,
    size,
    latencyMs,
    bitrateKbps,
    segCapMs,
    segEncMs,
    segNetMs,
    segDecMs,
    respMs,
  };
}
