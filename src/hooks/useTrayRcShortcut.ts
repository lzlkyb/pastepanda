/**
 * useTrayRcShortcut — 托盘弹窗里的「连接 <上次设备>」快捷项（B1）。
 *
 * 为什么放在托盘：远程是「想起来用一下」的动作，而现在是「工具箱 → 工作台 → 设备
 * 列表 → 发起」四步；托盘弹窗是常驻的最浅一层，把最近用过的那台摆进来，路径压到一步
 * （对端 0 步——该设备若已免确认，连过去直接进画面）。
 *
 * 纯前端：只用现有命令（rc_status / rc_targets / rc_open_workbench /
 * rc_request_session），不动 Rust，也就不需要 dev restart。
 *
 * 🔴 三条「不摆死项」的判据（与本轮 A5 同一套：摆一个点了必失败的入口比不摆更糟）：
 *   · 通道没在跑 → 不摆：`rc_request_session` 会回 `[channel_down]`；
 *   · 已有会话或待同意申请 → 不摆：会回 `[busy_local]`（`gate_outbound`）；
 *   · 没有远程配对设备 → 不摆：会回 `[not_paired]`。
 * 读取任一步失败**不再静默消失**（2026-09-23 审计修）：判据不满足是「确实没有项」，
 * 而读状态失败是「出错了」——后者在菜单位置留一条**禁用**说明项，用户能分清
 * 「这台机器没配过」与「刚才没读到」。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { rcRequestSession, rcStatus, rcTargets, rcCancelRequest } from "@/lib/api/rc";
import { lastRcTarget, rcDisplayName } from "@/lib/rcDevice";
import { capabilityLabel, lastRequestCap } from "@/lib/rcRequest";
import { logger } from "@/lib/logger";
import { useRcStore } from "@/stores/rcStore";
import { useToast, UNDO_WINDOW_MS } from "@/components/Toast";

export interface TrayRcShortcut {
  /** 设备显示名（备注优先，与工作台同一口径）。 */
  label: string;
  /** 将以哪一档连接（「只看」/「可控」）——托盘行的 hint，沿用上次用过的档。 */
  capLabel: string;
  /** 打开工作台并发起申请；返回 false = 发起失败（错误已进工作台错误面板）。 */
  connect: () => Promise<boolean>;
  /** true = 状态读取失败的占位项：渲染为禁用，不可点击（见上方审计修）。 */
  disabled?: boolean;
}

export function useTrayRcShortcut(): TrayRcShortcut | null {
  const [target, setTarget] = useState<{ nodeId: string; label: string } | null>(null);
  /** 上一次读取是否失败——失败时给禁用占位而不是整项消失。 */
  const [readFailed, setReadFailed] = useState(false);

  /**
   * 拉一次目标设备。🔴 不能只在挂载时拉一次（2026-09-23 修）：托盘弹窗走
   * `hide()` 不销毁，本 hook 只在应用启动时挂载一次——用户在工作台改了设备备注，
   * 这里仍显示旧名。所以还要监听 `tray-popup-init`（Rust 每次 show 弹窗都会发，
   * 见 tray_manager.rs），弹一次重拉一次。
   */
  const fetchTarget = useCallback(async (cancelled: () => boolean) => {
    try {
      const st = await rcStatus();
      // 三条「不摆死项」判据不再满足时**必须撤下**旧项：弹窗不销毁，
      // 不清的话上一轮的 target 会一直挂着（比如会话已在别处开始）。
      if (!st.running || st.session || (st.pending?.length ?? 0) > 0) {
        if (!cancelled()) {
          setTarget(null);
          setReadFailed(false);
        }
        return;
      }
      const dev = lastRcTarget(await rcTargets());
      if (cancelled()) return;
      if (!dev) {
        setTarget(null);
        setReadFailed(false);
        return;
      }
      setReadFailed(false);
      setTarget({
        nodeId: dev.node_id,
        label: rcDisplayName(dev, "未命名设备"),
      });
    } catch (e) {
      // 审计修：以前只 console.warn，快捷项在用户眼里「静默消失」。
      // 留一条禁用占位（下一次弹窗读成功后自动撤下），warn 照留。
      logger.warn("[TrayRc] 读取远程状态失败，快捷连接项降级为禁用占位", e);
      if (!cancelled()) {
        setTarget(null);
        setReadFailed(true);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchTarget(() => cancelled);
    // 每次 Rust 侧 show 弹窗都会 emit tray-popup-init（TrayPopup.tsx 也在听它）——
    // 借同一条事件把设备名刷成最新的（改备注后弹托盘立刻看到新名字）。
    let unlisten: (() => void) | null = null;
    void listen("tray-popup-init", () => {
      if (!cancelled) void fetchTarget(() => cancelled);
    })
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      // 审计修（对齐 useRcSessionNotices 的写法）：listen 的拒绝必须留痕，
      // 不能变成 unhandled rejection 后静默丢掉整条刷新链路。
      .catch((e) => logger.warn("[TrayRc] tray-popup-init 监听注册失败，设备名不会自动刷新", e));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [fetchTarget]);

  const { toast } = useToast();
  const connect = useCallback(async () => {
    if (!target) return false;
    const cap = lastRequestCap();
    // 先开工作台再发申请：申请是异步的（等对方同意），用户需要在工作台里看到
    // 「等待对方同意」和随后的画面，而不是只看到托盘收起。
    await invoke("rc_open_workbench");
    // B5：走 store 的 run——失败原因落工作台错误面板（不再只靠托盘 toast 兜），
    // 成功后给**与工作台发起同款**的 6 秒撤销窗口。原先直接裸调
    // rcRequestSession，绕过了撤销链路：误触之后没有「撤回」这步可走。
    const ok = await useRcStore
      .getState()
      .run(() => rcRequestSession(target.nodeId, cap));
    if (ok) {
      const name = target.label;
      toast(
        `已向「${name}」发起远程（${capabilityLabel(cap)}）`,
        "info",
        UNDO_WINDOW_MS,
        undefined,
        "撤销",
        undefined,
        undefined,
        () => {
          void (async () => {
            if (useRcStore.getState().status?.session?.phase !== "outbound_pending") {
              toast("对方已同意，申请无法撤回（可在会话里结束）", "info");
              return;
            }
            try {
              await rcCancelRequest();
              toast(`已撤回对「${name}」的申请`, "success");
            } catch {
              toast("撤回失败", "error");
            }
          })();
        },
      );
    }
    return ok;
  }, [target, toast]);

  if (!target) {
    // 只在「读取失败」时降级为禁用占位；三条判据不满足（会话中 / 无设备等）
    // 依旧整项消失——那是「真的没有可连的」，摆个禁用项反而添堵。
    if (!readFailed) return null;
    return {
      label: "远程设备暂不可用",
      capLabel: "稍后重新打开托盘重试",
      connect: async () => false,
      disabled: true,
    };
  }
  return { label: target.label, capLabel: capabilityLabel(lastRequestCap()), connect };
}
