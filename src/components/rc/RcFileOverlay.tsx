/**
 * RcFileOverlay — 文件请求的**常驻面**（G6）。
 *
 * 为什么它必须独立于 `RcOverlay`：文件通道走独立 ALPN，与画面会话解耦
 * （决策 8「独立文件会话」的另一面），所以**完全没有会话时也可能有文件请求**。
 * 而 `RcOverlay` 的早返回条件全是「有没有会话/敲门」——文件请求进不去，
 * 「对方只是要传个文件」就会在界面上完全不存在。
 *
 * 与 `RcOverlay` 的分工：**有会话时**那条由 `RcControlBanner` 显示（它按 peer
 * 过滤，且在会话语境里有更完整的信息），这里只补「不在会话里」的部分，
 * 避免同一份请求在同一块屏幕上出现两次。
 *
 * 挂载位置与 `RcOverlay` 相同（App 层常驻）。用 `useRc(true)` 是为了拿会话
 * 对端 id：`rcStore` 是**按订阅计数**的单例，多处挂载不会起第二个轮询。
 */
import { useEffect, useRef } from "react";
import { useToast } from "@/components/Toast";
import { useRc } from "@/hooks/useRc";
import { useRcFile } from "@/hooks/useRcFile";
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDisplayName } from "@/lib/rcDevice";
import { summonMainWindow } from "@/lib/rcWindow";
import { RcFileAskLine } from "./RcFileAsk";
import styles from "./RemoteComputer.module.css";

export function RcFileOverlay() {
  const { toast } = useToast();
  const rc = useRc(true);
  const file = useRcFile(null);

  const session = rc.status?.session ?? null;
  const inboundPeer = session?.phase === "inbound_active" ? session.peer : null;
  // 被控横幅已经显示这一条了 → 这里不重复
  const asks = inboundPeer ? file.asks.filter((a) => a.peer !== inboundPeer) : file.asks;

  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const a of asks) {
      if (seen.current.has(a.id)) continue;
      seen.current.add(a.id);
      // 文件请求自身只带自报名快照；本地起过备注的设备按 targets 的统一显示名显示。
      const target = rc.targets.find((t) => t.node_id === a.peer);
      const who = rcDisplayName(target ?? {}, a.peer_name || fingerprintOf(a.peer));
      toast(a.kind === "push" ? `「${who}」请求给你发送文件` : `「${who}」请求你发送文件`, "info");
      void summonMainWindow();
    }
    const alive = new Set(asks.map((a) => a.id));
    for (const id of Array.from(seen.current)) if (!alive.has(id)) seen.current.delete(id);
  }, [asks, toast, rc.targets]);

  if (asks.length === 0) return null;

  return (
    <>
      {asks.map((a) => (
        <div key={a.id} className={styles.ctrlBanner} role="status">
          <RcFileAskLine ask={a} busy={rc.busy} onRespond={file.respond} />
        </div>
      ))}
    </>
  );
}
