/**
 * MCP 服务的状态与动作（M4 步骤 4）。**UI 一行不写**，全部副作用收在这里。
 *
 * 三件它必须包起来的事：
 * ① 5s 轮询，但**窗口隐藏时暂停**（设置页 WebView 在 hide() 后仍存活，
 *   空转就是烧 CPU——同 LanSyncPanel 当初的修法，规则 #8）；
 * ② 轮询失败**只在「从成功转失败」时提示一次**，否则 5s 一条 toast 刷屏；
 * ③ 监听后端的 `mcp-start-failed`——**开机自启失败发生在设置页打开之前**，
 *   不接这个事件的话用户看到的就只是个静默的「未运行」，不知道为什么。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import { logger } from "@/lib/logger";
import {
  mcpGetStatus,
  mcpSetEnabled,
  mcpSetPort,
  MCP_STATUS_UNKNOWN,
  type McpStatus,
} from "@/lib/api/mcp";

/** 轮询间隔。同 LanSyncPanel 的 5s：服务可能被外部弄停，界面得能发现。 */
const POLL_MS = 5000;

export function useMcpServer(
  toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void,
) {
  const [status, setStatus] = useState<McpStatus>(MCP_STATUS_UNKNOWN);
  const [busy, setBusy] = useState(false);
  /** 启动失败的原因。非空就在面板里挂一条横幅，不靠 toast——toast 会飘走。 */
  const [startError, setStartError] = useState("");
  /**
   * 审计写入失败（W3）。fail-open 下服务照常跑，所以这是用户知道
   * 「这段时间的访问没被记下」的**唯一途径**。不用 toast：它会飘走，
   * 而用户可能根本没开着设置页。
   */
  const [auditError, setAuditError] = useState("");

  const wasOkRef = useRef(true);

  const refresh = useCallback(async () => {
    const s = await mcpGetStatus();
    if (s) {
      setStatus(s);
      wasOkRef.current = true;
      return;
    }
    // 拿不到状态时**不改 status**：把它刷成「未运行」会让用户以为服务挂了，
    // 而实际上只是这一次 IPC 没回。
    if (wasOkRef.current) toast("读取 MCP 服务状态失败", "error");
    wasOkRef.current = false;
  }, [toast]);

  // 窗口隐藏时暂停轮询（规则 #8）
  const winVisible = useWindowVisible();
  useEffect(() => {
    if (!winVisible) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, winVisible]);

  // 后端自启失败（发生在设置页打开之前，所以必须靠事件，轮询看不出原因）
  useEffect(() => {
    let un: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      un = await listen<string>("mcp-start-failed", (e) => {
        logger.warn("MCP 服务自启失败", e.payload);
        setStartError(String(e.payload));
      });
    })();
    return () => un?.();
  }, []);

  // 审计写不下（W3）。同样必须靠事件：它发生在请求处理中，轮询看不到。
  useEffect(() => {
    let un: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      un = await listen<string>("mcp-audit-failed", (e) => {
        logger.warn("MCP 审计写入失败", e.payload);
        setAuditError(String(e.payload));
      });
    })();
    return () => un?.();
  }, []);

  const setEnabled = useCallback(
    async (next: boolean) => {
      setBusy(true);
      setStartError("");
      const err = await mcpSetEnabled(next);
      if (err) {
        // 启动失败最常见的原因是端口被占，而用户能自己改端口解决。
        // 所以错误得**留在面板上**（横幅），不能只飘一个 toast 就没了。
        setStartError(err);
      }
      await refresh();
      setBusy(false);
    },
    [refresh],
  );

  const setPort = useCallback(
    async (port: number) => {
      setBusy(true);
      const err = await mcpSetPort(port);
      if (err) {
        setStartError(err);
      } else {
        setStartError("");
        toast(`监听端口已改为 ${port}`, "success");
      }
      await refresh();
      setBusy(false);
      return !err;
    },
    [refresh, toast],
  );

  return {
    status,
    busy,
    startError,
    auditError,
    setEnabled,
    setPort,
    refresh,
    dismissError: () => setStartError(""),
    dismissAuditError: () => setAuditError(""),
  };
}
