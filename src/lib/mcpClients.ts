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
export type McpTransport = "http" | "streamableHttp" | "streamable-http" | "sse" | "remote";

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
  // ❗ 它不在上面那份扫描统计里：OpenCode 自成一派，不区分 http/sse，
  //   只认 `remote` 这一个值（传输由它自己协商）。
  { value: "remote", hint: "OpenCode 专用（它只认这一个）" },
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
  /**
   * 条目里 URL 的字段名。默认 `url`。
   *
   * 🔴 Gemini CLI 用 `httpUrl`，而且它**靠字段名选传输方式**：
   *   `httpUrl` → StreamableHTTP、`url` → SSE、`command` → stdio。
   *   所以写错这个名字不是「少个别名」，是**选错了传输方式**。
   */
  urlField?: string;
  /**
   * headers 的字段名。默认 `headers`。
   *
   * Codex 的 TOML 用 `http_headers`（它自己源码里的注释：「DB中的统一规范使用 headers，
   * Codex TOML 使用 http_headers」）。
   */
  headersField?: string;
  /**
   * 不输出 `type` 字段。
   *
   * Gemini CLI 的条目**没有** `type`；多写一个不认识的字段至少是噪声，
   * 严格校验的客户端还可能直接报错。
   *
   * ❗ 即便不输出，`transport` 字段仍然要填：它记的是「这条实际走哪种传输」，
   *   自定义接入的下拉也靠它做覆盖性检查。
   */
  omitType?: boolean;
  /**
   * 装服务器的顶层键。默认 [`MCP_CONTAINER_KEY`]（`mcpServers`）。
   *
   * 🔴 OpenCode 用的是 `mcp`。写错的后果不是报错，是往它的配置里
   * **凭空造一个它不认的 `mcpServers`**——界面上显示接入成功，而 OpenCode 一个字读不到。
   */
  containerKey?: string;
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
 * 默认的容器键。
 *
 * ❗ 与后端 `commands/mcp_connect.rs` 的 `DEFAULT_CONTAINER` 必须一致：
 *   前端不传 `containerKey` 时后端就用它那份，两边分岔的话，
 *   “写进去的键”与“探测/移除看的键”不是同一个——接入成功但永远显示未接入。
 *   `mcpClients.test.ts` 直接读 Rust 源码比对这一点。
 */
export const MCP_CONTAINER_KEY = "mcpServers";

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
    id: "qoder",
    name: "Qoder",
    configPath: "~/.qoderwork/mcp.json",
    // 🔴 连字符写法，**不是** WorkBuddy 那个 `streamableHttp`。
    //    官方文档给的远程示例就是 `streamable-http`，写成驼峰不报错、只是连不上。
    transport: "streamable-http",
    where: "写进该文件的 mcpServers。",
    evidence:
      "路径：本机 `~/.qoderwork/mcp.json` 实测存在，顶层就是 `mcpServers`（2026-09-10 扫描）。" +
      "❗ 目录名是 `.qoderwork` 而不是 `.qoder`。" +
      "transport：官方文档 docs.qoder.com 的 MCP 页，远程服务示例为 " +
      "`\"type\": \"streamable-http\"` + `headers.Authorization: Bearer`（2026-09-10 查）。" +
      "⚠ 本机那一条现有条目是 stdio 型且带 `enabled` 字段；官方远程示例里没有这个字段，" +
      "所以这里不写——若以后发现 Qoder 不写 `enabled` 就不启用，再补 `extra`。",
  },
  {
    id: "codebuddy",
    name: "CodeBuddy",
    configPath: "~/.codebuddy/mcp.json",
    transport: "http",
    where: "写进该文件的 mcpServers。",
    evidence:
      "路径：本机 `~/.codebuddy/mcp.json` 实测存在，顶层是 `mcpServers`" +
      "（2026-09-10 扫描，当时里面是空的）。" +
      "transport：腾讯官方文档 codebuddy.cn/docs/cli/mcp 同时给了 `http` 与 `sse` 两种远程写法，" +
      "都是 `url` + `headers.Authorization: Bearer`（2026-09-10 查）。这里取 `http`（与 Claude Code 同档）。",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    configPath: "~/.gemini/settings.json",
    /**
     * 🔴 这一条是全表里**唯一不写 `type`** 的。
     *
     * Gemini CLI 在启动时按**字段名**选传输：
     *   `httpUrl` → StreamableHTTPClientTransport
     *   `url`     → SSEClientTransport
     *   `command` → StdioClientTransport
     * 所以这里把 URL 写成 `url` 的话，它会按 **SSE** 去连——不报错，只是连不上。
     * `transport` 仍填 `streamableHttp`，记的是“实际走哪种”。
     */
    transport: "streamableHttp",
    omitType: true,
    urlField: "httpUrl",
    where: "写进该文件的 mcpServers。",
    evidence:
      "官方文档（geminicli.com/docs/tools/mcp-server 与 google-gemini.github.io 的同名页，" +
      "2026-09-10 查）：全局配置在 `~/.gemini/settings.json`，容器键 `mcpServers`；" +
      "远程 HTTP 示例为 `httpUrl` + `headers.Authorization: Bearer`，**整个条目没有 `type` 字段**；" +
      "文档明写传输选择规则：httpUrl→StreamableHTTP、url→SSE、command→Stdio。" +
      "❗ 该文件装的是 Gemini CLI 的**全部设置**，不只 MCP，所以只能合并不能覆盖（同 `~/.claude.json`）。",
  },
  {
    id: "opencode",
    name: "OpenCode",
    configPath: "~/.config/opencode/opencode.json",
    /**
     * 🔴 OpenCode 两处都与别家不同：
     *   ① 容器键是 `mcp`，不是 `mcpServers`；
     *   ② `type` 只认 `"remote"`，不分 http / sse。
     */
    transport: "remote",
    containerKey: "mcp",
    // 文档示例里带着 `enabled: true`；写上比押它默认启用保险。
    extra: { enabled: true },
    where: "写进该文件的 **mcp**（注意不是 mcpServers）。",
    evidence:
      "官方文档 opencode.ai/docs/mcp-servers（2026-09-10 查）：全局配置在 " +
      "`~/.config/opencode/opencode.json`（❗ 不是 `~/.opencode/`）；" +
      "容器键是 **`mcp`**；远程服务器的 `type` **必须**是 `\"remote\"`（required），" +
      "配 `url` + 可选 `enabled` + 可选 `headers`（示例就是 `Authorization: Bearer`）。",
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
 * 🔴 调研过、**刻意不收**的客户端——写在这里免得下次又查一遍。
 *
 * ## Claude Desktop（2026-09-10 查证）
 *
 * 它的 `claude_desktop_config.json` **只认 stdio**：往里写带 `url` 的条目会被
 * **静默丢弃**，严重时启动即崩或加载出零个工具。远程 HTTP 服务只能走应用内的
 * 自定义连接器（Custom Connector），或用 `mcp-remote` 包一层 stdio 桥。
 *
 * ❗ 所以它不能当成「不能一键、给张复制卡片」那一类收进来：
 *   本文件生成的卡片就是一份 `mcpServers` JSON，而那份 JSON 粘进它的配置里
 *   **恰好是有害的那种**。给错的东西比什么都不给更糟。
 *   将来真要收，得先给注册表加一个「不出 JSON 卡片、只出文字说明」的能力。
 */

/**
 * 拼一条条目所需的最小信息。
 *
 * ❗ 故意比 `McpClientDef` 窄：**自定义接入**时用户只挑了一个 transport，
 *   没有 name / where / evidence 可填。要求传完整定义只会逼着调用方
 *   造一个假的 `evidence`——而那个字段存在的意义就是“不凭记忆填”。
 */
export type McpEntryShape = Pick<
  McpClientDef,
  "transport" | "extra" | "urlField" | "headersField" | "omitType" | "containerKey"
>;

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
  // 字段名默认值就是大多数客户端的写法；只有真不一样的那几家才在注册表里覆盖。
  return {
    ...(client.omitType ? {} : { type: client.transport }),
    [client.urlField ?? "url"]: url,
    [client.headersField ?? "headers"]: { Authorization: `Bearer ${token}` },
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
    {
      // 容器键跟着客户端走（OpenCode 是 `mcp`）——复制卡片也得是对的，
      // 否则手动粘贴的那条路会把一键接入修好的坑又踩一遍。
      [client.containerKey ?? MCP_CONTAINER_KEY]: {
        [MCP_ENTRY_NAME]: buildMcpEntry(client, url, token),
      },
    },
    null,
    2,
  );
}
