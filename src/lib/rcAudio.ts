/**
 * RcAudioPlayer — G3 会话音频播放（发起端）。
 *
 * 链路：被控端 WASAPI 环回 → 收件箱 AAC 编码 → 专用 QUIC 流 → 本端 drain
 * → WebCodecs AudioDecoder('mp4a.40.2') → AudioData → AudioBuffer →
 * AudioBufferSourceNode 按调度游标排播。
 *
 * 调度策略（拉流播放的经典做法，见 consume/schedule 注释）：
 * - 游标 cursor = 下一帧应播时刻；来一帧排一帧，帧长 = frames/sr。
 * - underrun（游标落到「当前时刻」附近）：跳到 当前+60ms 重新起跑——
 *   缓冲耗尽的正确反应是重蓄水，不是追帧。
 * - 过冲（游标领先 >600ms，标签页休眠后恢复常见）：压回 当前+250ms 弃积压。
 * - 目标延迟 ≈ 100–150ms：远程办公可接受，也扛得住 40ms 的轮询抖动。
 *
 * AAC-LC 帧相互独立：解码错误只丢一帧咔一声，没有「关键帧」概念，
 * 不存在弱网自愈链——最坏就是静音。
 */
import { parseAudioBatch, type RcAudioCfg } from "@/lib/api/rc";

export class RcAudioPlayer {
  private dec: AudioDecoder | null = null;
  private ctx: AudioContext | null = null;
  private cfgKey = "";
  private cursor = 0;

  /** 消费一批 drain 数据（40ms 一拍由 useRcAudio 驱动）。 */
  consume(buf: ArrayBuffer) {
    const { cfg, items } = parseAudioBatch(buf);
    if (cfg) this.ensureDecoder(cfg);
    if (items.length === 0) return;
    // 解码器就绪前收到的帧直接丢：没有上下文的 AAC 帧解了也是噪声
    if (!this.dec || !this.ctx) {
      if (!this.ctx) this.ensureCtx();
      if (!this.dec) return;
    }
    for (const f of items) {
      try {
        this.dec.decode(
          new EncodedAudioChunk({
            // AAC-LC 帧独立可解，每帧都是 "key"
            type: "key",
            timestamp: f.ptsMs * 1000,
            data: f.data,
          }),
        );
      } catch {
        /* 单帧坏包忽略 */
      }
    }
  }

  close() {
    try {
      this.dec?.close();
    } catch {
      /* ignore */
    }
    this.dec = null;
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.cursor = 0;
    this.cfgKey = "";
  }

  /** cfg 变了（asc/采样率/声道）才重配——每次 drain 都带 cfg，不能每次重建。 */
  private ensureDecoder(cfg: RcAudioCfg) {
    const key = `${cfg.sr}:${cfg.ch}:${hash8(cfg.asc)}`;
    if (key === this.cfgKey && this.dec) return;
    try {
      this.dec?.close();
    } catch {
      /* ignore */
    }
    this.dec = null;
    this.cfgKey = key;
    this.cursor = 0; // 新流：调度游标归零
    if (typeof AudioDecoder === "undefined") {
      console.warn("[RC 音频] 本环境无 WebCodecs AudioDecoder，静音处理");
      return;
    }
    try {
      this.dec = new AudioDecoder({
        output: (ad) => this.schedule(ad),
        error: (e) => {
          console.warn("[RC 音频] 解码器错误：", e);
          try {
            this.dec?.close();
          } catch {
            /* ignore */
          }
          this.dec = null;
        },
      });
      this.dec.configure({
        codec: "mp4a.40.2",
        sampleRate: cfg.sr,
        numberOfChannels: cfg.ch,
        description: cfg.asc,
      });
    } catch (e) {
      console.warn("[RC 音频] 解码器配置失败（静音处理）：", e);
      this.dec = null;
    }
  }

  private ensureCtx(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof AudioContext === "undefined") return null;
    try {
      this.ctx = new AudioContext();
      // 自动播放策略：会话由用户点击发起通常已解锁；万一仍 suspended，
      // 挂一次性手势恢复——点任意处开始出声。
      if (this.ctx.state === "suspended") {
        void this.ctx.resume().catch(() => armGestureResume(this.ctx as AudioContext));
      }
      return this.ctx;
    } catch {
      return null;
    }
  }

  /** AudioData → AudioBuffer → 按游标排播。 */
  private schedule(ad: AudioData) {
    const ctx = this.ensureCtx();
    if (!ctx) {
      ad.close();
      return;
    }
    try {
      const frames = ad.numberOfFrames;
      if (frames === 0) {
        ad.close();
        return;
      }
      const buf = ctx.createBuffer(ad.numberOfChannels, frames, ad.sampleRate);
      const tmp = new Float32Array(frames);
      for (let ch = 0; ch < ad.numberOfChannels; ch++) {
        ad.copyTo(tmp, { planeIndex: ch, format: "f32" });
        buf.copyToChannel(tmp, ch);
      }
      ad.close();
      const now = ctx.currentTime;
      if (this.cursor < now + 0.02) {
        this.cursor = now + 0.06; // underrun：重蓄水
      } else if (this.cursor > now + 0.6) {
        this.cursor = now + 0.25; // 休眠恢复：弃积压
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(this.cursor);
      this.cursor += frames / ad.sampleRate;
      // 排播队列自清：过冲裁剪只影响后续游标，已 start 的节点播完自动回收
    } catch (e) {
      console.warn("[RC 音频] 播放调度失败：", e);
      try {
        ad.close();
      } catch {
        /* ignore */
      }
    }
  }
}

function armGestureResume(ctx: AudioContext) {
  const resume = () => {
    void ctx.resume().catch(() => {});
    window.removeEventListener("pointerdown", resume);
  };
  window.addEventListener("pointerdown", resume);
}

/** FNV-1a 8bit：cfg 变更检测用（asc 通常 2~5 字节，防碰撞足够）。 */
function hash8(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 24;
}
