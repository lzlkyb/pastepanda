/**
 * mcpClients 的契约测试。
 *
 * # 🔴 重点是跨语言那几个常量
 *
 * `MCP_ENTRY_NAME`、`MCP_TOKEN_SENTINEL`、`MCP_EXE_SENTINEL` 与参数标志
 * 在 TS 和 Rust 里各写了一份
 * （Rust 那份是故意写死的：这样无论前端怎么错，「移除接入」也只删得掉
 * 我们自己那一条）。**没有任何编译器在看着这两边是否一致**，而改就一边的后果是：
 *   · 改错 `MCP_ENTRY_NAME` → 探测永远报「未接入」，而每次接入都往用户配置里多写一条
 *   · 改错 `MCP_TOKEN_SENTINEL` → 后端找不到占位符，接入直接失败
 *   · 改错 `MCP_EXE_SENTINEL` → 同上，不过挨打的是 stdio 那一类条目
 *   · 改错参数标志 → 配置写成功了，而那个子进程根本不是桥，客户端只看到启动失败
 * 都不会在构建期暴露。所以这里直接读 Rust 源码比对。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MCP_CLIENTS,
  MCP_CONTAINER_KEY,
  MCP_ENTRY_NAME,
  MCP_TOKEN_SENTINEL,
  MCP_EXE_SENTINEL,
  MCP_STDIO_ARGS,
  MCP_TRANSPORTS,
  buildMcpEntry,
  buildMcpEntryForConnect,
  buildMcpConfigSnippet,
  canOneClick,
  isStdioClient,
  stdioBridgeNote,
  type StdioBridgeState,
} from "./mcpClients";

const RUST_SRC = readFileSync(
  resolve(__dirname, "../../src-tauri/src/commands/mcp_connect.rs"),
  "utf-8",
);

/**
 * 参数标志的权威定义在桥那一侧（`main` 里比对的就是它），
 * 所以这份守卫必须读 `stdio.rs` 而不是 `mcp_connect.rs`。
 */
const STDIO_SRC = readFileSync(
  resolve(__dirname, "../../src-tauri/src/mcp/stdio.rs"),
  "utf-8",
);

/** 从 Rust 源码里抽一个 `const NAME: &str = "value";` 的值。 */
function rustConst(name: string, src: string = RUST_SRC): string {
  const m = src.match(new RegExp(`const ${name}: &str = "([^"]*)"`));
  if (!m) throw new Error(`Rust 里找不到常量 ${name}——是不是被重命名了？`);
  return m[1];
}

/** 名单里 stdio 那一类（方案 ①：目前只有 Claude Desktop）。 */
const STDIO_CLIENTS = MCP_CLIENTS.filter(isStdioClient);
const HTTP_CLIENTS = MCP_CLIENTS.filter((c) => !isStdioClient(c));

describe("TS 与 Rust 的跨语言契约", () => {
  it("条目名两边必须逐字相同", () => {
    expect(MCP_ENTRY_NAME).toBe(rustConst("MCP_ENTRY_NAME"));
  });

  it("令牌占位符两边必须逐字相同", () => {
    expect(MCP_TOKEN_SENTINEL).toBe(rustConst("TOKEN_SENTINEL"));
  });

  /**
   * 🔴 默认容器键也是两边各写一份。前端不传 `containerKey` 时后端用它那份，
   * 两边分岔的后果是：写进去的键与探测/移除看的键不是同一个——
   * 接入成功却永远显示未接入，而用户每点一次接入就多一份备份文件。
   */
  it("默认容器键两边必须逐字相同", () => {
    expect(MCP_CONTAINER_KEY).toBe(rustConst("DEFAULT_CONTAINER"));
  });

  /**
   * 🔴 stdio 条目换的是**程序路径**而不是令牌，两边同样各写一份记号。
   * 只改一边的表现：后端一次都没换到占位符 → 报错中止，
   * 用户看到的是「一键接入失败」，而失败原因写的是一句关于占位符的话。
   */
  it("程序路径占位符两边必须逐字相同", () => {
    expect(MCP_EXE_SENTINEL).toBe(rustConst("EXE_SENTINEL"));
  });

  /**
   * 🔴 这条比上面几条更容易写错：前端往配置里塞的参数与主程序里拦截的那个
   * 标志必须是同一个字符串。不一致的话配置写入成功、探测也显示「已接入」，
   * 而客户端起的那个进程会当成普通启动——弹出一个主窗口，MCP 永远连不上。
   */
  it("stdio 启动参数两边必须逐字相同", () => {
    expect(MCP_STDIO_ARGS[0]).toBe(rustConst("ARG_FLAG", STDIO_SRC));
  });

  /** 两种记号不能撞车：后端按「换到了几次」判断条目是否可写，撞了会算错。 */
  it("令牌占位符与程序路径占位符不能相同", () => {
    expect(MCP_EXE_SENTINEL).not.toBe(MCP_TOKEN_SENTINEL);
  });
});

describe("条目拼装", () => {
  const url = "http://127.0.0.1:8765/mcp";

  /**
   * 后端在条目里一次都没换到占位符时会直接报错并中止，
   * 所以这条一旦挂了，表现就是「所有一键接入全部失败」。
   *
   * 🔴 两种条目换的是**不同**的占位符，不能拿一句话套全表：
   * http 类要的是令牌，stdio 类要的是本程序路径。写成「所有条目都得含
   * `MCP_TOKEN_SENTINEL`」的话，加一家 stdio 客户端就会全红——
   * 而那条红会让人误以为是接入坏了，其实坏的是断言。
   */
  it("一键接入的条目里必须带着占位符", () => {
    for (const c of HTTP_CLIENTS) {
      const entry = JSON.stringify(buildMcpEntryForConnect(c, url));
      expect(entry, `${c.id} 的条目里没有令牌占位符`).toContain(MCP_TOKEN_SENTINEL);
    }
    for (const c of STDIO_CLIENTS) {
      const entry = JSON.stringify(buildMcpEntryForConnect(c, url));
      expect(entry, `${c.id} 的条目里没有程序路径占位符`).toContain(MCP_EXE_SENTINEL);
      // 🔴 反过来也得钉：stdio 条目里出现令牌是假的——桥跟主程序读同一个
      //   DPAPI 文件，配置里根本没有令牌这个位置。
      expect(entry, `${c.id} 的 stdio 条目里不该有令牌`).not.toContain(MCP_TOKEN_SENTINEL);
    }
    expect(STDIO_CLIENTS.length, "名单里一个 stdio 客户端都没有").toBeGreaterThan(0);
  });

  /**
   * 🔴 stdio 的整份条目里既没有 URL 也没有令牌，只有 `command` + `args`。
   * 多带一个 `url` 的后果不是报错，是**整条被丢掉**（Claude Desktop 只吃 stdio）。
   */
  it("stdio 条目只有 command 与 args", () => {
    for (const c of STDIO_CLIENTS) {
      const entry = buildMcpEntryForConnect(c, url) as Record<string, unknown>;
      expect(Object.keys(entry).sort(), `${c.id} 的 stdio 条目字段不对`).toEqual([
        "args",
        "command",
      ]);
      expect(entry.command).toBe(MCP_EXE_SENTINEL);
      expect(entry.args).toEqual(MCP_STDIO_ARGS);
      for (const banned of ["url", "httpUrl", "headers", "type"]) {
        expect(entry[banned], `${c.id} 的 stdio 条目写了 ${banned}`).toBeUndefined();
      }
    }
  });

  /** 卡片给人看的是真路径，不是换不掉的记号。 */
  it("stdio 卡片带真程序路径，不残留占位符", () => {
    const c = STDIO_CLIENTS[0];
    const exe = "C:/Program Files/PastePanda/PastePanda.exe";
    const text = buildMcpConfigSnippet(c, "", "", exe);
    expect(text).toContain(exe);
    expect(text).not.toContain(MCP_EXE_SENTINEL);
    expect(text).not.toContain(MCP_TOKEN_SENTINEL);
  });

  it("令牌放在 Authorization 头里，不在 URL 里", () => {
    // 🔴 曾经明确否决过 `?token=` 查询参数：URL 里的令牌会进日志 /
    //   进进程列表 / 进崩溃报告，而这把令牌能读写全部笔记。
    const entry = buildMcpEntry({ transport: "http" }, url, "SECRET") as {
      url: string;
      headers: Record<string, string>;
    };
    expect(entry.url).toBe(url);
    expect(entry.url).not.toContain("SECRET");
    expect(entry.headers.Authorization).toBe("Bearer SECRET");
  });

  it("各家的 extra 字段不能丢", () => {
    // WorkBuddy 要 timeout / disabled（依据是它自带连接器的写法）
    const wb = MCP_CLIENTS.find((c) => c.id === "workbuddy")!;
    const entry = buildMcpEntry(wb, url, "t") as Record<string, unknown>;
    expect(entry.timeout).toBe(30000);
    expect(entry.disabled).toBe(false);
    expect(entry.type).toBe("streamableHttp");
  });

  /**
   * 🔴 Gemini CLI 是全表里唯一不写 `type` 的，而且它**靠字段名选传输**：
   * `httpUrl`→StreamableHTTP、`url`→SSE、`command`→Stdio。
   * 把 URL 写成 `url` 的话它会按 SSE 去连——**不报错，只是连不上**，
   * 正是这个注册表要防的那类错。
   */
  it("Gemini CLI：不写 type，URL 走 httpUrl", () => {
    const g = MCP_CLIENTS.find((c) => c.id === "gemini-cli")!;
    const entry = buildMcpEntry(g, url, "t") as Record<string, unknown>;
    expect(entry.type, "Gemini CLI 的条目不该有 type").toBeUndefined();
    expect(entry.httpUrl).toBe(url);
    expect(entry.url, "写成 url 会被当成 SSE").toBeUndefined();
    expect((entry.headers as Record<string, string>).Authorization).toBe("Bearer t");
  });

  it("每一条都得把 URL 真的写进条目里（字段名可以不同）", () => {
    // `urlField` 写错一个字母，条目里就没有地址了——而那同样不会报错。
    // ❗ stdio 类不在其中：它压根没有 URL（见上面那条字段守卫）。
    for (const c of HTTP_CLIENTS) {
      const entry = buildMcpEntryForConnect(c, url);
      expect(JSON.stringify(entry), `${c.id} 的条目里没有 URL`).toContain(url);
    }
  });

  it("完整 JSON 包着 mcpServers 且用统一的条目名", () => {
    const json = JSON.parse(buildMcpConfigSnippet({ transport: "sse" }, url, "t"));
    expect(Object.keys(json)).toEqual(["mcpServers"]);
    expect(Object.keys(json.mcpServers)).toEqual([MCP_ENTRY_NAME]);
  });

  /**
   * 🔴 Codex 跟 Gemini CLI 一样靠字段名选传输（有 `url` 就是 StreamableHTTP），
   * 而它的静态请求头叫 `http_headers` 而不是 `headers`。
   * 依据是它自己的源码 `codex-rs/config/src/mcp_types.rs`（见注册表的 evidence）。
   */
  it("Codex：不写 type，请求头叫 http_headers", () => {
    const cx = MCP_CLIENTS.find((c) => c.id === "codex")!;
    const entry = buildMcpEntry(cx, url, "t") as Record<string, unknown>;
    expect(entry.type, "Codex 的条目不该有 type").toBeUndefined();
    expect(entry.url).toBe(url);
    expect(entry.headers, "写成 headers 它不认").toBeUndefined();
    expect((entry.http_headers as Record<string, string>).Authorization).toBe("Bearer t");
  });

  /**
   * 🔴 给一个 TOML 客户端发 JSON 卡片，跟给 Claude Desktop 发 JSON 是同一类伤害：
   * 用户照着粘进 `config.toml`，Codex 连配置都读不开了——比不给还糟。
   */
  it("Codex 的复制卡片是 TOML，不是 JSON", () => {
    const cx = MCP_CLIENTS.find((c) => c.id === "codex")!;
    const text = buildMcpConfigSnippet(cx, url, "tok");
    expect(text).toContain(`[mcp_servers.${MCP_ENTRY_NAME}]`);
    expect(text).toContain(`url = "${url}"`);
    expect(text).toContain('http_headers = { Authorization = "Bearer tok" }');
    // 一眼能认出不是 JSON：没有那个外层大括号
    expect(text.trimStart().startsWith("{"), "出成了 JSON").toBe(false);
  });

  /**
   * 🔴 `format` 跟 `configPath` 的后缀必须对得上：
   * 后端 `mcp_connect.rs` 是**按扩展名**决定走 JSON 还是 TOML 分支的。
   * 两边对不上的话，屏幕上的卡片与实际写进去的东西会是两种格式。
   */
  it("format 与配置文件后缀不能分岔", () => {
    for (const c of MCP_CLIENTS) {
      if (!c.configPath) continue;
      const isToml = c.configPath.toLowerCase().endsWith(".toml");
      expect(c.format === "toml", `${c.id} 的 format 与路径后缀对不上`).toBe(isToml);
    }
  });

  /**
   * 🔴 Qwen Code 是 gemini-cli 的分支：不写 `type`、URL 走 `httpUrl`。
   * 写成 `url` 会被当成 SSE 去连——不报错，只是连不上。
   */
  it("Qwen Code：不写 type，URL 走 httpUrl", () => {
    const q = MCP_CLIENTS.find((c) => c.id === "qwen-code")!;
    const entry = buildMcpEntry(q, url, "t") as Record<string, unknown>;
    expect(entry.type, "Qwen Code 的条目不该有 type").toBeUndefined();
    expect(entry.httpUrl).toBe(url);
    expect(entry.url, "写成 url 会被当成 SSE").toBeUndefined();
    expect((entry.headers as Record<string, string>).Authorization).toBe("Bearer t");
  });

  /**
   * 🔴 ZCode 的容器不在顶层，是 `mcp` 下面的 `servers`。
   * 卡片吐出一个字面量叫 `"mcp.servers"` 的键的话，用户粘进去也白粘——
   * ZCode 不报错，只是一个字读不到。
   */
  it("ZCode：容器键真的嵌套，不是一个带点的键名", () => {
    const z = MCP_CLIENTS.find((c) => c.id === "zcode")!;
    const json = JSON.parse(buildMcpConfigSnippet(z, url, "t"));
    expect(Object.keys(json)).toEqual(["mcp"]);
    expect(Object.keys(json.mcp)).toEqual(["servers"]);
    expect(json.mcp.servers[MCP_ENTRY_NAME].url).toBe(url);
    expect(json["mcp.servers"], "把点号当成键名了").toBeUndefined();
  });

  /**
   * 🔴 ZCode 的 schema 是**严格**的：多一个键，那条服务器就会被静静丢掉
   * （依据见注册表的 evidence）。所以它的条目只能有这三个字段。
   */
  it("ZCode 的条目不能多带字段", () => {
    const z = MCP_CLIENTS.find((c) => c.id === "zcode")!;
    const entry = buildMcpEntry(z, url, "t") as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(["headers", "type", "url"]);
    expect(entry.type).toBe("http");
  });

  /**
   * 🔴 Pi 靠字段区分传输，条目里没有 `type`。
   * 也不写 `auth`：那一路要配 `bearerToken` / `bearerTokenEnv` / `bearerTokenStore`，
   * 而我们给的是字面量请求头。
   */
  it("Pi：不写 type 与 auth，只出 url + headers", () => {
    const p = MCP_CLIENTS.find((c) => c.id === "pi")!;
    const entry = buildMcpEntry(p, url, "t") as Record<string, unknown>;
    expect(entry.type, "Pi 的条目不该有 type").toBeUndefined();
    expect(entry.auth, "写了 auth 它会去找一把我们没配的令牌").toBeUndefined();
    expect(entry.url).toBe(url);
    expect((entry.headers as Record<string, string>).Authorization).toBe("Bearer t");
  });

  /**
   * 🔴 「点号 = 嵌套」这个约定两边各实现了一份。前端拆而后端不拆（或反过来），
   * 结果就是复制卡片与一键写入落在两个不同的地方。
   */
  it("点号=嵌套 这个约定后端也实现了", () => {
    expect(RUST_SRC, "后端没有拆点号").toContain("container.split('.')");
  });

  /**
   * ❗ `tomlValue` 碰到表示不了的值会抛。卡片是在 React 渲染里算的，
   * 真抛了就是一片白屏——所以在这里把整张名单都渲染一遍，
   * 把“上线后白屏”提前成“构建时挂”。
   */
  it("每家都能渲染出卡片", () => {
    for (const c of MCP_CLIENTS) {
      expect(() => buildMcpConfigSnippet(c, url, "t"), `${c.id} 的卡片渲染抛了`).not.toThrow();
    }
  });

  /**
   * 🔴 OpenCode 的容器键是 `mcp`。写成 `mcpServers` 的后果不是报错，
   * 是往它的配置里凭空造一个它不认的键——显示接入成功，而它一个字读不到。
   * 复制卡片那条路同理，所以连 `buildMcpConfigSnippet` 一起钉。
   */
  it("OpenCode 用 mcp 容器键，且 type 是 remote", () => {
    const oc = MCP_CLIENTS.find((c) => c.id === "opencode")!;
    const json = JSON.parse(buildMcpConfigSnippet(oc, url, "t"));
    expect(Object.keys(json)).toEqual(["mcp"]);
    expect(json.mcp[MCP_ENTRY_NAME].type).toBe("remote");
    expect(json.mcp[MCP_ENTRY_NAME].url).toBe(url);
    expect(json.mcpServers, "不能顺手造一个 mcpServers").toBeUndefined();
  });
});

describe("注册表自身的约束", () => {
  it("每一条都必须带 evidence", () => {
    // 这个字段存在的意义就是“不凭记忆填 transport”——写错一个字不报错，
    // 只会让客户端静静地连不上。
    for (const c of MCP_CLIENTS) {
      expect(c.evidence.trim().length, `${c.id} 的 evidence 是空的`).toBeGreaterThan(0);
    }
  });

  it("不能一键的必须说清楚为什么", () => {
    // 否则用户只会觉得“为什么它没有按钮”
    for (const c of MCP_CLIENTS) {
      if (!canOneClick(c)) {
        expect(c.manualReason?.trim().length, `${c.id} 缺 manualReason`).toBeGreaterThan(0);
      }
    }
  });

  /**
   * 🔴 能一键的都必须有 `detectPath`，否则界面分组会退化成拿
   * 「MCP 配置文件在不在」充数——「装了但从没配过 MCP」就被误判成没装，
   * 而那恰恰是一键接入最有用的一类。
   */
  it("能一键的都得有 detectPath", () => {
    for (const c of MCP_CLIENTS) {
      if (!canOneClick(c)) continue;
      expect(c.detectPath?.trim().length, `${c.id} 缺 detectPath`).toBeGreaterThan(0);
    }
  });

  /**
   * `detectPath` 必须是 `configPath` 的前缀。它防的是打错字（如 `~/.zcodee`）
   * ——那不会报错，只会让这一行永远躺在折叠区里。
   *
   * ❗ 用「字符串前缀」而不是「路径祖先」：Claude Code 的检测目录 `~/.claude`
   *   跟它的配置 `~/.claude.json` 是兄弟不是父子。
   */
  it("detectPath 必须是 configPath 的前缀", () => {
    for (const c of MCP_CLIENTS) {
      if (!c.detectPath || !c.configPath) continue;
      expect(
        c.configPath.startsWith(c.detectPath),
        `${c.id}：${c.detectPath} 不像是 ${c.configPath} 的检测点`,
      ).toBe(true);
    }
  });

  it("id 不重复", () => {
    // id 是探测结果的字典键，重了就会两行共用一个状态
    const ids = MCP_CLIENTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * 自定义接入的下拉里选不到的写法，用户就无法手动配出来。
   *
   * 🔴 例外只有 `stdio`，而且它是**故意**不在下拉里的：自定义接入收的是
   *   地址 + 令牌，而 stdio 条目两个都没有，它要的是本程序的绝对路径——
   *   只有 Rust 侧的 `current_exe` 知道。用户手填填不出来，给他一个选项
   *   只会产出一条必然连不上的配置。
   */
  it("transport 选项覆盖内置客户端能手动配置的写法", () => {
    const options = new Set(MCP_TRANSPORTS.map((t) => t.value));
    for (const c of MCP_CLIENTS) {
      if (isStdioClient(c)) continue;
      expect(options.has(c.transport), `下拉里没有 ${c.transport}`).toBe(true);
    }
    expect(options.has("stdio"), "stdio 不该出现在自定义接入的下拉里").toBe(false);
  });
});

describe("给 AI 的自配置说明", () => {
  it("必须包含 URL、Bearer、完整 JSON 与「不要覆盖」约束", async () => {
    const { buildMcpAiSetupPrompt, buildGenericMcpJson } = await import("./mcpClients");
    const url = "http://10.203.5.48:17650/mcp";
    const token = "tok-abc-123";
    const p = buildMcpAiSetupPrompt(url, token);
    expect(p).toContain(url);
    expect(p).toContain(`Bearer ${token}`);
    expect(p).toContain(buildGenericMcpJson(url, token));
    expect(p).toContain(MCP_ENTRY_NAME);
    expect(p).toContain("不要覆盖");
    expect(p).toContain("备份");
  });
});

/**
 * 「stdio 那句实况」是这一轮补上的：后端 `mcp_stdio_status` 回了四个布尔，
 * 而前端原先**一个都没读**——于是卡片上只剩恒定文案「主程序得开着、服务也得开着」，
 * 用户没法判断自己现在这条能不能用（规则 #15.1：按钮和它的反馈要在同一层）。
 *
 * 每条断言只钉一句结论；判据的顺序（令牌排在服务前面）在 `stdioBridgeNote`
 * 的注释里有理由：没令牌时桥是**一起来就退出**，比端口文件缺了更致命。
 */
describe("stdioBridgeNote：把后端那四个布尔翻成一句人话", () => {
  const ok: StdioBridgeState = {
    command: "C:/app/PastePanda.exe",
    serviceRunning: true,
    endpointFound: true,
    tokenReady: true,
  };
  /** 状态齐全时逐格读，避免测试自己把 `command` 写成必填判据。 */
  const state = (over: Partial<StdioBridgeState> | null): StdioBridgeState | null =>
    over === null ? null : { ...ok, ...over };

  it("四格都正常就什么都不说", () => {
    expect(stdioBridgeNote(state({}))).toBeNull();
  });

  it("读不到状态时说的是「判断不了」，不是「没在跑」", () => {
    const n = stdioBridgeNote(null);
    expect(n).toContain("读不到");
    // 🔴 不能顺嘴断言服务没开：读失败时我们对它一无所知。
    expect(n).not.toContain("没开");
  });

  it("路径读不到那句和卡片缺失是同一个原因", () => {
    expect(stdioBridgeNote(state({ command: null }))).toContain("读不到本程序的路径");
  });

  it("没令牌排在没服务前面，且要说清桥会退出", () => {
    const n = stdioBridgeNote(
      state({ serviceRunning: false, endpointFound: false, tokenReady: false }),
    );
    expect(n).toContain("令牌");
    expect(n).toContain("退出");
  });

  it("🔴 服务在跑而端口文件不在：这一格必须单独成句", () => {
    const n = stdioBridgeNote(state({ endpointFound: false }));
    expect(n).toContain("端口文件");
    // 只说「服务没开」是假话——它开着，HTTP 那侧能用。
    expect(n).toContain("在跑");
    expect(n).not.toContain("现在没开");
  });

  it("服务停了而端口文件还留着旧的那份，不能只说「没开」", () => {
    const n = stdioBridgeNote(state({ serviceRunning: false }));
    expect(n).toContain("没开");
    expect(n).toContain("端口文件");
  });

  it("每条都要是结论 + 下一步，不能只报错", () => {
    const cases = [
      null,
      state({ command: null }),
      state({ tokenReady: false }),
      state({ serviceRunning: false, endpointFound: false }),
      state({ serviceRunning: false }),
      state({ endpointFound: false }),
    ];
    for (const s of cases) {
      const n = stdioBridgeNote(s);
      expect(n, "正常态不该有句子").not.toBeNull();
      expect(n!.length).toBeGreaterThan(12);
      expect(n, `这句没给下一步：${n}`).toMatch(/再开一次|先在设置里|退出|等着|判断不了|给不出来|开着/);
    }
  });
});


describe("Claude Desktop platform paths", () => {
  it("uses the native Mac path for both discovery and configuration", async () => {
    const { claudeDesktopPaths } = await import("./utils");
    expect(claudeDesktopPaths("MacIntel")).toEqual({
      detectPath: "~/Library/Application Support/Claude",
      configPath: "~/Library/Application Support/Claude/claude_desktop_config.json",
    });
    expect(claudeDesktopPaths("Win32").configPath).toBe("~/AppData/Roaming/Claude/claude_desktop_config.json");
  });
});
