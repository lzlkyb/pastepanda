/**
 * rcSendFiles — 手机端发文件到电脑：分块经 Tauri 原始 IPC 上载（2026-10-01）。
 *
 * 为什么分块：Android WebView 里 `<input type="file">` 拿到的 File 只能在
 * JS 内存里读——一个 512MB 的 arrayBuffer 就能把渲染进程顶爆。按 4MB 一块
 * `slice().arrayBuffer()`，内存峰值恒定在「一块」。
 *
 * 后端 `rc_file_send_blob`（同日新增）把块写进暂存目录，最后一块校验总长后
 * 转给既有 `file_send`——信任门 / 对方确认条 / 传输协议 / 进度事件全部复用，
 * 这里只负责「把字节运过去」。
 *
 * 元数据走自定义 header（Tauri v2 `InvokeOptions.headers`）：header 只认
 * ASCII，文件名必须 `encodeURIComponent`；body 是二进制块。
 */
import { invoke } from "@tauri-apps/api/core";

/** 每块 4MB：对 IPC 与 WebView 内存都是零压力，WiFi RTT 下的吞吐也够。 */
export const SEND_CHUNK_BYTES = 4 * 1024 * 1024;

/** 一条文件的上载结果（成功/失败都给名字——批量发送时要知道谁没走成）。 */
export interface SendOutcome {
  name: string;
  ok: boolean;
  /** 失败原因（人话）；成功时为空串。 */
  err: string;
  canceled?: boolean;
}

/** 上载进度回调：`done` = 已运到后端的字节（不是已传到对端——那要走任务列表）。 */
export type SendProgress = (file: string, done: number, total: number, index?: number) => void;

/** 可注入的最小文件面（测试不碰真 File）。 */
export interface SendFileLike {
  name: string;
  size: number;
  slice(start: number, end: number): Blob;
}

async function chunkToBytes(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer();
}

/**
 * 发送一批文件（串行：并发大块会互相挤内存，总时长也不占便宜）。
 * 单个文件失败不中断整批——返回逐个结果，调用方展示谁没走成。
 */
export async function sendFilesToPeer(
  peer: string,
  files: SendFileLike[],
  onProgress?: SendProgress,
  signal?: AbortSignal,
): Promise<SendOutcome[]> {
  const out: SendOutcome[] = [];
  for (const [index, file] of files.entries()) {
    if (signal?.aborted) {
      out.push({ name: file.name, ok: false, canceled: true, err: "已取消准备" });
      continue;
    }
    try {
      await sendOne(peer, file, (name, done, total) => onProgress?.(name, done, total, index), signal);
      out.push({ name: file.name, ok: true, err: "" });
    } catch (e) {
      out.push({ name: file.name, ok: false, err: String(e), ...(signal?.aborted ? { canceled: true } : {}) });
    }
  }
  return out;
}

async function sendOne(
  peer: string,
  file: SendFileLike,
  onProgress?: SendProgress,
  signal?: AbortSignal,
): Promise<void> {
  // upload id 贯穿本文件所有块（后端按它落同一个暂存文件）；UUID 去掉横线
  // 也行，但保留横线在 allowed 字符集里，直接用。
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `u-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const headers = {
    "x-pp-peer": peer,
    "x-pp-id": id,
    "x-pp-name": encodeURIComponent(file.name),
    "x-pp-total": String(file.size),
  };
  // do-while 形状：0 字节的空文件也要发一块（last=true，后端补齐校验放行空文件）
  let offset = 0;
  let started = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const end = Math.min(offset + SEND_CHUNK_BYTES, file.size);
      const bytes = await chunkToBytes(file.slice(offset, end));
      signal?.throwIfAborted();
      const last = end >= file.size;
      started = true;
      await invoke("rc_file_send_blob", bytes, {
        headers: { ...headers, "x-pp-offset": String(offset), "x-pp-last": last ? "1" : "0" },
      });
      onProgress?.(file.name, end, file.size);
      // A successful final IPC has already queued a transfer; cancellation must not delete its source.
      if (last) return;
      offset = end;
    }
  } catch (error) {
    // Wait for the outstanding write before cleaning exactly this unsubmitted spool file.
    if (started) {
      try {
        await invoke("rc_file_send_blob_abort", { uploadId: id, name: file.name });
      } catch (cleanupError) {
        throw new Error(`${signal?.aborted ? "已停止准备" : String(error)}；暂存清理失败：${String(cleanupError)}`);
      }
    }
    throw error;
  }
}
