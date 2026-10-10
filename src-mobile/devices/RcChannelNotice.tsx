import { useRef, useState } from "react";
import type { UseRc } from "@/hooks/useRc";
import { MobileNotice } from "../ui/MobileNotice";
import { rcErrorText } from "./rcErrorText";
import ui from "../ui/MobileUi.module.css";

/** Recover in the current task; enabling is always an explicit user action. */
export function RcChannelNotice({ rc }: { rc: UseRc }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  if (rc.status?.running) return null;
  const closed = rc.status?.enabled === false;
  const recover = async () => {
    if (locked.current || rc.busy) return;
    locked.current = true; setWorking(true); setError(null);
    try {
      if (closed) {
        if (!await rc.setEnabled(true)) setError("开启未能完成，请重试。");
      } else await rc.refresh();
    } catch (reason) { setError(rcErrorText(reason)); }
    finally { locked.current = false; setWorking(false); }
  };
  return <MobileNotice tone={error ? "error" : rc.status ? "warning" : "pending"}
    title={error ? "远程通道未能恢复" : closed ? "远程通道已关闭" : rc.status ? "远程通道尚未就绪" : "正在检查远程通道…"}
    detail={error || (closed ? "开启后可连接电脑和互传文件。" : "就绪后即可继续当前操作。")}
    action={rc.status && <button type="button" className={ui.textButton} disabled={working || rc.busy} onClick={() => void recover()}>
      {working ? "正在处理…" : closed ? "开启远程通道" : "重新检查通道"}
    </button>} />;
}
