/**
 * 远程电脑「帧 / 音频」原始二进制解析。
 *
 * 从 `src/lib/api/rc.ts` 拆分而来，仅搬代码、不改行为；原始 `rc.ts` 现为本文件的
 * re-export 门面，所有 `from "@/lib/api/rc"` 的引用继续原样工作。
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  RcAudioCfg,
  RcAudioFrame,
  RcBinFrame,
  RcFramePayload,
  RcFrameRect,
} from "./rcFrameTypes";

export function rcLatestFrame(): Promise<RcFramePayload | null> {
  return invoke<RcFramePayload | null>("rc_latest_frame");
}

/**
 * 解析 `rc_drain_frames` 返回的原始字节。布局见后端 `encode_frame_batch`
 * （全部小端）：`"RCF2" u32 | count u32`，后跟 count 条
 * `codec u8 | key u8 | full u8 | has_rect u8 | at_ms i64 | cap u16 | enc u16
 *  | w u32 | h u32 | rect x,y,w,h 4×u32 | data_len u32 | data`。
 *
 * 与 `parseAudioBatch` 同语义：**截断/坏帧 break 并返回已解析部分**，绝不整批吞掉
 * ——H.264 P 帧与脏块帧全序应用，丢掉前面好帧比丢掉尾巴更伤。magic 头不合法
 * 返回空数组（不抛），避免调用方一轮 catch 吞掉后续 tick。
 */
export function parseFrameBatch(buf: ArrayBuffer): RcBinFrame[] {
  const u8 = new Uint8Array(buf);
  if (u8.length < 8 || u8[0] !== 0x52 || u8[1] !== 0x43 || u8[2] !== 0x46 || u8[3] !== 0x32) {
    return [];
  }
  const v = new DataView(buf);
  const count = v.getUint32(4, true);
  const out: RcBinFrame[] = [];
  let off = 8;
  for (let i = 0; i < count; i++) {
    if (off + 44 > u8.length) break;
    const codecByte = v.getUint8(off);
    const key = v.getUint8(off + 1) === 1;
    const full = v.getUint8(off + 2) === 1;
    const hasRect = v.getUint8(off + 3) === 1;
    const atMs = Number(v.getBigInt64(off + 4, true));
    const capMs = v.getUint16(off + 12, true);
    const encMs = v.getUint16(off + 14, true);
    const width = v.getUint32(off + 16, true);
    const height = v.getUint32(off + 20, true);
    let rect: RcFrameRect | null = null;
    if (hasRect) {
      rect = {
        x: v.getUint32(off + 24, true),
        y: v.getUint32(off + 28, true),
        w: v.getUint32(off + 32, true),
        h: v.getUint32(off + 36, true),
      };
    }
    const len = v.getUint32(off + 40, true);
    off += 44;
    if (off + len > u8.length) break;
    // 视图而非拷贝：底层 ArrayBuffer 在本轮应用完成前一直存活
    const data = new Uint8Array(buf, off, len);
    off += len;
    out.push({
      codec: codecByte === 2 ? "hevc" : codecByte === 1 ? "h264" : "jpeg",
      key,
      full,
      at_ms: atMs,
      cap_ms: capMs,
      enc_ms: encMs,
      width,
      height,
      rect,
      data,
    });
  }
  return out;
}

/** 批量取走后端攒下的全部待显示帧（H.264 P 帧与脏块帧必须全序不丢）。 */
export function rcDrainFrames(): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("rc_drain_frames");
}

/**
 * 解析 `rc_drain_audio` 返回的原始字节。布局见后端 `rc_drain_audio` 命令
 * （全部小端）：`"RCA1" u32 | count u32`，后跟 count 条
 * `type u8 | pts_ms i64 | len u32 | data`。type 0 = cfg（JSON），1 = AAC 帧。
 * 头不合法/截断返回空结果——音频可以无声，不能让解析异常打断会话。
 */
export function parseAudioBatch(
  buf: ArrayBuffer,
): { cfg: RcAudioCfg | null; items: RcAudioFrame[] } {
  const u8 = new Uint8Array(buf);
  const empty = { cfg: null, items: [] as RcAudioFrame[] };
  if (u8.length < 8 || u8[0] !== 0x52 || u8[1] !== 0x43 || u8[2] !== 0x41 || u8[3] !== 0x31) {
    return empty;
  }
  const v = new DataView(buf);
  const count = v.getUint32(4, true);
  let cfg: RcAudioCfg | null = null;
  const items: RcAudioFrame[] = [];
  let off = 8;
  for (let i = 0; i < count; i++) {
    if (off + 13 > u8.length) break;
    const type = v.getUint8(off);
    const ptsMs = Number(v.getBigInt64(off + 1, true));
    const len = v.getUint32(off + 9, true);
    off += 13;
    if (off + len > u8.length) break;
    const data = new Uint8Array(buf, off, len);
    off += len;
    if (type === 0) {
      try {
        const j = JSON.parse(new TextDecoder().decode(data)) as {
          sr: number;
          ch: number;
          asc: string;
          br: number;
        };
        const bin = atob(j.asc);
        const asc = new Uint8Array(bin.length);
        for (let k = 0; k < bin.length; k++) asc[k] = bin.charCodeAt(k);
        cfg = { sr: j.sr, ch: j.ch, asc, br: j.br };
      } catch {
        /* 坏包忽略 */
      }
    } else if (len > 0) {
      items.push({ ptsMs, data });
    }
  }
  return { cfg, items };
}

/** 批量取走后端攒下的全部音频包（每次都带当前 cfg，内容变了才重配解码器）。 */
export function rcDrainAudio(): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("rc_drain_audio");
}
