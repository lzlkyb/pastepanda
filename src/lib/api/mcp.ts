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

/** 一条调用记录（W3）。🔴 `args` 只有参数，**不包含笔记正文**。 */
export interface McpAuditRow {
  id: number;
  at: string;
  /** 请求的 User-Agent，如 `claude-code/2.1.233 (sdk-cli)` */
  client: string;
  tool: string;
  args: string;
  ok: boolean;
  hit_count: number;
  /** 逗号分隔的笔记 id */
  note_ids: string;
}

/** 客户端花名册的一行。从审计表聚合而来。 */
export interface McpClientRow {
  client: string;
  first_seen: string;
  last_seen: string;
  calls: number;
}

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

/** 设置页上的一行写权限开关（M5）。 */
export interface McpWriteSwitch {
  /** 配置键，形如 `mcp_write_delete`。回写时原样传回去。 */
  key: string;
  /** 工具名。界面上要显示——它就是用户在调用记录里看到的那个名字。 */
  tool: string;
  label: string;
  enabled: boolean;
}

/** 七个写开关的当前状态。失败返回空数组（面板自己显示读不到）。 */
export async function mcpGetWriteSwitches(): Promise<McpWriteSwitch[]> {
  try {
    return await invoke<McpWriteSwitch[]>("mcp_get_write_switches");
  } catch (e) {
    logger.error("读写权限开关失败", e);
    toastActionFailed("读写权限开关", e);
    return [];
  }
}

/**
 * 改一个写开关，返回改完后的全部七行（`null` = 失败）。
 *
 * 返回全量而不是单行：前端就不用自己拼一份新状态，
 * 少一份「界面以为关了、后端其实没关」的可能。
 */
export async function mcpSetWriteSwitch(
  key: string,
  enabled: boolean,
): Promise<McpWriteSwitch[] | null> {
  try {
    return await invoke<McpWriteSwitch[]>("mcp_set_write_switch", { key, enabled });
  } catch (e) {
    logger.error("保存写权限开关失败", e);
    toastActionFailed("保存写权限开关", e);
    return null;
  }
}

/** 最近的调用记录。红线②的「可见」就靠它。 */
export async function mcpAuditList(limit = 100): Promise<McpAuditRow[]> {
  try {
    return await invoke<McpAuditRow[]>("mcp_audit_list", { limit });
  } catch (e) {
    logger.warn("读取 MCP 调用记录失败", e);
    return [];
  }
}

/**
 * 客户端花名册。
 *
 * ❗ 它回答不了「当前连着几个」——MCP over HTTP 无状态，根本没有「连着」
 *   这回事。界面文案必须是「最近活动过的客户端」，写成连接数就是假的。
 */
export async function mcpAuditClients(): Promise<McpClientRow[]> {
  try {
    return await invoke<McpClientRow[]>("mcp_audit_clients");
  } catch (e) {
    logger.warn("读取 MCP 客户端名单失败", e);
    return [];
  }
}

/** 清空调用记录。红线②的「可删」，调用方要先弹确认。 */
export async function mcpAuditClear(): Promise<number | null> {
  try {
    return await invoke<number>("mcp_audit_clear");
  } catch (e) {
    logger.error("清空 MCP 调用记录失败", e);
    toastActionFailed("清空调用记录", e);
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
