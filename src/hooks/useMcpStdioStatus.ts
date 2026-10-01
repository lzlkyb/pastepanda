/**
 * useMcpStdioStatus —— 读一次 stdio 接入卡的状态（方案 ①）。
 *
 * 单独成钩子有两个理由，都不只是「少几行」：
 *
 * 1. `command`（本程序绝对路径）**只有 Rust 侧知道**。stdio 卡片与复制按钮
 *    全指望它，而它一次读不到就得当场显示出来——把这段留在面板里，
 *    「读失败」很容易顺手写成 `?? ""`，那就变成往用户嘴里塞一个假路径。
 * 2. 接入面板本来就把「复制」与「接入」两条链路背在身上；再挂一份状态
 *    会超过单文件长度上限（规则 #7）。
 *
 * 🔴 不轮询：`command` 只有在换安装目录时才会变，而那种情况下用户会重开程序。
 */
import { useCallback, useEffect, useState } from "react";
import { mcpStdioStatus, type McpStdioStatus } from "@/lib/api/mcp";

export function useMcpStdioStatus() {
  const [stdio, setStdio] = useState<McpStdioStatus | null>(null);
  /** 读失败（不是「还没读到」）。卡片拿它显示一句原因，而不是显示一个空路径。 */
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    const s = await mcpStdioStatus();
    if (s) {
      setStdio(s);
      setFailed(false);
    } else {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { stdio, failed, refresh };
}
