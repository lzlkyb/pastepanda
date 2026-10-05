import { useCallback, useEffect, useRef, useState } from "react";
import { rcExchangeCheck, rcPinPairBegin, rcShortPairCancel } from "@/lib/api/rc";

// 后端只有一轮会合。旧弹窗的取消必须完成，新弹窗才能注册下一轮。
let pendingCancel: Promise<unknown> = Promise.resolve();

/** 同一时刻只允许一个会合；切换入口、关闭弹窗和换码都使旧结果失效。 */
export function useRcShortPair(onPaired: (peerId: string, name: string) => void) {
  const [phase, setPhase] = useState<"idle" | "joining" | "waiting" | "error">("idle");
  const [message, setMessage] = useState("");
  const [peer, setPeer] = useState<{ id: string; name: string; expires: number } | null>(null);
  const epoch = useRef(0);
  const active = useRef(false);
  const pairedRef = useRef(onPaired);
  pairedRef.current = onPaired;

  const cancel = useCallback(async () => {
    epoch.current++;
    if (active.current) {
      active.current = false;
      pendingCancel = pendingCancel.catch(() => {}).then(() => rcShortPairCancel());
    }
    setPhase("idle");
    setPeer(null);
    setMessage("已取消配对，可以重新开始。");
    try { await pendingCancel; }
    catch (error) { setPhase("error"); setMessage(`取消失败，请重试：${String(error)}`); }
  }, []);

  const begin = useCallback(async (code: string, listen: boolean) => {
    if (active.current) void cancel();
    const attempt = ++epoch.current;
    await pendingCancel.catch(() => {});
    if (attempt !== epoch.current) return;
    active.current = true;
    setPhase("joining");
    setMessage(listen ? "正在等待对方扫码或输入这枚码…" : "正在查找对方，请让对方保持出示配对码。");
    try {
      const result = await rcPinPairBegin(code, listen);
      if (attempt !== epoch.current) return;
      setPeer({ id: result.node_id, name: result.name, expires: result.expires_at });
      setPhase("waiting");
      setMessage(`已找到「${result.name || "新设备"}」，正在完成配对…`);
    } catch (error) {
      if (attempt !== epoch.current) return;
      active.current = false;
      setPhase("error");
      setMessage(`未能配对：${String(error)}`);
    }
  }, [cancel]);

  useEffect(() => {
    if (!peer || phase !== "waiting") return;
    let stopped = false;
    const attempt = epoch.current;
    let timer: number | undefined;
    const check = async () => {
      if (stopped || attempt !== epoch.current) return;
      if (peer.expires && peer.expires <= Date.now()) {
        void cancel();
        setPhase("error"); setMessage("本次配对已超时，请重新等待或输入新的配对码。");
        return;
      }
      try {
        const result = await rcExchangeCheck(peer.id);
        if (stopped || attempt !== epoch.current) return;
        if (result === "paired") {
          active.current = false;
          setPhase("idle");
          pairedRef.current(peer.id, peer.name);
          return;
        }
      } catch (error) {
        if (stopped || attempt !== epoch.current) return;
        setPhase("error"); setMessage(`配对状态读取失败：${String(error)}`);
        return;
      }
      timer = window.setTimeout(() => void check(), 5000);
    };
    // 只在握手期间继续读状态；切到手机拿码时也不能丢掉完成反馈。
    void check();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [peer, phase, cancel]);

  useEffect(() => () => {
    epoch.current++;
    if (active.current) {
      active.current = false;
      pendingCancel = pendingCancel.catch(() => {}).then(() => rcShortPairCancel());
      void pendingCancel.catch(() => {});
    }
  }, []);
  return { phase, message, begin, cancel, busy: phase === "joining" || phase === "waiting" };
}
