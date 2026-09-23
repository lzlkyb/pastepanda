/**
 * useRcTrustEnable — 「以后不再询问」（免确认直连）这条**放权动作**的唯一实现。
 *
 * 🔴 为什么要二次确认（D2）：它开的是**长期放行**——开启之后那台设备发起远程会
 *    直接连入本机，不再弹确认条。而两个入口都紧挨着「立即结束」这个危险按钮
 *    （主窗常驻横幅 `RcControlBanner` / 工作台被控视图 `RcInboundView`），
 *    一次误触就等于把本机长期交出去，代价与「点错一个按钮」完全不对称。
 *    确认框承担的是**读一遍后果**这件事，光靠 title 气泡（要悬停才出）不够。
 *
 * 为什么抽成 hook 而不是写在两个组件里：主窗与工作台各有一份 rcStore 实例，
 * 动作必须都走这里，否则「确认文案」会变成两处各写各的、慢慢说不到一件事。
 * 同理，`confirmDialog` 的返回是 Promise<boolean>，拒绝时**绝对不能**落到调用。
 *
 * 2026-09-23 审计：确认框的文案已收口到 `lib/rcTrust.ts`——设备详情
 * 「管理此设备」那条第二个入口（`useRcDeviceActions.toggleTrust`）开方向
 * 也调用同一份，两个入口的确认再也拆不开。
 */
import { confirmDialog } from "@/lib/confirm";
import { trustEnableConfirm } from "@/lib/rcTrust";
import { useRcStore } from "@/stores/rcStore";
import type { ToastFn } from "@/components/Toast";
import type { UseRc } from "@/hooks/useRc";

export function useRcTrustEnable(rc: UseRc, toast: ToastFn) {
  /**
   * @param peerId     设备 node_id
   * @param deviceName 展示名（缺省回落到指纹）
   * @returns 是否真的开启了
   */
  return async (peerId: string, deviceName?: string): Promise<boolean> => {
    const ok = await confirmDialog(trustEnableConfirm(deviceName));
    // 用户取消确认框 = 自己的选择，不吭声；后端拒绝才是需要报的失败。
    if (!ok) return false;
    const done = await rc.setDeviceTrust(peerId, true);
    if (done) toast("已开启免确认：这台设备以后不再询问你", "success");
    // B2（2026-09-23）：原先失败静默——放权按钮点了没反应，用户只会再点一次。
    else {
      const err = useRcStore.getState().error;
      toast(err ? `开启免确认失败：${err}` : "开启免确认失败，请重试", "error");
    }
    return done;
  };
}
