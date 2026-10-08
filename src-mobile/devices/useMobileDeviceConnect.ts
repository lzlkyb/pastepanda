import { useRef, useState } from "react";
import type { UseRc } from "@/hooks/useRc";
import type { RcCapability, RcSession, RcTargetDevice } from "@/lib/api/rc";
import { useRcStore } from "@/stores/rcStore";
import { rcErrorText } from "./rcErrorText";

/** 列表与详情共用普通连接入口；凭证接入仍由无人值守流程处理。 */
export function useMobileDeviceConnect(rc: UseRc, session: RcSession | null = rc.status?.session ?? null) {
  const [working, setWorking] = useState<{ peer: string; capability: RcCapability } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [peer, setPeer] = useState<string | null>(null);
  const locked = useRef(false);
  const blocked = !!working || rc.busy || rc.status?.enabled === false || rc.status?.running !== true || !!session && session.phase !== "idle";
  const request = async (target: RcTargetDevice, capability: RcCapability) => {
    // denied 只禁止对方连接本机，不限制用户主动连接它。同步关系不能充当远控配对。
    if (locked.current || blocked || target.source === "sync") return false;
    locked.current = true;
    setWorking({ peer: target.node_id, capability });
    setPeer(target.node_id);
    setError(null);
    try {
      const ok = await rc.request(target.node_id, capability);
      if (!ok) setError(rcErrorText(useRcStore.getState().error ?? "未能发出连接请求，请重试。"));
      else setPeer(null);
      return ok;
    } catch (cause) {
      setError(rcErrorText(cause));
      return false;
    } finally {
      locked.current = false;
      setWorking(null);
    }
  };
  const clearError = () => { setError(null); setPeer(null); rc.clearError(); };
  return { blocked, working, error, peer, request, clearError };
}
