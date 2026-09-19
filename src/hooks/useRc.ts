/**
 * useRc — 远程电脑状态的薄壳。
 *
 * 真正的状态与轮询全在 rcStore（单例）。本 hook 只做三件事：
 *  1. 订阅 store 字段并按原签名返回（调用点零改动）；
 *  2. 挂载时 acquire（开始 / 续上轮询）、卸载时 release；
 *  3. 把窗口可见性喂给 store（规则 #8：不可见不空转）。
 *
 * 注意：原 useRc 里的 `alive` 守卫已不再需要——状态活在 app 级单例里，
 * 组件卸载不会让 store 消失，setState 永远安全，也就没有「卸载后 setState」的告警。
 */
import { useEffect } from "react";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import { useRcStore } from "@/stores/rcStore";
import type { RcInvite, RcInviteCreated, RcIdentity } from "@/lib/api/rc";

export function useRc(enabled: boolean) {
  const visible = useWindowVisible();
  const status = useRcStore((s) => s.status);
  const targets = useRcStore((s) => s.targets);
  const identity = useRcStore((s) => s.identity);
  const busy = useRcStore((s) => s.busy);
  const error = useRcStore((s) => s.error);
  const statusError = useRcStore((s) => s.statusError);
  const scopeNotice = useRcStore((s) => s.scopeNotice);
  const streamNotice = useRcStore((s) => s.streamNotice);
  const pathNotice = useRcStore((s) => s.pathNotice);

  // 挂载=订阅，卸载=退订；enabled=false 时不参与轮询（与原语义一致）
  useEffect(() => {
    if (!enabled) return;
    useRcStore.getState().acquire();
    return () => useRcStore.getState().release();
  }, [enabled]);

  // 窗口可见性门控交给 store：可见按节奏、隐藏降频但不断
  useEffect(() => {
    useRcStore.getState().setVisible(visible);
  }, [visible]);

  // actions 在 store 里是稳定引用，渲染期取一次即可
  const a = useRcStore.getState();
  return {
    status,
    targets,
    identity,
    busy,
    error: error ?? statusError,
    /** 是否为操作失败（可重试原操作）；false 表示状态刷新失败，重试只应 refresh */
    isOpError: !!error,
    /** 被控端：对端刚改了本机画面范围（B3），非 null 时被控横幅要显示。 */
    scopeNotice,
    clearScopeNotice: a.clearScopeNotice,
    /** 被控端：对端刚改了本机画质/编码档（Q10），非 null 时被控横幅要显示。 */
    streamNotice,
    clearStreamNotice: a.clearStreamNotice,
    /** 会话中路径自动切换（relay ↔ 直连）；非 null 时提示一次并清掉。 */
    pathNotice,
    clearPathNotice: a.clearPathNotice,
    refresh: a.refresh,
    refreshTargets: a.refreshTargets,
    probeTargets: a.probeTargets,
    refreshIdentity: a.refreshIdentity,
    clearError: a.clearError,
    setEnabled: a.setEnabled,
    startChannel: a.startChannel,
    setCapability: a.setCapability,
    setQuality: a.setQuality,
    setCaptureScope: a.setCaptureScope,
    setDeviceAllowed: a.setDeviceAllowed,
    setDeviceTrust: a.setDeviceTrust,
    createInvite: a.createInvite,
    previewInvite: a.previewInvite,
    pair: a.pair,
    forget: a.forget,
    approveJoin: a.approveJoin,
    denyJoin: a.denyJoin,
    request: a.request,
    requestUno: a.requestUno,
    requestPass: a.requestPass,
    unoGenerate: a.unoGenerate,
    unoRevoke: a.unoRevoke,
    unoPassEnable: a.unoPassEnable,
    unoPassDisable: a.unoPassDisable,
    unoPassSetWan: a.unoPassSetWan,
    cancel: a.cancel,
    end: a.end,
    approve: a.approve,
    deny: a.deny,
    clearHistory: a.clearHistory,
  };
}

export type UseRc = ReturnType<typeof useRc>;
export type { RcInvite, RcInviteCreated, RcIdentity };
