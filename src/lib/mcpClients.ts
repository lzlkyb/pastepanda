/**
 * mcpClients.ts — MCP 客户端注册表。接入格式的**唯一真相**。
 *
 * 复制卡片与（后续的一键写入器）都从这里取，不各写一份（规则 #11）。
 *
 * # 🔴 每一条都必须带 `evidence`
 *
 * transport 的写法在各家之间**不一致**。在本机扫描实际配置文件得到的分布：
 *   `streamableHttp` 328 · `sse` 24 · `http` 12 · `streamable-http` 6 · 不写 `type` 66
 *
 * 写错一个字的后果不是报错，而是**客户端静静地连不上**。所以这里的每一条
 * 都要标明依据从哪来——**不凭记忆填**，也方便下一个人核。
 */

/** HTTP 类 transport 在各客户端里的写法。 */
export type McpTransport = "http" | "streamableHttp" | "streamable-http" | "sse";

export interface McpClientDef {
  id: string;
  name: string;
  /**
   * 配置文件路径（`~` 代表用户目录）。
   *
   * `null` = **配置不落磁盘或路径不稳定**，只能手动配。
   * 这个字段也是后续“能不能一键”的判据：为 null 就只给复制卡片。
   */
  configPath: string | null;
  transport: McpTransport;
  /** 这家额外要的字段（如 WorkBuddy 的 timeout / disabled）。 */
  extra?: Record<string, unknown>;
  /** 粘到哪里 / 怎么打开那个配置。 */
  where: string;
  /** 为什么不能一键（`configPath` 为 null 时必填）。 */
  manualReason?: string;
  /**
   * 可选：官方 CLI 安装命令（比手改 JSON 可靠）。
   * 有就在展开区里优先给它。
   */
  cli?: (url: string, token: string) => string;
  /** `cli` 旁边要说的话（比如为什么必须带某个参数）。 */
  cliNote?: string;
  /** 🔴 格式依据。改这一条之前先看它。 */
  evidence: string;
}

/** 条目在客户端配置里的名字。各家统一用这个。 */
export const MCP_ENTRY_NAME = "pastepanda";

export const MCP_CLIENTS: McpClientDef[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    configPath: "~/.claude.json",
    transport: "http",
    where: "写进该文件**顶层**的 mcpServers（不是某个 project 下面）。",
    cli: (url, token) =>
      `claude mcp add --transport http --scope user pastepanda ${url} \\\n  --header "Authorization: Bearer ${token}"`,
    cliNote:
      "❗ `--scope user` 不能省。`claude mcp add` 的默认 scope 是 `local`，" +
      "而 local 只对**执行命令时那一个目录**生效。知识库跟项目无关，" +
      "在别的目录开 Claude Code 就没这个工具——而且不报错，最难查的那种。",
    evidence:
      "对照 Claude Code 官方文档核实（2026-09-02）；本机该文件顶层已有多个 mcpServers 条目。",
  },
  {
    id: "workbuddy",
    name: "WorkBuddy",
    configPath: "~/.workbuddy/mcp.json",
    transport: "streamableHttp",
    // 跟它自带连接器的写法保持一致。
    extra: { timeout: 30000, disabled: false },
    where: "写进该文件的 mcpServers。",
    evidence:
      "来自它自带的 141 条内置连接器：31 条用 headers，多条就是 Authorization: Bearer；" +
      "其中 4 条是纯字面量（不带 ${}），说明写死令牌可行。" +
      "它另有 staticHeaders，但那是放来源/版本这类非机密元数据的，令牌不该进那里。",
  },
  {
    id: "cherry-studio",
    name: "Cherry Studio",
    configPath: null,
    transport: "streamableHttp",
    where: "在应用内「设置 → MCP 服务器」里新建，把下面的 JSON 粘进去。",
    manualReason: "配置由应用内 UI 管理，没有稳定的磁盘 JSON 可写。",
    evidence: "官方文档示例使用 streamablehttp + headers 的 Bearer 令牌（2026-09 查）。",
  },
  {
    id: "vscode",
    name: "VS Code（Copilot）",
    configPath: null,
    transport: "http",
    where: "命令面板运行「MCP: Open User Configuration」，把下面的 JSON 合进去。",
    manualReason:
      "用户级配置**没有固定磁盘路径**（官方要求走命令面板）；" +
      ".vscode/mcp.json 只是工作区级，写那里只对单个项目生效。",
    evidence: "VS Code 官方 MCP 配置文档（2026-09 查）。",
  },
];

/**
 * 生成某家客户端的条目对象（不含外层 mcpServers）。
 *
 * ❗ `token` 传占位符还是真令牌由调用方决定：屏幕上显示占位符，
 *   只有点「复制」时才取真的（设置页可能被录屏或截图）。
 */
export function buildMcpEntry(
  client: McpClientDef,
  url: string,
  token: string,
): Record<string, unknown> {
  return {
    type: client.transport,
    url,
    headers: { Authorization: `Bearer ${token}` },
    ...(client.extra ?? {}),
  };
}

/** 生成可直接粘贴的完整 JSON（带外层 mcpServers）。 */
export function buildMcpConfigJson(
  client: McpClientDef,
  url: string,
  token: string,
): string {
  return JSON.stringify(
    { mcpServers: { [MCP_ENTRY_NAME]: buildMcpEntry(client, url, token) } },
    null,
    2,
  );
}
