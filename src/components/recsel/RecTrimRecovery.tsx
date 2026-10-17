import { useRecTrimTask } from "@/hooks/useRecTrimTask";
import { recOpenPreview } from "@/lib/api/rec";
import { useState } from "react";
import styles from "./RecRecentList.module.css";

/** 裁剪后台态：与它所属的那一行同行内呈现（保存中 / 已完成 / 失败），不进全局条。 */
export function RecTrimRecovery({ path }: { path: string }) {
  const task = useRecTrimTask(path);
  const [openError, setOpenError] = useState<string | null>(null);
  if (!task.saving && !task.saved && !task.error && !openError) return null;
  return (
    <div className={styles.hint}>
      {task.saving && (
        <>
          <span role="status">裁剪正在后台保存 · {task.percent}%</span>
          <button type="button" className={styles.link} onClick={() => void task.cancel()}>
            取消裁剪
          </button>
        </>
      )}
      {task.saved && (
        <button
          type="button"
          className={styles.link}
          onClick={() =>
            void recOpenPreview(task.saved!.path).catch((e: unknown) =>
              setOpenError(e instanceof Error ? e.message : String(e)),
            )
          }
        >
          预览裁剪文件
        </button>
      )}
      {(task.error || openError) && (
        <p role="alert" className={styles.err}>
          {task.error || openError}
        </p>
      )}
      {task.queryFailed && (
        <button type="button" className={styles.link} onClick={() => void task.query()}>
          重新查询裁剪
        </button>
      )}
    </div>
  );
}
