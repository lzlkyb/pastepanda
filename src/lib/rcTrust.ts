/**
 * rcTrust.ts — 「免确认直连」放权确认的**单一文案源**（规则 11.1 收口，2026-09-23 审计）。
 *
 * 免确认是**长期放行**：开启后该设备发起远程会直接连入本机，不再弹确认条。
 * 审计时发现本功能有**两个入口、两套行为**：
 *   · 会话内确认条 / 主窗横幅 → `useRcTrustEnable`（有 warning 确认）；
 *   · 设备详情「管理此设备」 → `useRcDeviceActions.toggleTrust`（当时**无**确认）。
 * 现在两个入口的确认框都由这里派生——文案漂不了，也堵住「第 N 个入口忘了加确认」。
 *
 * 🔴 只有**开启**方向需要确认（该放权必须读一遍后果）；**关闭**是收回授权、
 * 随时可逆，按 U4「可撤销 > 二次确认」不打断用户。守卫单测见
 * `rcDangerGuards.test.tsx`（钉住「两个入口开方向都走确认、关方向都不走」）。
 */

/** 与 `lib/confirm.ts` 的 confirmDialog 入参同形（不含 resolve）。 */
export interface TrustConfirmRequest {
  title: string;
  message: string;
  confirmText: string;
  variant: "warning";
}

/**
 * 「开启免确认」的确认框参数（唯一实现，两个入口共用）。
 *
 * @param deviceName 展示名（缺省回落到「该设备」）
 */
export function trustEnableConfirm(deviceName: string | undefined): TrustConfirmRequest {
  const name = deviceName || "该设备";
  return {
    title: "开启免确认",
    message:
      `「${name}」以后发起远程时会直接连入本机，不再弹确认条。\n` +
      `可在该设备详情页「管理此设备」里恢复逐次询问；会话仍可随时结束。`,
    confirmText: "开启免确认",
    // 是放权不是删除，用 warning 而不是 danger：图标与确认按钮的语义
    // 要与「这件事可以撤回」一致（UI 规则：危险度分级不能只靠颜色）。
    variant: "warning",
  };
}
