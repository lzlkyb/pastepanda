/**
 * McpClientRow 那张「抄走就能用」的卡片的守卫测试。
 *
 * 为什么值得单测：这张卡片是**给用户手抄**的，所以它的正确性判据不是
 * 「渲染没报错」，而是「抄出去能不能用」。三种坏画法都不抛异常：
 * · 画出 `__PASTEPANDA_EXE__` → Claude Desktop 一句 `failed to start`；
 * · 画出 `<读不到本程序路径>` → 看起来照样能抄，抄进去还是个假路径；
 * · 给 stdio 卡片配上令牌 → 用户去手加 `headers`，而那种条目根本没有这个键。
 * 规则 #15.1/15.3 在这里的落法就是：**给不出真值时整张不给，并说原因。**
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  MCP_CLIENTS,
  MCP_EXE_SENTINEL,
  MCP_STDIO_ARGS,
  isStdioClient,
  stdioBridgeNote,
} from "@/lib/mcpClients";
import type { McpClientProbe } from "@/lib/api/mcp";
import { McpClientRow, TOKEN_PLACEHOLDER } from "./McpClientRow";

const URL = "http://127.0.0.1:8765/mcp";
const EXE = "C:\\Program Files\\PastePanda\\PastePanda.exe";

const stdioClient = MCP_CLIENTS.find(isStdioClient)!;
const httpClient = MCP_CLIENTS.find((c) => !isStdioClient(c) && c.configPath)!;

/** 展开态的一行。收起时卡片根本不渲染，所以 `open` 一律给 true。 */
function renderRow(
  client: typeof stdioClient,
  stdioCommand: string | null,
  opts: { state?: McpClientProbe["state"]; note?: string | null } = {},
) {
  const probe: McpClientProbe = {
    path: "C:/fake/config.json",
    exists: true,
    toolPresent: true,
    state: opts.state ?? "none",
    detail: "",
  };
  const utils = render(
    <McpClientRow
      client={client}
      url={URL}
      open
      busy={false}
      probe={probe}
      stdioCommand={stdioCommand}
      stdioNote={opts.note ?? null}
      onToggle={vi.fn()}
      onCopyConfig={vi.fn()}
      onCopyCli={vi.fn()}
      onAction={vi.fn()}
    />,
  );
  return { ...utils, cards: () => Array.from(utils.container.querySelectorAll("pre")) };
}

describe("McpClientRow 的 stdio 卡片", () => {
  it("拿到真路径时卡片里就是那个路径，且一个占位符都不留", () => {
    const { cards } = renderRow(stdioClient, EXE);
    // stdio 那一行没有命令行块，卡片只该有一张。
    expect(cards()).toHaveLength(1);
    const text = cards()[0].textContent ?? "";
    expect(text).toContain(EXE.replace(/\\/g, "\\\\")); // JSON 里反斜杠是转义过的
    expect(text).toContain(MCP_STDIO_ARGS[0]);
    expect(text, "把占位符抄给用户了").not.toContain(MCP_EXE_SENTINEL);
    expect(text).not.toContain("你的访问令牌");
    expect(text).not.toContain("url");
  });

  it("🔴 读不到路径时整张卡片不给，那句原因贴着卡片的位置", () => {
    const { cards } = renderRow(stdioClient, null, {
      note: stdioBridgeNote({ command: null, serviceRunning: true, endpointFound: true, tokenReady: true }),
    });
    // 宁可空着：一张印着假路径的卡片看起来照样能抄。
    expect(cards()).toHaveLength(0);
    expect(screen.getByText(/读不到本程序的路径/)).toBeTruthy();
  });

  it("卡片正常时那句实况仍然显示（服务没开不代表卡片没意义）", () => {
    const { cards } = renderRow(stdioClient, EXE, {
      note: stdioBridgeNote({
        command: EXE,
        serviceRunning: false,
        endpointFound: false,
        tokenReady: true,
      }),
    });
    expect(cards()).toHaveLength(1);
    expect(screen.getByText(/现在没开/)).toBeTruthy();
  });

  it("路径读不到也不能谎报成「已接入」", () => {
    // 徽标走的是探测结果，跟卡片是两条独立信息；这里确认两者不互相掩盖。
    const { cards } = renderRow(stdioClient, null, { state: "current" });
    expect(screen.getByText("已接入")).toBeTruthy();
    expect(cards()).toHaveLength(0);
  });

  it("http 那张卡片照旧是地址 + 令牌占位符，实况那句不串台", () => {
    const { cards } = renderRow(httpClient, null, { note: "服务现在没开" });
    const text = cards().map((p) => p.textContent ?? "").join("\n");
    expect(text).toContain(URL);
    expect(text).toContain(TOKEN_PLACEHOLDER);
    expect(text).not.toContain(MCP_EXE_SENTINEL);
    // 🔴 那句实况是 stdio 桥的（令牌/端口文件那四个布尔），
    //   挂到 http 行上就是在对一个能直接连的东西说它连不上。
    expect(screen.queryByText(/服务现在没开/)).toBeNull();
  });
});
