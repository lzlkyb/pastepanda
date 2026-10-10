import { useRef, useState } from "react";
import { mobileReceivedFileAction } from "@/lib/api/rcFile";
import { MobileNotice } from "../ui/MobileNotice";
import { MobileToast } from "../ui/MobileToast";
import { rcErrorText } from "./rcErrorText";
import ui from "../ui/MobileUi.module.css";
import styles from "./RcDevices.module.css";

type Action = "open" | "share" | "export";
export function RcReceivedFileActions({ taskId }: { taskId: string }) {
  const [working, setWorking] = useState<Action | null>(null);
  const [result, setResult] = useState<{ title: string; error?: boolean } | null>(null);
  const locked = useRef(false);
  const act = async (action: Action) => {
    if (locked.current) return;
    locked.current = true; setWorking(action); setResult(null);
    try {
      const reply = await mobileReceivedFileAction(taskId, action);
      setResult({ title: reply.status === "cancelled" ? "已取消导出，原文件仍保留" : reply.status === "exported" ? "文件已导出" : action === "share" ? "已打开系统分享面板" : "已交给系统打开" });
    } catch (reason) { setResult({ title: rcErrorText(reason), error: true }); }
    finally { locked.current = false; setWorking(null); }
  };
  return <div className={styles.fileUse}>
    <div className={styles.fileUseActions}>
      {(["open", "share", "export"] as const).map(action => <button key={action} type="button" className={ui.textButton}
        disabled={!!working} onClick={() => void act(action)}>{working === action ? "正在处理…" : { open: "打开", share: "分享", export: "导出" }[action]}</button>)}
    </div>
    {result && (result.error ? <MobileNotice compact error title="文件操作未能完成" detail={result.title} onDismiss={() => setResult(null)} />
      : <MobileToast placement="flow" tone="success" title={result.title} onDismiss={() => setResult(null)} />)}
  </div>;
}
