import { isTerminal } from "@/lib/rcFile";
import type { useRcFile } from "@/hooks/useRcFile";
import { RcMobileFileAsks } from "./RcMobileFileAsks";
import { RcFileTaskList } from "./RcFileTaskList";
import ui from "../ui/MobileUi.module.css";
import styles from "./RcDevices.module.css";

export function RcFileRecords({ file, receiveDir, active }: {
  file: ReturnType<typeof useRcFile>; receiveDir: string | null; active: boolean;
}) {
  const running = file.tasks.filter(task => !isTerminal(task.state));
  // Failures stay visible: folding them would hide the reason and recovery controls.
  const attention = file.tasks.filter(task => task.state === "failed" || task.state === "denied");
  const ended = file.tasks.filter(task => task.state === "done" || task.state === "canceled");
  const list = (tasks: typeof file.tasks) => <RcFileTaskList tasks={tasks} rateOf={file.rateOf} onCancel={id => void file.cancel(id)} />;
  return <section className={styles.fileRecords} aria-label="传输记录与请求">
    {!!file.asks.length && <div className={ui.sectionHead}>待接收请求 · {file.asks.length}</div>}
    <RcMobileFileAsks file={file} receiveDir={receiveDir} active={active} />
    {!!running.length && <><div className={ui.sectionHead}>正在传输 · {running.length}</div>{list(running)}</>}
    {!!attention.length && <><div className={ui.sectionHead}>需要处理 · {attention.length}</div>{list(attention)}</>}
    {ended.length > 0 && <details className={styles.endedRecords}>
      <summary>已结束记录 · {ended.length}</summary>
      {list(ended)}
    </details>}
    {file.tasks.length > 0 && <>
      <button className={ui.textButton} disabled={file.busy || !file.tasks.some(task => isTerminal(task.state))} onClick={() => void file.clearFinished()}>清除已结束记录</button>
      <p className={ui.hint}>只清除记录，不删除已接收文件。</p>
    </>}
    {!file.tasks.length && !file.asks.length && <p className={ui.hint}>还没有传输任务。发送或接收文件后，可以在这里查看进度。</p>}
  </section>;
}
