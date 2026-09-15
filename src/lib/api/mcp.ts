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
  /**
   * https 监听真的起来了吗。
   *
   * ❗ 它不等于「开关打开了」：开关开着但端口被占时它是 false，
   *   原因在 `httpsError` 里。界面得拿这两个字段一起读（规则 #15.3）。
   */
  httpsRunning: boolean;
  httpsPort: number;
  /** https 地址。开关关着时也给，理由同 `url`。 */
  httpsUrl: string;
  /** https 没起来的原因；正常时为空串。 */
  httpsError: string;
  /** 局域网直连开关（用户配置）。 */
  lanEnabled: boolean;
  /** 真的绑在 0.0.0.0 上了吗。必须与 lanEnabled 一起读（规则 #15.3）。 */
  lanActive: boolean;
  /** 本机非回环 IPv4。 */
  lanIps: string[];
  /** 局域网开启却 bind 失败时的原因；正常空串。 */
  lanError: string;
}

/** 默认状态：拿不到时绝不能报「运行中」——宁可显示停机，不能谎报服务开着。 */
export const MCP_STATUS_UNKNOWN: McpStatus = {
  running: false,
  port: 0,
  url: "",
  httpsRunning: false,
  httpsPort: 0,
  httpsUrl: "",
  httpsError: "",
  lanEnabled: false,
  lanActive: false,
  lanIps: [],
  lanError: "",
};

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
  /**
   * 这一档管着的全部工具名。界面上要**逐个**显示。
   *
   * 一档可能对多个工具（如「修改笔记」同时管 kb_update 与三个精准编辑工具）。
   * 少列一个就会有人在调用记录里看到它、却在面板上找不到该关哪一行。
   */
  tools: string[];
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

/** 可写入范围选择器里的一行。 */
export interface McpScopeRow {
  /** folder id，或哨兵 `__unfiled__`。 */
  id: string;
  name: string;
  /** 缩进层级，顶层 = 1。 */
  depth: number;
  /** 本文件夹**及其后代**里的笔记数。 */
  notes: number;
  /** 用户直接勾了它。 */
  checked: boolean;
  /** 由祖先的勾继承而来——显示为已勾但淡色、不可单独取消。 */
  inherited: boolean;
}

/** 「可写入的范围」那一区的全部数据。 */
export interface McpWriteScope {
  /** `false` = 从未配过（全库可写）。 */
  restricted: boolean;
  rows: McpScopeRow[];
  covered: number;
  total: number;
}

/** 读可写入范围。失败返回 `null`（面板自己显示读不到）。 */
export async function mcpGetWriteScope(): Promise<McpWriteScope | null> {
  try {
    return await invoke<McpWriteScope>("mcp_get_write_scope");
  } catch (e) {
    logger.error("读可写入范围失败", e);
    toastActionFailed("读可写入范围", e);
    return null;
  }
}

/**
 * 存可写入范围，返回改完后的全量视图（`null` = 失败）。
 *
 * 🔴 `entries` 传 `null` = 「恢复全库」（回到未配过）；
 * 传 `[]` = 「一篇都不可写」。**两者不是一回事**，切勿把空数组当成清空语义传——
 * 那会让用户取消全部勾选后得到相反的结果（授权全库）。
 *
 * 返回全量而不是单行：前端就不用自己算继承态与篇数，
 * 少一份「界面以为改了、后端其实没改」的可能。
 */
export async function mcpSetWriteScope(
  entries: string[] | null,
): Promise<McpWriteScope | null> {
  try {
    return await invoke<McpWriteScope>("mcp_set_write_scope", { entries });
  } catch (e) {
    logger.error("保存可写入范围失败", e);
    toastActionFailed("保存可写入范围", e);
    return null;
  }
}

/** AI 经 MCP 建的文件夹（项目③）。 */
export interface McpAiFolder {
  id: string;
  name: string;
  parentId: string | null;
  /** 含后代的笔记数。 */
  noteCount: number;
  depth: number;
  createdAt: string;
}

/** AI 建的文件夹列表。失败返回空数组。 */
export async function mcpAiFolders(): Promise<McpAiFolder[]> {
  try {
    return await invoke<McpAiFolder[]>("mcp_ai_folders");
  } catch (e) {
    logger.warn("读 AI 建的文件夹失败", e);
    return [];
  }
}

/**
 * 撤销一个 AI 建的文件夹。返回 `[挑走的笔记数, 挑走的子夹数]`，`null` = 失败。
 *
 * 语义是「删掉它，里面的东西升到父级」——**不是「恢复原状」**。
 * 如果笔记本来在别的夹子里、被 AI 挑进来的，撤销不会把它送回原处；
 * 界面文案得把实际去向直接告知，不能用「恢复原状」这种假词。
 */
export async function mcpUndoAiFolder(id: string): Promise<[number, number] | null> {
  try {
    return await invoke<[number, number]>("mcp_undo_ai_folder", { id });
  } catch (e) {
    logger.error("撤销 AI 文件夹失败", e);
    toastActionFailed("撤销 AI 文件夹", e);
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

// ─── 一键接入（对应 commands/mcp_connect.rs）───

/** 某个客户端配置的探测结果。 */
export interface McpClientProbe {
  /** 展开 `~` 后的绝对路径。确认框里要把它原样显示出来。 */
  path: string;
  exists: boolean;
  /**
   * 这台机器上**这个工具在不在**（看它自己的目录，不是看 MCP 配置文件）。
   *
   * 🔴 界面分组靠它而**不是** `exists`：工具装了但从没配过 MCP（目录在、
   * 配置文件不在）恰恰是一键接入最有用的场景。
   */
  toolPresent: boolean;
  /**
   * `none` 未接入 · `current` 已接入且地址令牌都对 ·
   * `stale` 接入过但地址/令牌变了 · `unreadable` 读不了或解析不开
   *
   * ❗ `stale` 不能当成「已接入」显示：那个客户端其实已经连不上了，而它不会报错。
   */
  state: "none" | "current" | "stale" | "unreadable";
  /** `unreadable` 时的原因；其余情况为空串。 */
  detail: string;
}

/** 一次写入（接入或移除）的结果。 */
export interface McpConnectOutcome {
  path: string;
  /** 备份文件路径；原文件不存在（本次新建）或未发生改动时为空串。 */
  backup: string;
  /** 本次是否盖掉/删掉了一条已存在的条目。 */
  replaced: boolean;
}

/**
 * 探测某个客户端的接入状态。
 *
 * 失败不弹 toast：面板一打开就批量跑，弹了就是好几个一起刷。
 * 后端已把「读不了」变成 `state: "unreadable"` 返回，界面在卡片上就地显示原因。
 */
export async function mcpClientProbe(
  configPath: string,
  /** 不传 = `mcpServers`。OpenCode 那类容器键不同的客户端必须传。 */
  containerKey?: string,
  /** 工具自己的目录，只用来算 `toolPresent`。不传就等于 `exists`。 */
  detectPath?: string,
): Promise<McpClientProbe | null> {
  try {
    return await invoke<McpClientProbe>("mcp_client_probe", {
      configPath,
      containerKey,
      detectPath,
    });
  } catch (e) {
    logger.warn("探测 MCP 客户端配置失败", e);
    return null;
  }
}

/**
 * 一键接入：备份 → 合并 → 原子写。调用方**必须先弹确认**（这会改用户自己的文件）。
 *
 * `entry` 用 `buildMcpEntryForConnect()` 拼，令牌位置是占位符；后端才换真令牌。
 * 失败返回错误文案（而不是 `null`）：后端的错误话术写得很具体（哪个文件、
 * 为什么没改），丢掉就只剩一个「接入失败」。
 */
export async function mcpClientConnect(
  configPath: string,
  entry: Record<string, unknown>,
  /** 不传 = `mcpServers`。写错会往客户端配置里造一个它不认的键。 */
  containerKey?: string,
): Promise<{ ok: McpConnectOutcome } | { err: string }> {
  try {
    return {
      ok: await invoke<McpConnectOutcome>("mcp_client_connect", {
        configPath,
        entry,
        containerKey,
      }),
    };
  } catch (e) {
    logger.error("一键接入失败", e);
    return { err: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 移除接入：只删容器里的 `pastepanda` 那一条。同样需要调用方先弹确认。
 *
 * ❗ `containerKey` 必须与接入时传的一致，否则会去一个根本没写过的键里找，
 *   结果是“移除成功”但条目还在。
 */
export async function mcpClientDisconnect(
  configPath: string,
  containerKey?: string,
): Promise<{ ok: McpConnectOutcome } | { err: string }> {
  try {
    return {
      ok: await invoke<McpConnectOutcome>("mcp_client_disconnect", { configPath, containerKey }),
    };
  } catch (e) {
    logger.error("移除 MCP 接入失败", e);
    return { err: e instanceof Error ? e.message : String(e) };
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

// ─── HTTPS / CA 信任库（TLS-1 / TLS-2）───

/** CA 状态。对应 Rust 的 `mcp::tls::CaStatus`。 */
export interface McpTlsCaStatus {
  /** 证书三件套生成了吗（打开 HTTPS 开关时自动生成）。 */
  generated: boolean;
  /** 装进「当前用户」信任库了吗。 */
  installed: boolean;
  /** CA 证书文件绝对路径；未生成时为空串。确认框要显示。 */
  caPath: string;
  /** 信任库里的 SHA1（hex，无分隔）；未装时为空串。 */
  thumbprint: string;
}

/** 读 CA 状态。失败返回 `null`（面板自己显示读不到）。 */
export async function mcpTlsCaStatus(): Promise<McpTlsCaStatus | null> {
  try {
    return await invoke<McpTlsCaStatus>("mcp_tls_ca_status");
  } catch (e) {
    logger.warn("读取 CA 状态失败", e);
    return null;
  }
}

/**
 * 开/关 HTTPS 监听并持久化。
 *
 * 🔴 **打开 ≠ 客户端就能用**：还得装 CA 进信任库（另一个命令）。
 * 失败返回错误文案；监听起不来不回滚配置——原因会从 `httpsError` 带到界面。
 */
export async function mcpSetHttpsEnabled(enabled: boolean): Promise<string | null> {
  try {
    await invoke("mcp_set_https_enabled", { enabled });
    return null;
  } catch (e) {
    logger.error("切换 HTTPS 失败", e);
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * 把 CA 装进当前用户信任库。**调用方必须先弹确认**。
 *
 * certutil 还会再弹一次系统确认框——两道都别省。
 * 返回最新状态（`null` = 失败，调用方用 toast 报）。
 */
export async function mcpTlsInstallCa(): Promise<McpTlsCaStatus | null> {
  try {
    return await invoke<McpTlsCaStatus>("mcp_tls_install_ca");
  } catch (e) {
    logger.error("安装 CA 失败", e);
    toastActionFailed("安装 CA 到信任库", e);
    return null;
  }
}

/**
 * 从当前用户信任库移除 CA。幂等：本来就没装不报错。
 *
 * **不会**删本地证书文件——下次开 HTTPS 还能直接用。
 */
export async function mcpTlsRemoveCa(): Promise<McpTlsCaStatus | null> {
  try {
    return await invoke<McpTlsCaStatus>("mcp_tls_remove_ca");
  } catch (e) {
    logger.error("移除 CA 失败", e);
    toastActionFailed("从信任库移除 CA", e);
    return null;
  }
}

// ─── 局域网直连 ───

/**
 * 开/关局域网直连。
 *
 * 服务在跑会重启监听。失败返回错误文案；成功返回最新 status。
 * 🔴 **不做 IP 白名单**：开着时凭 Bearer 令牌即可连入。
 */
export async function mcpSetLanEnabled(
  enabled: boolean,
): Promise<{ status: McpStatus | null; err: string | null }> {
  try {
    const status = await invoke<McpStatus>("mcp_set_lan_enabled", { enabled });
    return { status, err: null };
  } catch (e) {
    logger.error("切换局域网访问失败", e);
    return { status: null, err: e instanceof Error ? e.message : String(e) };
  }
}
