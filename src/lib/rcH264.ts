/**
 * WebCodecs H.264/HEVC 解码（R4 / R5.B / Q3）。不可用时返回 null，调用方回退。
 * Annex-B 裸流 → VideoDecoder → ImageBitmap/VideoFrame → canvas。
 *
 * H.264 codec 串按分辨率动态选：4K 必须 High@5.1，不能写死 Baseline L3.1。
 * HEVC（Q3）：Main profile，无 description 的 `hev1` 串 = Annex-B，与 H.264
 * 同一约定；level L4.0=120 / L5.1=153（general_level_idc = 30×level）。
 */

export type H264Sink = (frame: VideoFrame) => void;
/** 硬编流标准（与后端 FrameCodec / 帧元数据 `c` 字段同口径）。 */
export type HwCodec = "h264" | "hevc" | "av1";

/** 与后端 `h264_level_for` 同口径：High profile(0x64) + level。 */
export function webcodecsCodecFor(w: number, h: number, fps = 0): string {
  const width = Math.max(1, w | 0);
  const height = Math.max(1, h | 0);
  let level: number;
  if (width >= 3200 || height >= 1800) level = 0x33; // 5.1
  else if (width >= 2560 || height >= 1440) level = 0x32; // 5.0
  else if (width >= 1920 || height >= 1080) level = 0x2a; // 4.2
  else level = 0x28; // 4.0
  // D4：level 的宏块率上限不含帧率维度——1080p120 超出 L4.2 约 87%，
  // fps > 60 一律抬到 5.1，与后端编码口径一致
  if (fps > 60 && level < 0x33) level = 0x33;
  // Q4：宏块率精确校验（与后端同表，只升不降）——4K60 = 32400MB/帧 × 60
  // ≈ 194 万 MB/s，连 L5.1 都超约一倍，必须 L5.2。
  const frameMbs =
    Math.ceil(width / 16) * Math.ceil(height / 16) * Math.max(1, fps | 0);
  for (const [lv, maxMbs] of [
    [0x28, 245_760],
    [0x2a, 522_240],
    [0x30, 589_824],
    [0x33, 983_040],
    [0x34, 2_073_600],
  ] as const) {
    if (frameMbs <= maxMbs) {
      if (lv > level) level = lv;
      break;
    }
  }
  return `avc1.6400${level.toString(16).padStart(2, "0")}`;
}

/**
 * Q3：HEVC 解码串。level 按 luma 采样率（w×h×fps）取最小覆盖档——
 * HEVC Main tier 的 MaxLumaSr：L4.0=66.7M、L4.1=133.7M、L5.0=267.4M、L5.1=534.8M。
 * 与后端 `webcodecs_hevc_str` 同口径（2026-09-19 审查修复：旧二分把 1080p60 /
 * 1440p 系列压进 L4.0，超规格 1.9~3.3 倍，严格解码端会拒）。
 */
export function webcodecsHevcFor(w: number, h: number, fps = 0): string {
  const width = Math.max(1, w | 0);
  const height = Math.max(1, h | 0);
  // fps=0 = 未指定：实际流至少 30fps，按 60 兜最坏（宁可报高一档，
  // 不能把解码端配置在流规格之下）
  const f = fps === 0 ? 60 : Math.max(1, fps);
  const lumaSr = width * height * f;
  const levelIdc =
    lumaSr > 534_768_640
      ? 156 // L5.2
      : lumaSr > 267_382_784
        ? 153 // L5.1
        : lumaSr > 133_691_392
          ? 150 // L5.0
          : lumaSr > 66_732_480
            ? 123 // L4.1
            : 120; // L4.0
  return `hev1.1.6.L${levelIdc}.B0`;
}

/**
 * P2.3：AV1 解码串。`av01.<profile>.<level><tier>.<bitdepth>`：
 * profile 0 = Main 4:2:0 8bit；tier M = Main；level 按 AV1 MaxLumaSr 表取
 * 最小覆盖档（4.0=8.3M / 4.1=17.6M / 4.2=24.3M / 5.0=49.8M / 5.1=106.4M / 5.2=213.4M
 * samples/s）；bitdepth 08。不带 description = low-overhead OBU 流（与后端
 * nvenc 输出一致）。
 */
export function webcodecsAv1For(w: number, h: number, fps = 0): string {
  const f = fps === 0 ? 60 : Math.max(1, fps);
  const lumaSr = Math.max(1, w) * Math.max(1, h) * f;
  const levelIdx =
    lumaSr > 213_389_312
      ? 16 // 6.0
      : lumaSr > 106_420_080
        ? 14 // 5.2
        : lumaSr > 49_766_400
          ? 13 // 5.1
          : lumaSr > 24_322_048
            ? 10 // 4.2
            : lumaSr > 17_567_232
              ? 9 // 4.1
              : 8; // 4.0
  return `av01.0.0${levelIdx}M.08`;
}

export class H264Decoder {
  private dec: VideoDecoder | null = null;
  private ok = false;
  private configured = { w: 0, h: 0, codec: "", std: "" };

  constructor(private sink: H264Sink, private onError: (e: unknown) => void) {}

  get available() {
    return this.ok;
  }

  /**
   * 解码器内部排队深度（EncodedVideoChunk 已提交未产出）。
   * drop-to-latest 判据用：积压 = 后续每一帧的显示都线性变旧。
   */
  get queueSize() {
    return this.dec?.decodeQueueSize ?? 0;
  }

  /**
   * 丢弃队列里所有未解码的 chunk（P1.2 drop-to-latest）。
   * VideoDecoder.reset() 回到「已配置」空队列状态，不需要重新 configure；
   * 调用方必须随后进入 waitingKey（P 帧引用链已断，delta 帧全部拦下）并
   * 向被控端要关键帧——H.264 不能中间丢帧，flush+等关键帧是唯一的
   * 「丢过期」方式（Moonlight 同款思路，代价是 ≤1 个 GOP 的冻结）。
   */
  dropPending() {
    try {
      this.dec?.reset();
    } catch (e) {
      this.onError(e);
    }
  }

  ensureConfigured(w: number, h: number, fps = 0, std: HwCodec = "h264") {
    if (typeof VideoDecoder === "undefined") return;
    const codec =
      std === "hevc"
        ? webcodecsHevcFor(w, h, fps)
        : std === "av1"
          ? webcodecsAv1For(w, h, fps)
          : webcodecsCodecFor(w, h, fps);
    // 同一 codec 串且已就绪则不重配；标准或分辨率跨档（level 变）要重开
    if (this.dec && this.ok && this.configured.codec === codec && this.configured.std === std)
      return;
    try {
      if (this.dec) {
        try {
          this.dec.close();
        } catch {
          /* ignore */
        }
        this.dec = null;
      }
      this.dec = new VideoDecoder({
        output: (frame) => {
          try {
            this.sink(frame);
          } finally {
            frame.close();
          }
        },
        error: (e) => this.onError(e),
      });
      // HEVC 没有 `avc` 配置块；不带 description 的 hev1 串即 Annex-B（与 H.264 同约）。
      // 条件展开会绕过 TS 对 `avc` 这个非标字段的检查，运行时行为不变。
      this.dec.configure({
        codec,
        optimizeForLatency: true,
        ...(std === "h264" ? { avc: { format: "annexb" } } : {}),
      });
      this.configured = { w, h, codec, std };
      this.ok = true;
    } catch (e) {
      this.onError(e);
      this.dec = null;
      this.ok = false;
    }
  }

  decode(chunkData: Uint8Array, key: boolean, timestamp: number) {
    if (!this.dec || !this.ok) return;
    try {
      const chunk = new EncodedVideoChunk({
        type: key ? "key" : "delta",
        timestamp,
        data: chunkData,
      });
      this.dec.decode(chunk);
    } catch (e) {
      this.onError(e);
    }
  }

  close() {
    try {
      this.dec?.close();
    } catch {
      /* ignore */
    }
    this.dec = null;
    this.ok = false;
  }
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
