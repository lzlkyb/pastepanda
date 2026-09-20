/**
 * 远程电脑 · 文件传输命令层（G6，B4）—— 对应 `src-tauri/src/commands/rc_file.rs`。
 *
 * 与 `lib/api/rc.ts` **分开**：那个文件 650+ 行、已越过 `.ts ≤ 400` 红线，
 * 再往里塞只会让「找一条 rc 命令」变成翻巨人肩膀。与 `rcPair.ts` 的分法一致
 * ——后端同样把命令层拆成 `commands/rc_file.rs`，这里对齐。
 *
 * 字段名与 Rust 一致（snake_case）。失败由调用方处理，这里不吞。
 * 状态**不在这里轮询**：后端在状态变化时主动 emit `rc-file-state`（载荷就是
 * `RcFileSnapshot`），首次挂载取一次 `rcFileSnapshot()` 即可，见 `useRcFile`。
 */
import { invoke } from "@tauri-apps/api/core";

/** 请求方向：对方要发给我（push）／对方要我把文件发给他（pull）。 */
export type RcFileAskKind = "push" | "pull";

/** 任务方向（本机视角）。 */
export type RcFileTaskDir = "send" | "recv";

export type RcFileTaskState =
  | "awaiting"
  | "transferring"
  | "done"
  | "denied"
  | "failed"
  | "canceled";

/**
 * 一条待用户响应的请求（确认条的数据源）。
 *
 * ❗ `kind` 决定两个按钮的含义，两句文案**不能混用**：
 * `push` = 我要选「放哪儿」；`pull` = 我要选「发哪个」。
 */
export interface RcFileAsk {
  id: string;
  peer: string;
  peer_name: string;
  kind: RcFileAskKind;
  /** push 时是对方报的文件名；pull 时为空串（用户选完才知道）。 */
  name: string;
  /** push 时是对方报的大小；pull 时为 0。 */
  size: number;
  first_seen_ms: number;
}

/** 一条任务（进度列表的一行）。 */
export interface RcFileTask {
  id: string;
  peer: string;
  peer_name: string;
  dir: RcFileTaskDir;
  /** 收侧是**净化后**的真实落点名（UI 显示它，不是对方报的原名）。 */
  name: string;
  size: number;
  /** 本次传输的起始偏移（续传 > 0）。 */
  offset: number;
  /** 已完成的**绝对**字节数（0..=size）。 */
  done: number;
  state: RcFileTaskState;
  /** 仅失败时有值。 */
  err?: string;
  /**
   * 本机磁盘上的**绝对路径**（完成态「打开所在文件夹」用）。
   *
   * 收侧 = 实际落盘路径（已含重名递增）；发侧 = 源文件路径（去找原件）。
   * 后端**没有值时这个键直接不出现**（`skip_serializing_if`），所以用「有没有」
   * 判断要不要给那个按钮，而不是判空串。
   */
  path?: string;
  started_ms: number;
  updated_ms: number;
}

/** 完整快照。命令 `rc_file_snapshot` 与事件 `rc-file-state` 是**同一个形状**。 */
export interface RcFileSnapshot {
  asks: RcFileAsk[];
  tasks: RcFileTask[];
}

/**
 * 把本机文件发给对端。可多选，**串行**传。
 *
 * 返回成功只代表「已受理」：不合法的文件在这一步被同步拒掉，真正的传输在
 * 后台跑，进度经 `rc-file-state` 事件回传。
 */
export function rcFileSend(peer: string, paths: string[]): Promise<void> {
  return invoke("rc_file_send", { peer, paths });
}

/**
 * 向对端要文件，落到本机 `dir`。
 *
 * ❗ `dir` 必须在调用**之前**选好：对方一接受就开始灌字节，没有「先请求再选目录」的顺序。
 */
export function rcFilePull(peer: string, dir: string): Promise<void> {
  return invoke("rc_file_pull", { peer, dir });
}

/**
 * 回应确认条。
 *
 * - `acceptDir` 有值 = 接受。push 方向是**落盘目录**；pull 方向是**要发送的文件路径**。
 * - `acceptDir` 为 null = 拒绝。
 */
export function rcFileRespond(askId: string, acceptDir: string | null): Promise<void> {
  return invoke("rc_file_respond", { askId, acceptDir });
}

/** 取消一条进行中的任务（收侧保留 `.pppart`，下次可续）。 */
export function rcFileCancel(taskId: string): Promise<void> {
  return invoke("rc_file_cancel", { taskId });
}

/** 清掉已结束的任务（前端「清空」按钮）。 */
export function rcFileClearFinished(): Promise<void> {
  return invoke("rc_file_clear_finished");
}

/** 首次挂载取一次；之后靠 `rc-file-state` 事件。 */
export function rcFileSnapshot(): Promise<RcFileSnapshot> {
  return invoke<RcFileSnapshot>("rc_file_snapshot");
}

/**
 * 默认接收目录（`<下载>/PastePanda 接收/`）。
 *
 * 由 Rust 给而不是前端拼：中文系统的下载目录叫「下载」，还可能被重定向到别的盘。
 */
export function rcFileDefaultDir(): Promise<string> {
  return invoke<string>("rc_file_default_dir");
}
