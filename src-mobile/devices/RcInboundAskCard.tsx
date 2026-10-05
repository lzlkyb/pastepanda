import { useRef, useState } from "react";
import type { RcInboundKnock } from "@/lib/api/rc";
import { MobileNotice } from "../ui/MobileNotice";
import ui from "../ui/MobileUi.module.css";
import styles from "./RcDevices.module.css";

/**
 * 处理旧版本遗留申请；手机目前只支持控制电脑和传文件。
 */
export function RcInboundAskCard({
  knock,
  busy,
  onDeny,
}: {
  knock: RcInboundKnock;
  busy: boolean;
  onDeny: (nodeId: string) => Promise<boolean>;
}) {
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const name = knock.display_name || knock.peer_name || "对方设备";
  const deny = async () => {
    if (inFlight.current || busy) return;
    inFlight.current = true;
    setWorking(true);
    setFailed(false);
    try {
      if (!await onDeny(knock.peer)) setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  };

  return (
    <div className={styles.pendingCard} role="alertdialog" aria-label="远程控制请求">
      <div className={styles.pendingTitle}>{name} 请求连接这台手机</div>
      <p>手机暂不支持被远程观看或控制。你可以用手机连接电脑，或传输文件。</p>
      {failed && <MobileNotice error>未能拒绝请求，请重试。</MobileNotice>}
      <div className={styles.askActions}>
        <button
          type="button"
          className={ui.secondary}
          disabled={working || busy}
          onClick={() => void deny()}
        >
          {working ? "正在拒绝…" : "拒绝"}
        </button>
      </div>
    </div>
  );
}
