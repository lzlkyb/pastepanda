/**
 * mcpClients 的契约测试。
 *
 * # 🔴 重点是跨语言那两个常量
 *
 * `MCP_ENTRY_NAME` 与 `MCP_TOKEN_SENTINEL` 在 TS 和 Rust 里各写了一份
 * （Rust 那份是故意写死的：这样无论前端怎么错，「移除接入」也只删得掉
 * 我们自己那一条）。**没有任何编译器在看着这两边是否一致**，而改就一边的后果是：
 *   · 改错 `MCP_ENTRY_NAME` → 探测永远报「未接入」，而每次接入都往用户配置里多写一条
 *   · 改错 `MCP_TOKEN_SENTINEL` → 后端找不到占位符，接入直接失败
 * 都不会在构建期暴露。所以这里直接读 Rust 源码比对。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MCP_CLIENTS,
  MCP_ENTRY_NAME,
  MCP_TOKEN_SENTINEL,
  MCP_TRANSPORTS,
  buildMcpEntry,
  buildMcpEntryForConnect,
  buildMcpConfigJson,
  canOneClick,
} from "./mcpClients";

const RUST_SRC = readFileSync(
  resolve(__dirname, "../../src-tauri/src/commands/mcp_connect.rs"),
  "utf-8",
);

/** 从 Rust 源码里抽一个 `const NAME: &str = "value";` 的值。 */
function rustConst(name: string): string {
  const m = RUST_SRC.match(new RegExp(`const ${name}: &str = "([^"]*)"`));
  if (!m) throw new Error(`Rust 里找不到常量 ${name}——是不是被重命名了？`);
  return m[1];
}

describe("TS 与 Rust 的跨语言契约", () => {
  it("条目名两边必须逐字相同", () => {
    expect(MCP_ENTRY_NAME).toBe(rustConst("MCP_ENTRY_NAME"));
  });

  it("令牌占位符两边必须逐字相同", () => {
    expect(MCP_TOKEN_SENTINEL).toBe(rustConst("TOKEN_SENTINEL"));
  });
});

describe("条目拼装", () => {
  const url = "http://127.0.0.1:8765/mcp";

  it("一键接入的条目里必须带着占位符", () => {
    // 后端在条目里一次都没换到占位符时会直接报错并中止，
    // 所以这条一旦挂了，表现就是「所有一键接入全部失败」。
    for (const c of MCP_CLIENTS) {
      const entry = buildMcpEntryForConnect(c, url);
      expect(JSON.stringify(entry)).toContain(MCP_TOKEN_SENTINEL);
    }
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

  it("完整 JSON 包着 mcpServers 且用统一的条目名", () => {
    const json = JSON.parse(buildMcpConfigJson({ transport: "sse" }, url, "t"));
    expect(Object.keys(json)).toEqual(["mcpServers"]);
    expect(Object.keys(json.mcpServers)).toEqual([MCP_ENTRY_NAME]);
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

  it("id 不重复", () => {
    // id 是探测结果的字典键，重了就会两行共用一个状态
    const ids = MCP_CLIENTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("transport 选项覆盖内置客户端用到的全部写法", () => {
    // 自定义接入的下拉里选不到的写法，用户就无法手动配出来
    const options = new Set(MCP_TRANSPORTS.map((t) => t.value));
    for (const c of MCP_CLIENTS) {
      expect(options.has(c.transport), `下拉里没有 ${c.transport}`).toBe(true);
    }
  });
});
