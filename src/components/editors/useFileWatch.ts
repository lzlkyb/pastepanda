/**
 * 轮询单个文件的 mtime，检测「文件已在外部被修改」。
 *
 * **为什么用轮询而不是文件 watcher**：单个文件每 2 秒 stat 一次成本可忽略，
 * 而 watcher 要处理一堆麻烦——部分编辑器保存时先删再建会触发多次事件、
 * 部分平台会漏事件、还要引依赖。轮询行为完全可预测。
 *
 * 编辑器窗口只在用户编辑时开着，不是常驻进程，所以也没有后台开销问题。
 *
 * **mtime = 0 一律当作“未知，不做判断”**（后端拿不到时就返 0）。
 * 宁可漏报不可误报：误报会在用户没改过文件时弹“要不要覆盖”，比不报更烦人。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWindowVisible } from "@/hooks/useWindowVisible";

/** 轮询间隔。2 秒足够跟手，又不会让 stat 变成噪音。 */
const POLL_MS = 2000;

async function mtimeOf(path: string): Promise<number> {
  try {
    return await invoke<number>("file_mtime_ms", { path });
  } catch {
    // 文件被删/被重命名/没权限——都归为“未知”，不做判断
    return 0;
  }
}

export interface FileWatch {
  /** 磁盘上的版本比我们手里的新 */
  externalChanged: boolean;
  /** 记下当前磁盘版本（加载完 / 保存完调），并清掉变更标记 */
  markSynced: (path: string | null) => Promise<void>;
  /** 立刻查一次（保存前的冲突检测用）；true = 磁盘已变 */
  checkNow: () => Promise<boolean>;
}

export function useFileWatch(filePath: string | null): FileWatch {
  /**
   * 我们认为磁盘上是哪一版。0 = 未知。
   *
   * 用 ref 而非 state：它不影响渲染，而且 `checkNow` 必须能读到最新值
   * ——若用 state，保存回调里拿到的可能是闭包里的旧值，会误报冲突。
   */
  const knownMtimeRef = useRef(0);
  const [externalChanged, setExternalChanged] = useState(false);

  const markSynced = useCallback(async (path: string | null) => {
    knownMtimeRef.current = path ? await mtimeOf(path) : 0;
    setExternalChanged(false);
  }, []);

  const checkNow = useCallback(async () => {
    if (!filePath || knownMtimeRef.current === 0) return false;
    const m = await mtimeOf(filePath);
    return m !== 0 && m !== knownMtimeRef.current;
  }, [filePath]);

  /**
   * 路径一变就把基准重置为“未知”。
   *
   * `knownMtimeRef` 是 ref，不会随依赖变化自动清。另存为之后路径换了但
   * 基准还是旧文件的，就会拿**新文件的 mtime 比旧文件的**——几乎必然不相等，
   * 直接误报“外部改过了”。
   *
   * 重置成 0 而不是去读新值：0 = 不做判断，等调用方 `markSynced` 建立基准。
   * 这样 hook 自己就是对的，不依赖调用方记得在每个换路径的地方都调一次。
   */
  useEffect(() => {
    knownMtimeRef.current = 0;
    setExternalChanged(false);
  }, [filePath]);

  // 窗口隐藏（辅助窗口 hide()）时暂停轮询：WebView 仍存活，空转会烧 CPU（claude.md 规则 8）
  const winVisible = useWindowVisible();

  useEffect(() => {
    if (!filePath) {
      setExternalChanged(false);
      return;
    }
    if (!winVisible) return;
    let stopped = false;
    const id = window.setInterval(() => {
      void (async () => {
        if (stopped) return;
        if (await checkNow()) setExternalChanged(true);
      })();
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [filePath, checkNow, winVisible]);

  return { externalChanged, markSynced, checkNow };
}
