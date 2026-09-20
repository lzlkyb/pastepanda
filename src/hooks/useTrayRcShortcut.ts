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
 * 读取任一步失败都当作「没有」——弹窗是高频入口，宁可少一项也不能报错刷屏。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { rcRequestSession, rcStatus, rcTargets, rcCancelRequest } from "@/lib/api/rc";
import { lastRcTarget } from "@/lib/rcDevice";
import { capabilityLabel, lastRequestCap } from "@/lib/rcRequest";
import { useRcStore } from "@/stores/rcStore";
import { useToast, UNDO_WINDOW_MS } from "@/components/Toast";

export interface TrayRcShortcut {
  /** 设备显示名（备注优先，与工作台同一口径）。 */
  label: string;
  /** 将以哪一档连接（「只看」/「可控」）——托盘行的 hint，沿用上次用过的档。 */
  capLabel: string;
  /** 打开工作台并发起申请；返回 false = 发起失败（错误已进工作台错误面板）。 */
  connect: () => Promise<boolean>;
}

export function useTrayRcShortcut(): TrayRcShortcut | null {
  const [target, setTarget] = useState<{ nodeId: string; label: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const st = await rcStatus();
        if (!st.running || st.session) return;
        if ((st.pending?.length ?? 0) > 0) return;
        const dev = lastRcTarget(await rcTargets());
        if (cancelled || !dev) return;
        setTarget({
          nodeId: dev.node_id,
          label: dev.note?.trim() || dev.name || "未命名设备",
        });
      } catch (e) {
        console.warn("[TrayRc] 读取远程状态失败，不显示快捷连接项:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  if (!target) return null;
  return { label: target.label, capLabel: capabilityLabel(lastRequestCap()), connect };
}
