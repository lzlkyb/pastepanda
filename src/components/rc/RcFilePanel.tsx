/**
 * RcFilePanel — 文件传输的操作 + 进度列表（G6，B4）。
 *
 * 三处复用同一份组件（状态全在 `rcFileStore`，这里只是一张视图）：
 *   · 工作台「文件传输」页（独立入口，不用开远程会话——决策 8）；
 *   · 会话里的文件名/进度（`RcSessionBar` 只取 `summary` 那一句）；
 *   · 设备卡片「传文件」→ 切到文件页并预选这台设备。
 *
 * # 「打开所在文件夹」
 *
 * 判据在 `lib/rcFile::canOpenPath`（终态 + 后端给了绝对路径）。后端 B6 起把
 * 落盘/源文件路径带进快照，所以这里能给了。打开动作**直接复用既有命令**
 * `open_file_location`——它自带存在性检查与网络共享路径拦截，别再写一个。
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FolderDown, FolderOpen, FolderUp, Loader2, RotateCcw, X } from "lucide-react";
import { rcFileDefaultDir, rcFileSend } from "@/lib/api/rcFile";
import { canOpenPath, isTerminal, classifyErr, taskLine, waitingHint } from "@/lib/rcFile";
import { useRcFile } from "@/hooks/useRcFile";
import { useToast } from "@/components/Toast";
import type { RcFileTask } from "@/lib/api/rcFile";
import styles from "./RemoteComputer.module.css";

/** 打开系统选择框挑要发送的文件（多选）。取消 → 空数组。 */
async function pickFiles(): Promise<string[]> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const sel = await open({ multiple: true, directory: false, title: "选择要发送的文件" });
  if (!sel) return [];
  return (Array.isArray(sel) ? sel : [sel]).filter((s): s is string => typeof s === "string");
}

/** 挑本机落盘目录。取消 → null。 */
async function pickDir(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  let defaultPath: string | undefined;
  try {
    defaultPath = await rcFileDefaultDir();
  } catch {
    /* 拿不到就让用户自己找 */
  }
  const dir = await open({ directory: true, multiple: false, title: "选择接收目录", defaultPath });
  return typeof dir === "string" ? dir : null;
}

export function RcFilePanel({
  peer,
  peerName,
  /** 列表为空时是否显示引导（独立页面用，嵌在会话底栏里不用）。 */
  showEmpty = false,
}: {
  peer: string;
  peerName: string;
  showEmpty?: boolean;
}) {
  const file = useRcFile(peer);
  const { toast } = useToast();
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState("");

  // 换设备时清掉上一台留下的提示（不然会把 A 的失败挂在 B 名下）
  useEffect(() => setNotice(""), [peer]);

  /**
   * 在资源管理器中定位这个文件。
   *
   * 复用既有命令 `open_file_location`（自带存在性检查 + 网络共享路径拦截），
   * 失败必须说出来：静默失败会让人以为点了没反应，而原因可能是文件已被移走。
   */
  const openPath = async (path: string) => {
    try {
      await invoke("open_file_location", { path });
    } catch (e) {
      toast(typeof e === "string" && e ? e : "无法打开所在文件夹", "error");
    }
  };

  // U4：发送方向的就地重试——同一个文件再 push 一次；对端还留着 .pppart
  // 断点的话，收侧按偏移续传，不用从头灌。
  const retrySend = async (t: RcFileTask) => {
    if (!t.path) return;
    try {
      await rcFileSend(t.peer, [t.path]);
      toast(`已重新发起「${t.name}」的传输`, "success");
    } catch (e) {
      toast(typeof e === "string" && e ? e : "重试失败", "error");
    }
  };

  const send = async () => {
    if (picking) return;
    setPicking(true);
    setNotice("");
    try {
      const paths = await pickFiles();
      if (paths.length === 0) return;
      const ok = await file.send(paths);
      if (!ok) setNotice("发起失败，对方可能离线或尚未配对。");
    } finally {
      setPicking(false);
    }
  };

  const pull = async () => {
    if (picking) return;
    setPicking(true);
    setNotice("");
    try {
      // ❗ 目录必须**先**选好：对方一接受就开始灌字节，没有「先请求再选目录」
      const dir = await pickDir();
      if (!dir) return;
      const ok = await file.pull(dir);
      if (!ok) setNotice("发起失败，对方可能离线或尚未配对。");
    } finally {
      setPicking(false);
    }
  };

  const hasFinished = file.tasks.some((t) => isTerminal(t.state));
  const busy = file.busy || picking;

  return (
    <div className={styles.filePanel}>
      <div className={styles.filePanelHead}>
        <span className={styles.filePanelWho}>
          文件 · <b>{peerName}</b>
        </span>
        <span className={styles.sp} />
        <button
          type="button"
          className={styles.miniBtn}
          disabled={busy}
          title="把本机文件发给对方（对方会收到确认条，不点接受不会落盘）"
          onClick={() => void send()}
        >
          <FolderUp size={13} aria-hidden="true" /> 传文件
        </button>
        <button
          type="button"
          className={styles.miniBtn}
          disabled={busy}
          title="向对方要文件：先选好本机保存目录，对方选完文件后开始传"
          onClick={() => void pull()}
        >
          <FolderDown size={13} aria-hidden="true" /> 向对方要文件
        </button>
        {hasFinished && (
          <button
            type="button"
            className={styles.miniBtn}
            disabled={file.busy}
            title="清掉已结束的记录（运行中的不受影响）"
            onClick={() => void file.clearFinished()}
          >
            清空已结束
          </button>
        )}
      </div>

      {notice && <div className={`${styles.fb} ${styles.fbBad}`}>{notice}</div>}
      {file.error && <div className={`${styles.fb} ${styles.fbBad}`}>操作失败：{file.error}</div>}

      {file.tasks.length === 0 ? (
        showEmpty && (
          <div className={styles.fileEmpty}>
            还没有传输记录。文件通道独立于画面会话：不建立远程会话也能传，对方屏幕上不会出现你的画面。
          </div>
        )
      ) : (
        <ul className={styles.fileList}>
          {file.tasks.map((t) => (
            <FileRow
              key={t.id}
              t={t}
              rate={file.rateOf(t)}
              onCancel={file.cancel}
              onOpenPath={openPath}
              onRetry={retrySend}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function FileRow({
  t,
  rate,
  onCancel,
  onOpenPath,
  onRetry,
}: {
  t: RcFileTask;
  rate: number;
  onCancel: (taskId: string) => Promise<void>;
  onOpenPath: (path: string) => Promise<void>;
  onRetry: (t: RcFileTask) => Promise<void>;
}) {
  const pct = t.size > 0 ? Math.min(100, Math.floor((t.done / t.size) * 100)) : 0;
  const running = t.state === "awaiting" || t.state === "transferring";
  const hint = waitingHint(t, Date.now());
  // 失败时补一句可操作提示（分档在 lib/rcFile，含「版本不支持 → 请对方升级」那一档）
  const failTip = t.state === "failed" ? classifyErr(t.err).tip : "";
  // 终态且后端给了绝对路径才给这个按钮（判据在 lib/rcFile，含单测）
  const localPath = canOpenPath(t) ? t.path : undefined;

  return (
    <li className={`${styles.fileRow} ${isTerminal(t.state) ? styles.fileRowOver : ""}`}>
      <div className={styles.fileRowTop}>
        <span className={styles.fileDirBadge} title={t.dir === "send" ? "本机在发" : "本机在收"}>
          {t.dir === "send" ? "发" : "收"}
        </span>
        <span className={styles.fileName} title={t.name}>
          {t.name}
        </span>
        {t.offset > 0 && (running || t.state === "failed" || t.state === "canceled") && (
          <span
            className={styles.fileResume}
            title="从上次断点继续，不是从头重传"
          >
            续传
          </span>
        )}
        <span className={styles.sp} />
        {t.state === "awaiting" && (
          <Loader2 size={11} className={styles.spin} aria-hidden="true" />
        )}
        <span className={styles.fileState}>{taskLine(t, rate)}</span>
        {localPath && (
          <button
            type="button"
            className={styles.fileOpen}
            title={`在资源管理器中显示：${localPath}`}
            aria-label="打开所在文件夹"
            onClick={() => void onOpenPath(localPath)}
          >
            <FolderOpen size={13} />
          </button>
        )}
        {running && (
          <button
            type="button"
            className={styles.fileCancel}
            title="取消这次传输（已收到的部分保留，下次可续传）"
            aria-label="取消传输"
            onClick={() => void onCancel(t.id)}
          >
            <X size={13} />
          </button>
        )}
        {/* U4：发送方向失败给就地重试——源路径在手，一键重发（对端有断点则自动续传）。
            收方向不就地重试：文件名/选择权在对端，再拉一次要走「对方选文件」流程。 */}
        {t.state === "failed" && t.dir === "send" && t.path && onRetry && (
          <button
            type="button"
            className={styles.fileOpen}
            title="重试发送（对端已有断点时自动续传）"
            aria-label="重试发送"
            onClick={() => void onRetry(t)}
          >
            <RotateCcw size={13} />
          </button>
        )}
      </div>
      {running && (
        <div
          className={styles.fileBar}
          role="progressbar"
          aria-label={`${t.name} 传输进度`}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span className={styles.fileBarFill} style={{ width: `${pct}%` }} />
        </div>
      )}
      {hint && <div className={styles.fileHint}>{hint}</div>}
      {failTip && <div className={styles.fileHint}>{failTip}</div>}
    </li>
  );
}
