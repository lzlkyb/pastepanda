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
// JPEG 上屏编排（整帧覆盖 / 脏块贴块 + 两条不变量）拆在这里，本文件压在 400 行内
import { createJpegSink } from "@/lib/rcJpegSink";
// 积压时丢掉过期帧的判据（纯函数 + 单测），安全边界见该文件头
import { frameApplyStart } from "@/lib/rcFramePlan";
// 统计与抖动缓冲的纯计算收口在 rcSessionStats（2026-09-22 拆出，.ts ≤ 400 红线）；
// 本 hook 只留「取帧 → 解码 → 上屏 → setState」的编排。
import { FpsMeter, FrameStats, RenderDelayBuffer } from "@/lib/rcSessionStats";

/** 高帧率档 → 解码配置用的真实 fps（与后端档位表 interval_ms 同源）。 */
const QUALITY_FPS: Record<string, number> = {
  fps60: 60,
  fps120: 120,
  fps144: 144,
  fps165: 165,
};

export function useRcFrames(
  sessionId: string,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  opts?: {
    /** P0-1 A3：时钟偏差（被控端 − 本机，ms）。来自 rcStatus.clock_skew_ms。 */
    clockSkewMs?: number;
    /** P4：最近一次键鼠输入发出的本地时刻（ms）；0 = 尚无输入。useRcInput 提供。 */
    lastInputAt?: React.RefObject<number>;
    /** D4：当前画质档名。高帧率档解码配置要按真实 fps 抬 H.264 level（144/165 → L5.2）。 */
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
  // 帧遥测 EMA 与微抖动缓冲：纯计算在类里，换会话时 reset（与 fpsMeter 同法）
  const stats = useRef(new FrameStats());
  const jitter = useRef(new RenderDelayBuffer());

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
    stats.current.reset();
    jitter.current.reset();
    const c = canvasRef.current;
    if (c) c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
  }, [sessionId, canvasRef]);

  useEffect(() => {
    if (!visible) return;
    // 与原实现一致：EMA/抖动缓冲是 effect 局部状态——visible 每次由假转真
    // 都重置（停播期间的旧样本不该污染恢复后的延迟/码率显示）
    stats.current.reset();
    jitter.current.reset();
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

    // P2-10 / P0-2 / P0-4 / P4 / P1-8：全部 EMA 与抖动缓冲已收口到
    // FrameStats / RenderDelayBuffer（lib/rcSessionStats.ts）。这里只把
    // 类的计算结果搬进 state（getter → setState 的同步器）。
    const syncStats = () => {
      setLatencyMs(stats.current.latencyMs);
      setSegCapMs(stats.current.capMs);
      setSegEncMs(stats.current.encMs);
      setSegDecMs(stats.current.decMs);
      setSegNetMs(stats.current.netMs);
    };
    const noteLatency = (atMs: number, capMs: number, encMs: number) => {
      if (stats.current.noteLatency(atMs, capMs, encMs, skewRef.current)) syncStats();
    };
    const noteResponse = () => {
      const t0 = lastInputRef.current?.current ?? 0;
      if (stats.current.noteResponse(t0)) setRespMs(stats.current.respMs);
    };
    const noteBytes = (n: number) => {
      const kbps = stats.current.noteBytes(n);
      if (kbps != null) setBitrateKbps(kbps);
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

    // JPEG 上屏：整帧覆盖 / 脏块贴块。判据与两条不变量（宽高没变不 setState、
    // 脏块缺基准不许静默丢）都在 lib/rcJpegSink。限频用的 lastDirtyMissAt
    // 变成 sink 的内部状态，本处不必再持有。
    const drawJpegFrame = createJpegSink({
      alive: () => alive,
      content: contentRef,
      setSize,
      onShown: noteFrameShown,
      requestKey: () => {
        void rcSendInput({ kind: "request_key" }).catch(() => {});
      },
    });

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
        // 2026-09-22：fps144/fps165 档进表——1080p144/165 超出 L5.1 宏块率，
        // 解码配置必须按真实 fps 抬 L5.2（与后端编码口径一致），fps=0 会按
        // 60 兜底配出超规格之下的解码器，严格端直接拒。
        QUALITY_FPS[qualityRef.current] ?? 0,
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
        const delay = jitter.current.next();
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        // 队列积压时丢掉过期帧：一批里只要有整帧，它之前的帧就都可以安全丢
        //（判据与「哪两种情况不能丢」见 lib/rcFramePlan）。这是「操作后画面几秒
        // 才变」的直接解药——积压的每一帧都在线性放大端到端延迟。
        for (const f of frames.slice(frameApplyStart(frames))) {
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
            stats.current.noteDecode(decMs);
            noteBytes(f.data.length);
            noteLatency(f.at_ms, f.cap_ms, f.enc_ms);
            noteResponse();
            continue;
          }
          h264Miss = 0;
          setCodec("jpeg");
          // P0-2 口径补全（2026-09-22）：JPEG 路径此前**从不**量解码，HUD 上的
          // 「解码 0ms」不是「解码不耗时」而是从没测过 —— 于是
          // createImageBitmap + drawImage 的耗时就全被算进了「网络」段
          //（net 是余数：总龄 − 采集 − 编码 − 解码）。量出来才分得清
          // 「链路慢」和「本机解不动」。须在 noteLatency 之前调：net 要减它。
          const decT0 = Date.now();
          await drawJpegFrame(f, canvas, ctx);
          stats.current.noteDecode(Date.now() - decT0);
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
