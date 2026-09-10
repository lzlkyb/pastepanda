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

/**
 * 配置文件的格式。不写就是 `json`。
 *
 * 🔴 Codex 是 `toml`。它影响的**不只是一键写入**，还有屏幕上的复制卡片：
 * 给一个 TOML 客户端发一张 JSON 卡片，跟下面记的 Claude Desktop 是同一类伤害——
 * 用户照着粘进去，得到的是一份解不开的 `config.toml`。
 */
export type McpConfigFormat = "json" | "toml";

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
  /** 配置文件格式。不写 = `json`。后端按**扩展名**自己再判一次。 */
  format?: McpConfigFormat;
  /**
   * 这个工具自己的目录（如 `~/.zcode`），只用来做「本机装没装」的分组判断。
   * **后端只对它做存在性检查，从不写它。**
   *
   * 🔴 不写的话就退化成拿「MCP 配置文件在不在」充数，而那会把
   * 「装了但从没配过 MCP」误判成没装——那恰恰是一键接入最有用的一类
   * （本机就有现成例子：`~/.zcode/` 在、`~/.zcode/cli/config.json` 不在）。
   */
  detectPath?: string;
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
   * 用于那些「改了会有额外后果」的客户端，目前两类：
   *   ① 它自己也会改这个文件（运行期间拿内存旧快照整份写回去，把我们刚写的盖掉）
   *   ② 我们这一写会**改变它对其他配置文件的取舍**（ZCode 的 `.agents` 降级链）
   *
   * 两类共同点：用户不知情就会莫名其妙地少东西，而且不报错。
   */
  connectCaveat?: string;
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
    detectPath: "~/.claude",
    transport: "http",
    where: "写进该文件**顶层**的 mcpServers（不是某个 project 下面）。",
    cli: (url, token) =>
      `claude mcp add --transport http --scope user pastepanda ${url} \\\n  --header "Authorization: Bearer ${token}"`,
    cliNote:
      "❗ `--scope user` 不能省。`claude mcp add` 的默认 scope 是 `local`，" +
      "而 local 只对**执行命令时那一个目录**生效。知识库跟项目无关，" +
      "在别的目录开 Claude Code 就没这个工具——而且不报错，最难查的那种。",
    connectCaveat:
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
    detectPath: "~/.workbuddy",
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
    detectPath: "~/.qoderwork",
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
    detectPath: "~/.codebuddy",
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
    detectPath: "~/.gemini",
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
    detectPath: "~/.config/opencode",
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
    id: "codex",
    name: "Codex CLI",
    configPath: "~/.codex/config.toml",
    detectPath: "~/.codex",
    /**
     * 🔴 全表里**唯一一个不是 JSON 的**。
     *
     * 它同时决定了屏幕上的复制卡片要渲染成 TOML：给它一张 JSON 卡片，
     * 用户粘进 `config.toml` 后 Codex 连配置都读不开了——比不给还糟。
     */
    format: "toml",
    containerKey: "mcp_servers",
    /**
     * 条目里**没有 `type`**：Codex 跟 Gemini CLI 一样靠字段名选传输——
     * 有 `command` 就是 stdio，有 `url` 就是 StreamableHTTP。
     * `transport` 仍填 `streamableHttp`，记的是“实际走哪种”。
     */
    transport: "streamableHttp",
    omitType: true,
    headersField: "http_headers",
    where: "写进该文件的 [mcp_servers]。❗ 它是 **TOML**，不是 JSON。",
    evidence:
      "路径：本机 `~/.codex/config.toml` 实测存在，里面就是 `[mcp_servers.…]` 子表（2026-09-10 扫描）。" +
      "格式：直读 openai/codex 源码 `codex-rs/config/src/mcp_types.rs`（main 分支，2026-09-10 拉取）核实——" +
      "`McpServerTransportConfig` 是 `#[serde(untagged)]`，**靠字段选传输**：" +
      "有 `command` 走 stdio、有 `url` 走 StreamableHttp，**整个条目没有 `type` 字段**；" +
      "静态请求头的字段名叫 `http_headers`（`HashMap<String, String>`，写字面量合法）。" +
      "❗ 另有 `bearer_token_env_var`，但那要求令牌放在**环境变量**里，我们给不了；" +
      "也因此**没给命令行**：`codex mcp add`（`codex-rs/cli/src/mcp_cmd.rs`）只有 " +
      "`--bearer-token-env-var`，没有 `--header`，写不出字面量令牌。",
  },
  {
    id: "qwen-code",
    name: "Qwen Code（通义千问）",
    configPath: "~/.qwen/settings.json",
    detectPath: "~/.qwen",
    /**
     * ❗ 跟 Gemini CLI 一模一样（它就是 gemini-cli 的分支）：
     * 不写 `type`，URL 走 `httpUrl`。写成 `url` 会被当成 **SSE** 去连——
     * 不报错，只是连不上。
     */
    transport: "streamableHttp",
    omitType: true,
    urlField: "httpUrl",
    where: "写进该文件的 mcpServers。",
    evidence:
      "直读官方文档 QwenLM/qwen-code 的 `docs/users/features/mcp.md`（2026-09-10 查）：" +
      "用户级配置是 `~/.qwen/settings.json`（原文：User scope (default)），容器键 `mcpServers`；" +
      "远程 streamable HTTP 示例为 `httpUrl` + `headers.Authorization: Bearer`，" +
      "**整个条目没有 `type`**；文档明写 `url` 是给 SSE 用的。" +
      "❗ 该文件装的是 Qwen Code 的**全部设置**，不只 MCP，所以只能合并不能覆盖（同 `~/.gemini/settings.json`）。",
  },
  {
    id: "zcode",
    name: "ZCode（智谱）",
    configPath: "~/.zcode/cli/config.json",
    detectPath: "~/.zcode",
    /**
     * 🔴 全表里**唯一一个容器不在顶层的**：服务器装在 `mcp` 下面的 `servers` 里。
     * 带点号 = 嵌套路径（后端 `mcp_connect.rs` 会拆）。
     * 写成顶层一个叫 `"mcp.servers"` 的键的话，界面显示接入成功而 ZCode 一个字读不到。
     */
    containerKey: "mcp.servers",
    transport: "http",
    where: "写进该文件的 **mcp.servers**（注意是嵌在 mcp 下面的 servers，不是顶层一个键）。",
    connectCaveat:
      "ZCode 还支持一个降级配置 `~/.agents/mcp.json`，但它**只在 " +
      "`~/.zcode/cli/config.json` 里一个 MCP 服务器都没有时才生效**。" +
      "所以你现在的 MCP 服务器如果全写在 `~/.agents/mcp.json` 里，" +
      "这次接入会让它们全部失效——ZCode 不会报错，只是那些工具没了。" +
      "那种情况请改用上面的「复制配置」，把这一条也粘进 `~/.agents/mcp.json`。",
    evidence:
      "路径与键名：ZCode 自带的官方插件技能 `zcode-guide/…/skills/diagnosing-mcp/SKILL.md` " +
      "（本机 `~/.zcode/cli/plugins/cache/zcode-plugins-official/` 下，2026-09-10 实读）逐字写明：" +
      "User 作用域配置是 `~/.zcode/cli/config.json`，键路径是 **`mcp.servers`**（不是顶层 `mcpServers`）。" +
      "transport：同一份文档——`http` / `sse` 需要 `url`，可选 `headers` / `enabled` / `timeoutMs`；" +
      "`type` 省略时按字段推断（有 `url` 即 `http`）。" +
      "❗ 它明确说 **schema 是严格的、多一个键就会被静静丢掉**（pitfall 5），" +
      "所以这里只出 `type` / `url` / `headers` 三个字段，不加 `enabled`。" +
      "❗ 文档还说 `type: \"remote\"` 与 `http_headers` 属于会被 CLI 自动迁移的**旧写法**，" +
      "而桌面端那条路可能绕过迁移，所以用规范写法 `type: \"http\"` + `headers`。",
  },
  {
    id: "pi",
    name: "Pi",
    configPath: "~/.pi/agent/mcp.json",
    detectPath: "~/.pi",
    /**
     * 条目里**没有 `type`**：Pi 靠 `command` / `url` / `socket` 区分传输。
     * `transport` 仍填 `streamableHttp`，记的是“实际走哪种”。
     */
    transport: "streamableHttp",
    omitType: true,
    where: "写进该文件的 mcpServers。",
    connectCaveat:
      "🔴 MCP **不是 Pi 自带的能力**：要先在 Pi 里跑 `pi install npm:pi-mcp-adapter`，" +
      "否则这份配置写进去也没人读——而且不会报错，只是工具不出现。",
    evidence:
      "路径：官方 pi.dev/packages/pi-mcp-adapter（2026-09-10 查）列了 6 个配置位置并写明 " +
      "**Precedence is (later entries win)**。`~/.pi/agent/mcp.json`（原文：" +
      "`<Pi agent dir>/mcp.json` — Pi global override，默认 `~/.pi/agent/mcp.json`，" +
      "可用 `$PI_CODING_AGENT_DIR` 改）排在三个全局共享文件（`~/.config/mcp/mcp.json`、" +
      "`~/.agents/mcp.json`、`~/.agents/mcp/mcp.json`）**之后**，所以写它能压过那三个；" +
      "再往后只剩项目级文件，而项目级我们本来就不写（令牌会跟着进 git）。" +
      "容器键 `mcpServers`；远程条目是 `url` + `headers`，**没有 `type` / `transport` 字段**。" +
      "⚠ 它另有 `auth: \"bearer\"` 一路（配 `bearerToken` / `bearerTokenEnv` / `bearerTokenStore`）；" +
      "这里不写 `auth`、只走纯 `headers`——文档说 headers 会照发，且这跟本表其余各家一致。" +
      "真出现 401 先回来看这一条。",
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
  "transport" | "extra" | "urlField" | "headersField" | "omitType" | "containerKey" | "format"
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

/** TOML 裸键（bare key）的字符集；不在这个范围里的得加引号。 */
const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

function tomlKey(k: string): string {
  return TOML_BARE_KEY.test(k) ? k : JSON.stringify(k);
}

/**
 * TOML 值的字面量。
 *
 * 嵌套对象写成**行内表**，跟后端 `mcp_connect.rs` 一键写入时的写法保持一致——
 * 屏幕上看到的和实际写进去的得是同一个东西。
 *
 * ❗ 碰到 TOML 表示不了的值直接抛（规则 #15.3）：宁可让测试当场挂，
 *   也不能静静地给用户一张粘进去就坏的卡片。`mcpClients.test.ts` 里有一条
 *   把整张名单都渲染一遍，所以真有这种值会在构建时就被拦下。
 */
function tomlValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  if (v !== null && typeof v === "object") {
    const inner = Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`)
      .join(", ");
    return `{ ${inner} }`;
  }
  throw new Error(`TOML 表示不了这个值：${String(v)}`);
}

/**
 * 生成可直接粘贴的完整配置片段（带外层容器键）。
 *
 * 🔴 **格式跟着客户端走**：Codex 是 TOML，其余是 JSON。
 * 一律出 JSON 的话，Codex 用户照着粘完，`config.toml` 就解不开了。
 *
 * 容器键同样跟着客户端走（OpenCode 是 `mcp`、Codex 是 `mcp_servers`）——
 * 手动粘贴那条路不能把一键接入修好的坑又踩一遍。
 */
export function buildMcpConfigSnippet(
  client: McpEntryShape,
  url: string,
  token: string,
): string {
  // 🔴 带点号的容器键 = 嵌套路径（ZCode 的 `mcp.servers`）。
  //    不拆的话，卡片会吐出一个字面量叫 `"mcp.servers"` 的键——
  //    而那正是后端刚修掉的那个坑：手动粘贴这条路不能把它又踩一遍。
  const segs = (client.containerKey ?? MCP_CONTAINER_KEY).split(".");
  const entry = buildMcpEntry(client, url, token);

  if (client.format === "toml") {
    // TOML 的表头本来就用点号表示嵌套，逐段转义后拼起来即可。
    const header = [...segs, MCP_ENTRY_NAME].map(tomlKey).join(".");
    const lines = [`[${header}]`];
    for (const [k, v] of Object.entries(entry)) {
      lines.push(`${tomlKey(k)} = ${tomlValue(v)}`);
    }
    return lines.join("\n");
  }

  // 从里往外包：{pastepanda: entry} → {servers: …} → {mcp: …}
  let node: Record<string, unknown> = { [MCP_ENTRY_NAME]: entry };
  for (const seg of [...segs].reverse()) node = { [seg]: node };
  return JSON.stringify(node, null, 2);
}
