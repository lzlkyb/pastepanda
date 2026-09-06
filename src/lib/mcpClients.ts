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

/**
 * 四种写法及其常见度。**自定义接入的选择器用它。**
 *
 * 数据来自在本机扫描实际存在的 MCP 配置文件（见本文件头部）。
 * 把数量写进界面是故意的：用户不可能知道该选哪个，而**选错不会报错，
 * 只会静静地连不上**——给个“大家都用哪个”比什么都不说强。
 */
export const MCP_TRANSPORTS: { value: McpTransport; hint: string }[] = [
  { value: "streamableHttp", hint: "最常见（本机扫到 328 处），拿不准就选它" },
  { value: "sse", hint: "较早的写法（24 处）" },
  { value: "http", hint: "Claude Code 用这个（12 处）" },
  { value: "streamable-http", hint: "连字符写法（6 处）" },
];

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
   * 接入确认框里要多说的一句（可选）。
   *
   * 用于那些**自己也会改这个文件**的客户端：它们运行期间可能拿内存里的
   * 旧快照整份写回去，把我们刚写的条目盖掉。
   */
  writeRaceCaveat?: string;
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

/**
 * 条目在客户端配置里的名字。各家统一用这个。
 *
 * ❗ 后端 `commands/mcp_connect.rs` 里又写了一份（故意的：写死在 Rust 端，
 *   这样无论前端怎么错，「移除接入」也只删得掉我们自己那一条）。
 *   两边改其中一个的后果：探测永远报「未接入」，而每次接入都多写一条。
 */
export const MCP_ENTRY_NAME = "pastepanda";

/**
 * 令牌占位符。一键接入时拼条目用它占位，由后端换成真令牌。
 *
 * 🔴 必须与 `commands/mcp_connect.rs` 的 `TOKEN_SENTINEL` 字字相同。
 *   这样安排的理由：条目的**形状**（transport 写法、额外字段）只在本文件
 *   定义一份（屏幕上的复制卡片也靠它），而**真令牌从头到尾不进前端**。
 *   后端在条目里一次都没换到占位符时会直接报错，不会把占位符字面量写进用户配置。
 */
export const MCP_TOKEN_SENTINEL = "__PASTEPANDA_TOKEN__";

/** 能不能一键：有稳定的磁盘配置路径才能。 */
export function canOneClick(client: McpClientDef): boolean {
  return client.configPath !== null;
}

/**
 * 拼一份交给后端写入的条目（令牌位置是占位符）。
 *
 * 跟屏幕上的复制卡片走的是同一个 `buildMcpEntry`——只差一个令牌字串，
 * 所以「手动粘的」与「一键写的」不可能分岔。
 */
export function buildMcpEntryForConnect(
  client: McpEntryShape,
  url: string,
): Record<string, unknown> {
  return buildMcpEntry(client, url, MCP_TOKEN_SENTINEL);
}

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
    writeRaceCaveat:
      "这个文件不只放 MCP 配置，Claude Code 运行时还会往里面写启动次数、会话历史等东西。" +
      "如果它正开着，接入后请重启它再确认一下条目还在（不放心就先退出再接入）。",
    evidence:
      "对照 Claude Code 官方文档核实（2026-09-02）；本机该文件顶层已有多个 mcpServers 条目，" +
      "同时还带 projects / skillUsage / tipsHistory 等 30 多个顶层键（所以只能合并、不能覆盖）。",
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
 * 拼一条条目所需的最小信息。
 *
 * ❗ 故意比 `McpClientDef` 窄：**自定义接入**时用户只挑了一个 transport，
 *   没有 name / where / evidence 可填。要求传完整定义只会逼着调用方
 *   造一个假的 `evidence`——而那个字段存在的意义就是“不凭记忆填”。
 */
export type McpEntryShape = Pick<McpClientDef, "transport" | "extra">;

/**
 * 生成某家客户端的条目对象（不含外层 mcpServers）。
 *
 * ❗ `token` 传占位符还是真令牌由调用方决定：屏幕上显示占位符，
 *   只有点「复制」时才取真的（设置页可能被录屏或截图）。
 */
export function buildMcpEntry(
  client: McpEntryShape,
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
  client: McpEntryShape,
  url: string,
  token: string,
): string {
  return JSON.stringify(
    { mcpServers: { [MCP_ENTRY_NAME]: buildMcpEntry(client, url, token) } },
    null,
    2,
  );
}
