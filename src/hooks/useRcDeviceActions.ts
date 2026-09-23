/**
 * useRcDeviceActions — 设备行上的四个动作（忘记 / 禁止-允许 / 备注 / 免确认）。
 *
 * 抽出来的理由：这四个动作都要「先 await 调用方 → 成功才 toast → 成功才收菜单」，
 * 原先全挤在 RcDeviceList 里（那个文件因此涨到 329 行，超了 .tsx 300 的红线）。
 * 动作与渲染分开之后，RcDeviceRow 只管画，RcDeviceList 只剩容器。
 *
 * 统一纪律（别在调用点破坏它）：
 * - 失败**不** toast——调用方（store 的 run()）已经把原因落到工作台的错误行，
 *   这里再弹一次是重复；成功才留痕。
 * - 只有成功才收起菜单/编辑框；失败保持打开，不让用户白打一遍字。
 */
import { useCallback } from "react";
import { confirmDialog } from "@/lib/confirm";
import { normalizeRcNote } from "@/lib/rcDevice";
import { trustEnableConfirm } from "@/lib/rcTrust";

type ToastFn = (m: string, k: "success" | "error" | "info") => void;

export function useRcDeviceActions({
  onForget,
  onSetAllowed,
  onTrustToggle,
  onAutoAcceptToggle,
  onRename,
  toast,
}: {
  onForget: (id: string) => Promise<boolean>;
  onSetAllowed: (id: string, allowed: boolean) => Promise<boolean>;
  onTrustToggle: (id: string, trusted: boolean) => Promise<boolean>;
  /** 决策 10：切换「自动接收此设备推送的文件」。 */
  onAutoAcceptToggle: (id: string, on: boolean) => Promise<boolean>;
  onRename: (id: string, note: string) => Promise<boolean>;
  toast: ToastFn;
}) {
  /** 忘记：先确认再动（这是列表里唯一不可逆的一项）。
   *  返回 `ok`：调用方据此决定要不要收起菜单（失败时保持打开）。 */
  const forget = useCallback(
    async (id: string, name: string): Promise<boolean> => {
      const ok = await confirmDialog({
        title: "忘记此设备",
        message: `将从远程配对列表移除「${name}」。之后需要重新配对才能远程。`,
        confirmText: "忘记",
        variant: "danger",
      });
      if (!ok) return false;
      const done = await onForget(id);
      if (done) toast("已忘记该设备", "success");
      return done;
    },
    [onForget, toast],
  );

  /** C9：函数名叫「deny」却在「允许」——改名 setAllowed，与行为一致。
   *
   * 🔴 2026-09-18 修：第二个参数从「**当前**是否已禁止」改成「**想要**的允许状态」。
   *    原签名是布尔取反（内部 `!currentlyDenied`），而调用方一律按「想要的状态」传，
   *    两边反了两次，结果**两个入口都成了「啥也没干 + toast 撒谎」**：
   *      · 行内「解除禁止」(denied) 传 true → 后端收到 false → 仍然禁止，却提示「已允许」；
   *      · 菜单「禁止远程本机」(未禁止) 传 false → 后端收到 true → 仍然允许，却提示「已禁止」。
   *    取反只该有一处，放在调用方（`!trusted` 那种）——这里与后端 `rc_set_device_allowed`
   *    同名同义，`allowed` 就是这个布尔本身。守卫单测见 `rcDeviceList.test.tsx`。 */
  const setAllowed = useCallback(
    async (id: string, allowed: boolean): Promise<boolean> => {
      const ok = await onSetAllowed(id, allowed);
      if (ok) {
        toast(allowed ? "已允许该设备远程本机" : "已禁止该设备远程本机", "success");
      }
      return ok;
    },
    [onSetAllowed, toast],
  );

  /** A1：改名。归一化口径与后端 `normalize_note` 同源（trim + 按字符截断）——
   *  内联的 `slice(0, 60)` 数是 UTF-16 单元，与后端的字符数不是一回事。
   *  返回 `ok`：失败时调用方**必须保持编辑框打开**，不让用户白打一遍字。 */
  const saveRename = useCallback(
    async (id: string, raw: string): Promise<{ ok: boolean; note: string }> => {
      const note = normalizeRcNote(raw);
      const ok = await onRename(id, note);
      if (ok) toast(note ? "备注已保存" : "备注已清除", "success");
      return { ok, note };
    },
    [onRename, toast],
  );

  /** A1：免确认直连（方案 D 能力，原先只藏在设置页第四层）。
   *
   * 🔴 2026-09-23 审计（规则 11.1 收口）：**开启方向必须先过确认框**。这是免确认
   *    放权的第二个入口（设备详情「管理此设备」），以前它裸调 toggleTrust——
   *    与会话内入口（`useRcTrustEnable`）双轨不一致，误触就是把本机长期交出去。
   *    确认参数两边共用 `lib/rcTrust.ts` 的同一份；**关闭**是收回授权、可逆，
   *    按 U4 不打断。守卫单测见 `rcDangerGuards.test.tsx`。 */
  const toggleTrust = useCallback(
    async (id: string, trusted: boolean, deviceName?: string): Promise<boolean> => {
      if (trusted) {
        const confirmed = await confirmDialog(trustEnableConfirm(deviceName));
        if (!confirmed) return false;
      }
      const ok = await onTrustToggle(id, trusted);
      if (ok) {
        toast(
          trusted ? "已开启免确认：这台设备远程本机时不再询问你" : "已恢复每次询问",
          "success",
        );
      }
      return ok;
    },
    [onTrustToggle, toast],
  );

  /**
   * 决策 10：自动接收文件（对方推送时跳过确认条）。
   *
   * 与 `toggleTrust` 是两件独立的事，**文案必须说清方向**：这条只影响「别人发文件给我」，
   * 不影响「要不要接管我的屏幕」——两句话混用会让人以为开了这个对方就能控制本机。
   */
  const toggleAutoAccept = useCallback(
    async (id: string, on: boolean): Promise<boolean> => {
      const ok = await onAutoAcceptToggle(id, on);
      if (ok) {
        toast(
          on
            ? "已开启自动接收：这台设备发来的文件会自动存到默认接收目录"
            : "已关闭自动接收：这台设备发文件前会先询问你",
          "success",
        );
      }
      return ok;
    },
    [onAutoAcceptToggle, toast],
  );

  return { forget, setAllowed, saveRename, toggleTrust, toggleAutoAccept };
}

