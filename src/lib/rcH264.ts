/**
 * WebCodecs H.264 解码（R4 / R5.B）。不可用时返回 null，调用方回退 JPEG。
 * Annex-B 裸流 → VideoDecoder → ImageBitmap/VideoFrame → canvas。
 *
 * codec 串按分辨率动态选：4K 必须 High@5.1，不能写死 Baseline L3.1。
 */

export type H264Sink = (frame: VideoFrame) => void;

/** 与后端 `webcodecs_codec_str` 同口径：High profile(0x64) + level。 */
export function webcodecsCodecFor(w: number, h: number): string {
  const width = Math.max(1, w | 0);
  const height = Math.max(1, h | 0);
  let level: number;
  if (width >= 3200 || height >= 1800) level = 0x33; // 5.1
  else if (width >= 2560 || height >= 1440) level = 0x32; // 5.0
  else if (width >= 1920 || height >= 1080) level = 0x2a; // 4.2
  else level = 0x28; // 4.0
  return `avc1.6400${level.toString(16).padStart(2, "0")}`;
}

export class H264Decoder {
  private dec: VideoDecoder | null = null;
  private ok = false;
  private configured = { w: 0, h: 0, codec: "" };

  constructor(private sink: H264Sink, private onError: (e: unknown) => void) {}

  get available() {
    return this.ok;
  }

  ensureConfigured(w: number, h: number) {
    if (typeof VideoDecoder === "undefined") return;
    const codec = webcodecsCodecFor(w, h);
    // 同一 codec 串且已就绪则不重配；分辨率跨档（level 变）要重开
    if (this.dec && this.ok && this.configured.codec === codec) return;
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
      this.dec.configure({
        codec,
        optimizeForLatency: true,
        // @ts-expect-error 部分 WebView 支持 annexb
        avc: { format: "annexb" },
      });
      this.configured = { w, h, codec };
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
