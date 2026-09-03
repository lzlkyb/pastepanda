/**
 * useWideLayout — 「宽屏布局」一键（A-61 ④）。
 *
 * 很多用户不会主动拖窗口，所以根本不知道知识模式有三栏形态。
 * 本 hook 把「变成三栏」需要的两件事合成一个动作：**加宽窗口 + 展开侧栏**。
 *
 * ❗ 它**必须**改窗口尺寸。第三栏的门槛是 `useKbLayout` 里的
 *   `matchMedia("(min-width: 800px)")`，是个硬条件——不加宽窗口，
 *   光展开侧栏也变不出第三栏。
 *
 * 🔴 改用户的窗口是侵入行为，所以：
 *   - **只改宽度**，高度不动（断点只看宽度）
 *   - **不最大化**：那会改窗口状态而不只是尺寸，退不回原样；且用户要的是 2/3 不是全屏
 *   - **可撤销**：toast 带「恢复原尺寸」，存下了改之前的尺寸与位置
 */
import { useCallback, useState } from "react";
import { useToast } from "@/components/Toast";
import { useAppStore } from "@/stores/appStore";
import { logger } from "@/lib/logger";

/**
 * 目标宽度的下限（逻辑像素）。
 *
 * 三栏门槛是 800，这里取 900 留余量：刚好卡在断点上的话，
 * 第三栏只有 ~315px，分屏都开不了（见 NoteDetailPane 的 SPLIT_MIN_WIDTH）。
 */
const MIN_WIDTH = 900;

/** 改之前的窗口尺寸与位置（逻辑像素）。撤销靠它回去。 */
interface WinSnapshot {
  width: number;
  height: number;
  x: number;
  y: number;
}

export function useWideLayout() {
  const { toast } = useToast();
  const sidebarOpen = useAppStore((s) => s.sidebarOpen.knowledge);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const [busy, setBusy] = useState(false);

  /** 退回改之前的尺寸与位置。侧栏不动——展开侧栏本身无害且用户能一键收。 */
  const restore = useCallback(
    async (snap: WinSnapshot) => {
      try {
        const { getCurrentWindow, LogicalSize, LogicalPosition } = await import(
          "@tauri-apps/api/window"
        );
        const win = getCurrentWindow();
        await win.setSize(new LogicalSize(snap.width, snap.height));
        await win.setPosition(new LogicalPosition(snap.x, snap.y));
      } catch (e) {
        // 规则 #15.3：失败不静默。用户刚点了「恢复」，没反应比报错更坏。
        logger.warn("恢复窗口尺寸失败", e);
        toast("恢复窗口尺寸失败，请手动拖回去", "error");
      }
    },
    [toast],
  );

  const goWide = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { getCurrentWindow, LogicalSize, LogicalPosition, currentMonitor } = await import(
        "@tauri-apps/api/window"
      );
      const win = getCurrentWindow();
      const mon = await currentMonitor();
      // 拿不到显示器信息就**不动窗口**：此时算不出 2/3 是多少，
      // 拍一个写死的宽度上去可能把窗口推出屏幕。侧栏还是可以展开。
      if (!mon) {
        logger.warn("拿不到当前显示器信息，只展开侧栏");
        if (!sidebarOpen) toggleSidebar();
        toast("没能读到屏幕尺寸，只展开了侧栏；请手动拖宽窗口", "warning");
        return;
      }

      const sf = await win.scaleFactor();
      const monSize = mon.size.toLogical(mon.scaleFactor);
      const monPos = mon.position.toLogical(mon.scaleFactor);
      const cur = (await win.outerSize()).toLogical(sf);
      const curPos = (await win.outerPosition()).toLogical(sf);

      // 2/3 在 1366 屏上是 911（刚好够）；小屏上 2/3 可能不足 800，那就抬到 900；
      // 但不能超过屏幕本身——屏幕真的小于 900 时，宁可顶满也不能造一个溢出屏幕的窗口。
      const target = Math.min(
        Math.max(Math.round(monSize.width * (2 / 3)), MIN_WIDTH),
        Math.floor(monSize.width),
      );

      // 已经够宽了就只展开侧栏。不把窗口**缩小**到 2/3：
      // 用户已经拉得更宽时，「宽屏布局」去缩小窗口是反向的。
      if (target <= Math.round(cur.width)) {
        if (!sidebarOpen) toggleSidebar();
        return;
      }

      const snap: WinSnapshot = {
        width: Math.round(cur.width),
        height: Math.round(cur.height),
        x: Math.round(curPos.x),
        y: Math.round(curPos.y),
      };

      await win.setSize(new LogicalSize(target, snap.height));

      // 变宽后右边可能越出屏幕（窗口本来靠右放着），把它拉回来。
      // 不做的后果是右侧那一栏（正好是新多出来的第三栏）在屏幕外面。
      const maxX = monPos.x + monSize.width - target;
      if (curPos.x > maxX) {
        await win.setPosition(new LogicalPosition(Math.round(Math.max(monPos.x, maxX)), snap.y));
      }

      if (!sidebarOpen) toggleSidebar();

      // 可撤销：修改用户窗口必须能一键退回去。
      // 6s 而不是默认 4s：用户得先看一眼新布局再决定要不要退。
      toast(
        `已加宽到 ${target}px 并展开侧栏`,
        "success",
        6000,
        () => void restore(snap),
        "恢复原尺寸",
      );
    } catch (e) {
      logger.warn("切宽屏布局失败", e);
      toast("没能调整窗口，请手动拖宽", "error");
    } finally {
      setBusy(false);
    }
  }, [busy, sidebarOpen, toggleSidebar, toast, restore]);

  return { goWide, busy };
}
