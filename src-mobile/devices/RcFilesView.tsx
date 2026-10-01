/**
 * RcFilesView — 文件页签真身（P1.5/P1.6）：不接管屏幕也能和电脑互传文件。
 *
 * 数据全复用桌面层：`useRcFile`（rcFileStore 单例、事件驱动）+ lib/rcFile 的
 * 判据文案（askPrompt/askCountdown——同一处收口）。
 *
 * 手机端与桌面两处不同（都写在对应位置，不是没做）：
 * - **发送走 `<input type="file">` 分块上载**（rcSendFiles → `rc_file_send_blob`）：
 *   Android 系统选择器给的是 content:// 虚拟路径读不了，但 WebView 能拿到文件
 *   内容；4MB 一块运到后端暂存，最后一块落定后转给既有 file_send——信任门 /
 *   对方确认条 / 进度事件与桌面同一条路。
 * - **接收落点只展示不编辑**：来自后端 `rc_file_default_dir`（Android = 应用
 *   外部私有目录），手机上没有目录选择器，改落点是桌面设置页的事。
 *
 * 对方推文件过来时会先出 ask 卡（接受 = 存进接收目录），60 秒不回应自动失效
 * ——与桌面同一套后端纪律。
 */
import { useEffect, useRef, useState } from "react";
import { FolderDown, FolderUp } from "lucide-react";
import { rcFileDefaultDir } from "@/lib/api/rcFile";
import { askCountdown, askPrompt } from "@/lib/rcFile";
import { formatBytes } from "@/lib/utils";
import { useRcFile } from "@/hooks/useRcFile";
import { useRcFileStore } from "@/stores/rcFileStore";
import type { UseRc } from "@/hooks/useRc";
import { RcFileTaskList } from "./RcFileTaskList";
import { sendFilesToPeer } from "./rcSendFiles";
import styles from "./RcDevices.module.css";
import { rcErrorText } from "./rcErrorText";

export function RcFilesView({ rc, initialPeer }: { rc: UseRc; /** 设备面板「传文件」带进来的预选（页签切换会重挂，initial 即可）。 */ initialPeer?: string | null }) {
  const file = useRcFile();
  const [receiveDir, setReceiveDir] = useState<string | null>(null);
  const [dirErr, setDirErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(initialPeer ?? null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const targets = rc.targets ?? [];

  useEffect(() => {
    let alive = true;
    rcFileDefaultDir()
      .then((d) => {
        if (alive) setReceiveDir(d);
      })
      .catch((e) => {
        if (alive) setDirErr(rcErrorText(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  // ask 卡的 60 秒倒计时。只在有 ask 在等的时候跳（平时零计时器）。
  useEffect(() => {
    if (file.asks.length === 0) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [file.asks.length]);

  // 多台电脑才需要挑；单台自动选定，0 台由空态引导去配对
  const peer = picked ?? (targets.length === 1 ? targets[0].node_id : null);
  const peerName = targets.find((t) => t.node_id === peer)?.display_name ?? "";

  const pull = async () => {
    if (!peer || !receiveDir) return;
    setActionErr(null);
    // 🔴 不走 useRcFile().pull：那是「把当前 peer 绑进去」的会话内便捷壳
    // （传 null peer 时只会发出空 peer）。本页看全部任务、pull 按选中设备，
    // 得用 store 的原始动作显式传 peer。
    const ok = await useRcFileStore.getState().pull(peer, receiveDir);
    if (!ok) {
      // ❗ 读 store——闭包里的 file.error 是点击那一帧的快照
      setActionErr(useRcFileStore.getState().error ?? "发起取回失败");
    }
  };

  const accept = async (askId: string) => {
    if (!receiveDir) return;
    await file.respond(askId, receiveDir);
  };

  // ── 发送（P1.6）：<input type="file"> → 分块上载 → 后端转 file_send ──
  // 反馈与触发同域（规则 15.1）：进行中一句话（sendNote）、失败明说谁没走成。
  const pickRef = useRef<HTMLInputElement>(null);
  const [sendNote, setSendNote] = useState<string | null>(null);
  const [sendErr, setSendErr] = useState<string | null>(null);

  const startSend = async (list: FileList | null) => {
    if (!peer || !list || list.length === 0) return;
    const files = Array.from(list);
    setSendErr(null);
    setSendNote(`正在上传 0/${files.length} 个文件…`);
    const results = await sendFilesToPeer(peer, files, (name, done, total) => {
      setSendNote(`正在上传 ${name} ${total > 0 ? Math.floor((done / total) * 100) : 100}%`);
    });
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      setSendNote(null);
      setSendErr(`发送失败：${failed.map((f) => `${f.name}（${f.err}）`).join("、")}`);
    } else {
      // 上载完成 ≠ 传输完成：电脑端还要确认（任务列表里会出现「等待对方确认」）
      setSendNote(`上传完成 ${results.length} 个文件，等 ${peerName || "对方"} 在电脑上确认后开始传。`);
    }
    // 允许下次重选同一批文件（不清理的话 onChange 不触发）
    if (pickRef.current) pickRef.current.value = "";
  };

  return (
    <div className={styles.filesView}>
      {file.error && (
        <div className={styles.errBar} role="alert">
          <span className={styles.errBarText}>{rcErrorText(file.error)}</span>
        </div>
      )}

      {/* 对方推来的确认卡（push 方向的收侧确认，60 秒倒计时）。
          🔴 pull 请求（电脑想从手机「取」文件）接受不了：那一步是「选一个真实
          文件路径发回去」（桌面弹目录框），而手机选择器给不出真实路径——
          放行只会把接收目录当路径传给后端然后报错。诚实禁用 + 指路。 */}
      {file.asks.map((ask) => {
        const prompt = askPrompt(ask);
        const cd = askCountdown(ask, now);
        const pullBlocked = ask.kind === "pull";
        return (
          <div key={ask.id} className={styles.fileAsk} role="alert">
            <div className={styles.fileAskTitle}>{prompt.title}</div>
            <div className={styles.fileAskLead}>
              {ask.kind === "push"
                ? `「${ask.name}」（${formatBytes(ask.size)}）→ 存进接收目录`
                : prompt.lead}
            </div>
            {cd.late && <div className={styles.fileTaskSub}>对方可能没看到，请求快超时了</div>}
            <div className={styles.fileAskBtns}>
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={!receiveDir || pullBlocked}
                onClick={() => void accept(ask.id)}
              >
                {prompt.accept}
              </button>
              <button type="button" className={styles.ghostBtn} onClick={() => void file.respond(ask.id, null)}>
                {prompt.deny}
              </button>
            </div>
            {pullBlocked && (
              <div className={styles.fileTaskSub}>
                手机给不出文件的真实路径，接不了这个请求；要传内容给电脑，用下面的「发文件到电脑」。
              </div>
            )}
          </div>
        );
      })}

      {/* 接收落点：只展示。建不建得出、可不可写由 file_pull 补建并诚实报错。 */}
      <div className={styles.dirCard}>
        <div className={styles.dirLabel}>文件接收目录</div>
        {receiveDir ? (
          <>
            <div className={styles.dirPath}>{receiveDir}</div>
            <div className={styles.dirHint}>
              用手机文件管理器或数据线都能看到。对方推来的文件也存在这里。
            </div>
          </>
        ) : (
          <div className={styles.dirHint}>{dirErr ?? "正在获取…"}</div>
        )}
      </div>

      {targets.length === 0 ? (
        <div className={styles.fileEmpty}>
          还没有配对的电脑。先在「设备」页配对，
          <br />
          然后在这里互传文件。
        </div>
      ) : (
        <>
          {targets.length > 1 && (
            <div className={styles.peerPick} role="radiogroup" aria-label="选择电脑">
              {targets.map((t) => (
                <button
                  key={t.node_id}
                  type="button"
                  role="radio"
                  aria-checked={peer === t.node_id}
                  className={`${styles.peerChip} ${peer === t.node_id ? styles.peerChipOn : ""}`}
                  onClick={() => setPicked(t.node_id)}
                >
                  {t.display_name || t.name}
                </button>
              ))}
            </div>
          )}
          <button type="button" className={styles.primaryBtn} disabled={!peer || !receiveDir} onClick={() => void pull()}>
            <FolderDown size={16} aria-hidden="true" /> 从电脑取文件
          </button>
          <div className={styles.dirHint}>
            {peerName ? `电脑上会弹出确认条，${peerName} 选好要发的文件就开始传。` : "点「取文件」后在电脑上确认要发的内容。"}
          </div>

          {/* 发送：视觉隐藏的 input 承接系统选择器（wry onShowFileChooser），
              按钮才是触摸目标。进行中/完成的话术与触发同列（规则 15.1）。 */}
          <input
            ref={pickRef}
            type="file"
            multiple
            className={styles.filePickInput}
            aria-hidden="true"
            tabIndex={-1}
            onChange={(e) => void startSend(e.target.files)}
          />
          <button type="button" className={styles.primaryBtn} disabled={!peer || !!sendNote} onClick={() => pickRef.current?.click()}>
            <FolderUp size={16} aria-hidden="true" /> 发文件到电脑
          </button>
          {sendNote && <div className={styles.dirHint}>{sendNote}</div>}
        </>
      )}

      {sendErr && (
        <div className={styles.errBar} role="alert">
          <span className={styles.errBarText}>{rcErrorText(sendErr)}</span>
        </div>
      )}

      {actionErr && (
        <div className={styles.errBar} role="alert">
          <span className={styles.errBarText}>{rcErrorText(actionErr)}</span>
        </div>
      )}

      {file.tasks.length > 0 && (
        <>
          <div className={styles.fileTasksHead}>
            <span>传输记录</span>
            <button type="button" className={styles.fileClear} onClick={() => void file.clearFinished()}>
              清空已完成
            </button>
          </div>
          <RcFileTaskList tasks={file.tasks} rateOf={file.rateOf} onCancel={(id) => void file.cancel(id)} />
        </>
      )}
    </div>
  );
}
