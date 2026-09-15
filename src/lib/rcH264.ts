/**
 * WebCodecs H.264 解码（R4）。不可用时返回 null，调用方回退 JPEG。
 * Annex-B 裸流 → VideoDecoder → ImageBitmap/VideoFrame → canvas。
 */

export type H264Sink = (frame: VideoFrame) => void;

export class H264Decoder {
  private dec: VideoDecoder | null = null;
  private ok = false;

  constructor(private sink: H264Sink, private onError: (e: unknown) => void) {}

  get available() {
    return this.ok;
  }

  ensureConfigured(w: number, h: number) {
    if (this.dec) return;
    if (typeof VideoDecoder === "undefined") return;
    try {
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
      // Baseline 66 / level 3.1 — 覆盖 1080p
      this.dec.configure({
        codec: "avc1.42001f",
        optimizeForLatency: true,
        // @ts-expect-error 部分 WebView 支持 annexb
        avc: { format: "annexb" },
      });
      this.ok = true;
      void w;
      void h;
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
