/**
 * MCP 一键接入的确认文案守卫。
 *
 * 钉的理由不是「有个纯函数顺手测一下」：这句话的**全部内容**就是「我到底要动你哪个
 * 文件的哪个键」。容器键写死成 `mcpServers` 时，OpenCode（`mcp`）、Codex（`mcp_servers`）、
 * ZCode（`mcp.servers`）的用户会看到一句关于我们根本不会去改的那个键的承诺——
 * 而写入照样成功，界面照样报「已接入」，没有任何东西会报错。
 *
 * 规则 #11.1：判据收在 `mcpContainerKeyOf` 一个函数里；这里验的是「文案与写入同源」，
 * 不是复述实现。
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MCP_CLIENTS,
  MCP_CONTAINER_KEY,
  MCP_ENTRY_NAME,
  MCP_EXE_SENTINEL,
  MCP_STDIO_ARGS,
  MCP_TOKEN_SENTINEL,
  canOneClick,
  isStdioClient,
  type McpClientDef,
} from "@/lib/mcpClients";
import type { McpClientProbe } from "@/lib/api/mcp";
import {
  connectConfirmText,
  copyMcpClientConfig,
  disconnectConfirmText,
  mcpContainerKeyOf,
  type McpToast,
} from "@/lib/mcpConnectActions";

const probe = (over: Partial<McpClientProbe> = {}): McpClientProbe =>
  ({
    path: "C:\\Users\\me\\.qoderwork\\mcp.json",
    exists: true,
    toolPresent: true,
    state: "none",
    ...over,
  }) as McpClientProbe;

const byId = (id: string): McpClientDef => {
  const c = MCP_CLIENTS.find((x) => x.id === id);
  if (!c) throw new Error(`名单里没有 ${id}——它被改名了，这条守卫也就失效了，去核对`);
  return c;
};

describe("确认框写的容器键 = 这个客户端真正的容器键", () => {
  it("四家各不相同的容器键都原样出现在文案里", () => {
    // 写死任何一家都会让另一家的承诺变成假话
    expect(mcpContainerKeyOf(byId("claude-code"))).toBe("mcpServers");
    expect(mcpContainerKeyOf(byId("opencode"))).toBe("mcp");
    expect(mcpContainerKeyOf(byId("codex"))).toBe("mcp_servers");
    expect(mcpContainerKeyOf(byId("zcode"))).toBe("mcp.servers");
  });

  it("每一家可一键的客户端：文案里写的键就是 mcpContainerKeyOf 算出来的那个", () => {
    for (const c of MCP_CLIENTS.filter(canOneClick)) {
      const key = mcpContainerKeyOf(c);
      const msg = connectConfirmText(c, probe()).message;
      // 容器键缺省时回落到 MCP_CONTAINER_KEY，两条都要能过
      expect(key, c.id).toBe(c.containerKey ?? MCP_CONTAINER_KEY);
      expect(msg.includes(`只添加/更新 ${key} 里名为`), c.id).toBe(true);
    }
  });

  it("点名了条目名与本机的绝对路径", () => {
    const p = probe({ path: "/home/me/.gemini/settings.json" });
    const msg = connectConfirmText(byId("gemini-cli"), p).message;
    expect(msg).toContain(`「${MCP_ENTRY_NAME}」`);
    expect(msg).toContain(p.path);
    expect(msg).toContain("备份");
  });

  it("文件不存在时多一句「会新建」，存在时不多这句", () => {
    const c = byId("qoder");
    expect(connectConfirmText(c, probe({ exists: false })).message).toContain("会新建");
    expect(connectConfirmText(c, probe({ exists: true })).message).not.toContain("会新建");
  });

  it("有 connectCaveat 的必须带那句警示，没有的不带空 ⚠", () => {
    const withCaveat = MCP_CLIENTS.find((c) => c.connectCaveat);
    expect(withCaveat, "名单里至少得有一家带 caveat，否则这条钉不住东西").toBeTruthy();
    expect(connectConfirmText(withCaveat!, probe()).message).toContain(
      `⚠ ${withCaveat!.connectCaveat}`,
    );
    const plain = MCP_CLIENTS.find((c) => !c.connectCaveat && canOneClick(c))!;
    expect(connectConfirmText(plain, probe()).message).not.toContain("⚠");
  });
});

describe("移除确认框", () => {
  it("说清删哪一条、哪个文件，并仍然承诺先备份", () => {
    const c = byId("opencode");
    const { title, message } = disconnectConfirmText(c, probe());
    expect(title).toContain(c.name);
    expect(message).toContain(`「${MCP_ENTRY_NAME}」`);
    expect(message).toContain(probe().path);
    expect(message).toContain("备份");
    expect(message).toContain("不再能访问");
  });
});

/**
 * 🔴 stdio 那一类（方案 ①）的确认承诺**不能提令牌**：它的条目里只有一个
 * `command` + 一个参数，桥跟主程序读同一个 DPAPI 文件，配置里根本没有令牌
 * 这个位置。沿用 http 那句「会把本机的访问令牌写进去」的话，用户会在自己的
 * 配置文件里找一个我们没写、也不该写的字段。
 */
describe("确认框对 stdio 客户端不承诺令牌", () => {
  const stdio = MCP_CLIENTS.find(isStdioClient)!;
  const http = MCP_CLIENTS.find((c) => !isStdioClient(c) && canOneClick(c))!;

  it("名单里确实有 stdio 客户端（否则这条守卫是空转）", () => {
    expect(stdio, "名单里一个 stdio 客户端都没有").toBeTruthy();
  });

  it("stdio：说清写的是程序路径与启动参数，且不出现「把令牌写进去」", () => {
    const msg = connectConfirmText(stdio, probe()).message;
    expect(msg).toContain("本程序的绝对路径");
    expect(msg).toContain(MCP_STDIO_ARGS[0]);
    expect(msg).toContain("不含访问令牌");
    expect(msg).not.toContain("会把本机的访问令牌写进去");
    // 容器键与条目名照旧要写——这两句是所有客户端共用的承诺
    expect(msg).toContain(`只添加/更新 ${mcpContainerKeyOf(stdio)} 里名为`);
    expect(msg).toContain(`「${MCP_ENTRY_NAME}」`);
  });

  it("http：仍然明说会写令牌，并点名是哪一家靠它访问笔记", () => {
    const msg = connectConfirmText(http, probe()).message;
    expect(msg).toContain(`会把本机的访问令牌写进去（${http.name}`);
    expect(msg).not.toContain(MCP_STDIO_ARGS[0]);
  });

  /**
   * 全表扫一遍：任何一家的承诺只能是这两句之一。
   * 新加客户端时忘了在 `writePromiseLine` 里分岔，会被这条抓到。
   */
  it("每一家的承诺行都与其传输方式一致", () => {
    for (const c of MCP_CLIENTS.filter(canOneClick)) {
      const msg = connectConfirmText(c, probe()).message;
      expect(msg.includes("会把本机的访问令牌写进去"), `${c.id} 承诺了令牌`).toBe(
        !isStdioClient(c),
      );
    }
  });
});

/**
 * 复制卡片：stdio 走的不是「取令牌 → 拼 → 复制」那条路。
 *
 * 🔴 两个必须钉住的行为：
 * 1. 读不到本程序路径时**什么都不复制**，只报错——把 `__PASTEPANDA_EXE__`
 *    复制出去的话，用户粘进客户端只会得到一句 `failed to start`，
 *    而那个记号只有后端换得掉，粘出去等于给了个坏配置；
 * 2. 全程不碰 `onNeedToken`——那是会把真令牌送到前端的一次机会，
 *    对一条不含令牌的条目纯属白白多送一次。
 */
describe("复制 stdio 卡片", () => {
  const stdio = MCP_CLIENTS.find(isStdioClient)!;
  const http = MCP_CLIENTS.find((c) => !isStdioClient(c) && canOneClick(c))!;
  const EXE = "C:\\Program Files\\PastePanda\\PastePanda.exe";

  /**
   * 造一个能记录内容的假剪贴板。
   *
   * 必须用 `vi.stubGlobal` 而不是 `Object.defineProperty(navigator, …)`：本文件跑在
   * node 环境下（见 vitest.config.ts 的 projects），而 `navigator` 是 **Node 21+ 才有的
   * 全局**——本机 Node 24 摸得到、CI 的 Node 20 直接 `ReferenceError: navigator is not
   * defined`（2026-10-09 CI 实测，三条用例连片红）。stubGlobal 是「没有就造一个」，
   * 两边都成立。
   */
  function fakeClipboard(writeText: (t: string) => Promise<void>) {
    vi.stubGlobal("navigator", { clipboard: { writeText } });
  }

  it("stdio：复制出去的是路径 + 参数，且一个令牌都没有", async () => {
    const copied: string[] = [];
    fakeClipboard(async (t) => void copied.push(t));
    const seen: string[] = [];
    const toast: McpToast = (m) => seen.push(m);
    await copyMcpClientConfig(
      stdio,
      {
        copyUrl: "http://127.0.0.1:8765/mcp",
        stdioCommand: EXE,
        onNeedToken: async () => {
          seen.push("不该被调用");
          return "SECRET";
        },
        lanOn: false,
        copyMode: "local",
      },
      toast,
    );
    expect(copied.length, "一次都没复制").toBe(1);
    // 卡片是 JSON，反斜杠在文本里是转义过的——要比就比解析出来的值
    const json = JSON.parse(copied[0]) as {
      mcpServers: Record<string, { command?: string; args?: string[] }>;
    };
    expect(json.mcpServers[MCP_ENTRY_NAME].command).toBe(EXE);
    expect(json.mcpServers[MCP_ENTRY_NAME].args).toEqual(MCP_STDIO_ARGS);
    // 整条就只有这两个键：多一个 `url`/`headers`，stdio 客户端会把整条丢掉
    expect(Object.keys(json.mcpServers[MCP_ENTRY_NAME]).sort()).toEqual([
      "args",
      "command",
    ]);
    expect(copied[0]).toContain(MCP_STDIO_ARGS[0]);
    expect(copied[0], "复制出去的内容带 URL").not.toContain("8765");
    expect(copied[0], "复制出去的内容残留了占位符").not.toContain(MCP_EXE_SENTINEL);
    expect(copied[0]).not.toContain(MCP_TOKEN_SENTINEL);
    expect(copied[0]).not.toContain("SECRET");
    expect(seen, "stdio 这条路去取令牌了").not.toContain("不该被调用");
    expect(seen.join()).toContain("不含令牌");
  });

  it("stdio：读不到程序路径 → 不复制、不取令牌、给出原因", async () => {
    const writeText = vi.fn(async () => {});
    fakeClipboard(writeText);
    const seen: string[] = [];
    const toast: McpToast = (m) => seen.push(m);
    let needTokenCalls = 0;
    await copyMcpClientConfig(
      stdio,
      {
        copyUrl: "http://127.0.0.1:8765/mcp",
        stdioCommand: null,
        onNeedToken: async () => {
          needTokenCalls++;
          return "SECRET";
        },
        lanOn: false,
        copyMode: "local",
      },
      toast,
    );
    expect(writeText, "路径未知却复制了东西").not.toHaveBeenCalled();
    expect(needTokenCalls, "stdio 不该去取令牌").toBe(0);
    expect(seen.join()).toContain("读不到本程序路径");
  });

  /** 反面守卫：http 那条路必须照旧取令牌，否则这条复制是空的。 */
  it("http：照旧取真令牌并复制", async () => {
    const copied: string[] = [];
    fakeClipboard(async (t) => void copied.push(t));
    const seen: string[] = [];
    await copyMcpClientConfig(
      http,
      {
        copyUrl: "http://127.0.0.1:8765/mcp",
        stdioCommand: null,
        onNeedToken: async () => "SECRET",
        lanOn: false,
        copyMode: "local",
      },
      (m) => seen.push(m),
    );
    expect(copied[0]).toContain("SECRET");
    expect(copied[0], "屏幕上该有的占位符被复制了").not.toContain(MCP_TOKEN_SENTINEL);
    expect(seen.join()).toContain("含令牌");
  });
});

/**
 * 收口检查：确认框只能从 `lib/mcpConnectActions` 弹。
 * 面板里再出现一个 `confirmDialog(` 就意味着有人又写了一份文案——上面那些守卫
 * 会全部看不到它（第 7 个调用点还是走错，正是规则 #11.1 的判据）。
 */
describe("写入确认已收口到一个模块", () => {
  const src = readFileSync(
    join(process.cwd(), "src", "components", "settings", "McpConnectPanel.tsx"),
    "utf8",
  );
  it("McpConnectPanel 不再自己拼确认框", () => {
    expect(src).not.toContain("confirmDialog(");
    expect(src).toContain("connectMcpClient");
    expect(src).toContain("disconnectMcpClient");
  });
});
