/**
 * RcFileTaskList — 文件任务进度列表（手机端，桌面 RcFilePanel 的瘦版）。
 *
 * 判据与文案全部来自 `lib/rcFile`（isTerminal/taskLine/closingText/classifyErr
 * ——同一处收口，手机和桌面必须说同一句话）；本组件只做行的排布。
 * 独立成文件是因为 RcFilesView 连落点卡 + ask 卡 + 取回入口已经贴着 300 行红线。
 *
 * 进度条用原生 `<progress>`：宽度随值走，不用内联 style（U8），
 * 且读屏软件免费拿到语义。
 */
import { X } from "lucide-react";
import { classifyErr, closingText, isTerminal, taskLine } from "@/lib/rcFile";
import type { RcFileTask } from "@/lib/api/rcFile";
import { RcReceivedFileActions } from "./RcReceivedFileActions";
import { MobileNotice } from "../ui/MobileNotice";
import styles from "./RcDevices.module.css";

export function RcFileTaskList({
  tasks,
  rateOf,
  onCancel,
}: {
  tasks: RcFileTask[];
  rateOf: (t: RcFileTask) => number;
  onCancel: (taskId: string) => void;
}) {
  return (
    <ul className={styles.fileTasks} aria-label="传输任务">
      {tasks.map((t) => {
        const terminal = isTerminal(t.state);
        const tip = t.state === "failed" ? classifyErr(t.err).tip : t.state === "denied" ? "请在对方的 PastePanda 确认文件请求，再重新发送或取回。" : "";
        return (
          <li key={t.id} className={styles.fileTask}>
            <div className={styles.fileTaskHead}>
              <span className={`${styles.fileDir} ${t.dir === "recv" ? styles.fileDirIn : ""}`}>
                {t.dir === "recv" ? "↓ 收" : "↑ 发"}
              </span>
              <span className={styles.fileTaskName}>{t.name}</span>
              {!terminal && (
                <button
                  type="button"
                  className={styles.fileTaskCancel}
                  aria-label={`取消 ${t.name}`}
                  onClick={() => onCancel(t.id)}
                >
                  <X size={14} aria-hidden="true" />
                  <span>取消</span>
                </button>
              )}
            </div>
            {!terminal && (
              <progress
                className={styles.fileTaskBar}
                value={t.done}
                max={t.size > 0 ? t.size : 1}
                aria-label={`${t.name} 进度`}
              />
            )}
            <div className={styles.fileTaskLine}>{taskLine(t, rateOf(t))}</div>
            {tip && <MobileNotice compact tone={t.state === "denied" ? "warning" : "error"}>{tip}</MobileNotice>}
            {closingText(t) && <div className={styles.fileTaskSub}>{closingText(t)}</div>}
            <div className={styles.fileTaskPeer}>{t.peer_name || t.peer}</div>
            {t.state === "done" && t.dir === "recv" && t.path && <RcReceivedFileActions taskId={t.id} />}
          </li>
        );
      })}
    </ul>
  );
}
