/**
 * 预览窗窗壳：三键 + 最大化态 + 自绘边带缩放（2026-10-18）。
 *
 * 为什么不用 `getCurrentWindow().minimize()`：per-window ACL 是本项目一整类
 * **静默**故障的来源（`lib/rcWindowOps.ts` 文件头的 2026-09-18 / 09-25 两次前科）。
 * 两侧命令都取**注入窗口**、不经 ACL，失败以人话 String 返回，这里统一上抛。
 *
 * 最大化态取命令的返回值，不靠猜尺寸：拖边、双击标题栏、Win+↑ 都会改它，
 * 而这三条路径里只有「窗口尺寸变化」是前端一定能收到的信号——所以 DOM `resize`
 * 到点后向命令对账一次（防抖 140ms，拖边期间不会打一串 IPC）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  recPreviewResize,
  recPreviewWindow,
  type RecPreviewWindowOp,
  type RecResizeDir,
} from "@/lib/api/rec";

export function useRecPreviewWindow(onError: (message: string) => void) {
  const [maximized, setMaximized] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(
    async (op: RecPreviewWindowOp) => {
      try {
        const value = await recPreviewWindow(op);
        if (alive.current) setMaximized(value);
      } catch (e) {
        onError(`窗口操作失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [onError],
  );
  const sync = useCallback(async () => {
    try {
      const value = await recPreviewWindow("query");
      if (alive.current) setMaximized(value);
    } catch {
      // 对账失败只会让圆角/图标多留一帧旧态，不值得弹错打断用户
    }
  }, []);
  useEffect(() => {
    let timer: number | undefined;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void sync(), 140);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(timer);
    };
  }, [sync]);
  const resize = useCallback(
    async (dir: RecResizeDir) => {
      try {
        await recPreviewResize(dir);
      } catch (e) {
        onError(`调整窗口大小失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [onError],
  );
  return { maximized, run, resize };
}
