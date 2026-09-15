/**
 * useRc — 远程电脑状态轮询 + 事件。
 *
 * 轮询用 `useWindowVisible` 门住（规则 #8，同 useKbSync）。
 * 有会话 / 有敲门时 2s；空闲 5s。窗口 hide 时不空转。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import {
  rcApproveInbound,
  rcDenyInbound,
  rcEndSession,
  rcForget,
  rcIdentity,
  rcInviteCreate,
  rcInvitePreview,
  rcJoinApprove,
  rcJoinDeny,
  rcPair,
  rcRequestSession,
  rcSetCapability,
  rcSetDeviceAllowed,
  rcSetEnabled,
  rcStartChannel,
  rcStatus,
  rcTargets,
  rcSetQuality,
  rcSetCaptureScope,
  type RcCapability,
  type RcCaptureScope,
  type RcIdentity,
  type RcInvite,
  type RcInviteCreated,
  type RcQuality,
  type RcStatus,
  type RcTargetDevice,
} from "@/lib/api/rc";

const IDLE_MS = 5000;
const ACTIVE_MS = 2000;

export function useRc(enabled: boolean) {
  const visible = useWindowVisible();
  const [status, setStatus] = useState<RcStatus | null>(null);
  const [targets, setTargets] = useState<RcTargetDevice[]>([]);
  const [identity, setIdentity] = useState<RcIdentity | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const s = await rcStatus();
      if (alive.current) {
        setStatus(s);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshTargets = useCallback(async () => {
    try {
      const t = await rcTargets();
      if (alive.current) setTargets(t);
    } catch {
      /* 列表失败不打断主状态 */
    }
  }, []);

  const refreshIdentity = useCallback(async () => {
    try {
      const id = await rcIdentity();
      if (alive.current) setIdentity(id);
    } catch {
      /* 指纹读失败在设置面板另有提示 */
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !visible) return;
    void refresh();
    void refreshTargets();
    void refreshIdentity();
    const active =
      !!status?.session ||
      (status?.pending?.length ?? 0) > 0 ||
      (status?.joins?.length ?? 0) > 0;
    const t = window.setInterval(() => void refresh(), active ? ACTIVE_MS : IDLE_MS);
    return () => window.clearInterval(t);
  }, [
    enabled,
    visible,
    refresh,
    refreshTargets,
    refreshIdentity,
    status?.session,
    status?.pending?.length,
    status?.joins?.length,
  ]);

  useEffect(() => {
    if (!enabled) return;
    let off: (() => void) | undefined;
    void listen("rc-session-changed", () => void refresh()).then((f) => {
      off = f;
    });
    return () => off?.();
  }, [enabled, refresh]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await refresh();
        await refreshTargets();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh, refreshTargets],
  );

  return {
    status,
    targets,
    identity,
    busy,
    error,
    refresh,
    refreshTargets,
    refreshIdentity,
    clearError: () => setError(null),
    setEnabled: (v: boolean) => run(() => rcSetEnabled(v)),
    startChannel: () => run(() => rcStartChannel()),
    setCapability: (c: RcCapability) => run(() => rcSetCapability(c)),
    setQuality: (q: RcQuality) => run(() => rcSetQuality(q)),
    setCaptureScope: (s: RcCaptureScope) => run(() => rcSetCaptureScope(s)),
    setDeviceAllowed: (id: string, ok: boolean) => run(() => rcSetDeviceAllowed(id, ok)),
    createInvite: (name: string) => rcInviteCreate(name),
    previewInvite: (code: string) => rcInvitePreview(code),
    pair: (code: string) => run(() => rcPair(code)),
    forget: (id: string) => run(() => rcForget(id)),
    approveJoin: (id: string, name: string) => run(() => rcJoinApprove(id, name)),
    denyJoin: (id: string) => run(() => rcJoinDeny(id)),
    request: (id: string, cap: RcCapability) => run(() => rcRequestSession(id, cap)),
    cancel: () => run(() => rcEndSession()),
    approve: (id: string) => run(() => rcApproveInbound(id)),
    deny: (id: string) => run(() => rcDenyInbound(id)),
    end: () => run(() => rcEndSession()),
  };
}

export type UseRc = ReturnType<typeof useRc>;
export type { RcInvite, RcInviteCreated, RcIdentity };
