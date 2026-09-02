/**
 * 知识库 MCP 服务 API（M4）。对应 src-tauri/src/commands/mcp.rs。
 *
 * 🔴 **令牌只在用户主动索取时才拿**（`mcpGetToken`）。
 * 它故意不在 `mcpGetStatus` 里——那个会被设置页 5s 轮询，
 * 令牌也就跟着一遍遍过到前端、进到开发者工具的网络面板里去。
 *
 * 失败一律日志 + toast，**不静默**（规则 #15.3）。
 */
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";
import { toastActionFailed } from "@/lib/utils";

/** 服务状态。字段名与 Rust 的 `McpStatus` 一致。 */
export interface McpStatus {
  running: boolean;
  port: number;
  /** 直接能拷走填进 MCP 客户端的地址。**停机时也给**，方便用户先看后开 */
  url: string;
}

/** 默认状态：拿不到时绝不能报「运行中」——宁可显示停机，不能谎报服务开着。 */
export const MCP_STATUS_UNKNOWN: McpStatus = { running: false, port: 0, url: "" };

/**
 * 当前状态。**不含令牌**。
 *
 * 失败不弹 toast：它被 5s 轮询，弹了就是刷屏。
 * 调用方（`useMcpServer`）用 `wasOk` 只在「从成功转失败」时提示一次。
 */
export async function mcpGetStatus(): Promise<McpStatus | null> {
  try {
    return await invoke<McpStatus>("mcp_get_status");
  } catch (e) {
    logger.warn("读取 MCP 服务状态失败", e);
    return null;
  }
}

/** 开关服务。失败返回错误文案（端口被占那句要给用户看），成功返回 `null`。 */
export async function mcpSetEnabled(enabled: boolean): Promise<string | null> {
  try {
    await invoke("mcp_set_enabled", { enabled });
    return null;
  } catch (e) {
    logger.error("切换 MCP 服务失败", e);
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * 取令牌。**只在用户点「显示」或「复制」时调**，不要放进轮询。
 *
 * 首次调用会生成并落盘（DPAPI 加密），所以它不是个纯读操作。
 */
export async function mcpGetToken(): Promise<string | null> {
  try {
    return await invoke<string>("mcp_get_token");
  } catch (e) {
    logger.error("读取 MCP 令牌失败", e);
    toastActionFailed("读取访问令牌", e);
    return null;
  }
}

/**
 * 重置令牌。旧令牌立即失效，**已配好的客户端全部断连**——
 * 调用方必须先弹确认。服务在跑时也能重置，下一个请求就用新令牌，无需重启。
 */
export async function mcpRegenerateToken(): Promise<string | null> {
  try {
    return await invoke<string>("mcp_regenerate_token");
  } catch (e) {
    logger.error("重置 MCP 令牌失败", e);
    toastActionFailed("重置访问令牌", e);
    return null;
  }
}

/**
 * 改监听端口。成功返回 `null`，失败返回错误文案。
 *
 * 后端拒绝 1024 以下（特权/保留端口），且**新端口绑不上就不落盘**——
 * 否则下次启动会带着一个永远启不了的端口。
 */
export async function mcpSetPort(port: number): Promise<string | null> {
  try {
    await invoke("mcp_set_port", { port });
    return null;
  } catch (e) {
    logger.error("修改 MCP 端口失败", e);
    return e instanceof Error ? e.message : String(e);
  }
}
