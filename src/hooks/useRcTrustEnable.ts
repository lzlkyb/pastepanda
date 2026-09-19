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
 */
import { confirmDialog } from "@/lib/confirm";
import type { ToastFn } from "@/components/Toast";
import type { UseRc } from "@/hooks/useRc";

export function useRcTrustEnable(rc: UseRc, toast: ToastFn) {
  /**
   * @param peerId     设备 node_id
   * @param deviceName 展示名（缺省回落到指纹）
   * @returns 是否真的开启了
   */
  return async (peerId: string, deviceName?: string): Promise<boolean> => {
    const name = deviceName || "该设备";
    const ok = await confirmDialog({
      title: "开启免确认",
      message:
        `「${name}」以后发起远程时会直接连入本机，不再弹确认条。\n` +
        `可在该设备的「⋯」菜单里恢复逐次询问；会话仍可随时结束。`,
      confirmText: "开启免确认",
      // 是放权不是删除，用 warning 而不是 danger：图标与确认按钮的语义
      // 要与「这件事可以撤回」一致（UI 规则：危险度分级不能只靠颜色）。
      variant: "warning",
    });
    if (!ok) return false;
    const done = await rc.setDeviceTrust(peerId, true);
    if (done) toast("已开启免确认：这台设备以后不再询问你", "success");
    return done;
  };
}
