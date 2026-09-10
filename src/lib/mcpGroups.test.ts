/**
 * 分组规则的测试。
 *
 * 🔴 这里每一条守的都是同一类事故：**本该露出来的行被折进了折叠区**。
 * 它不报错、不闪红，用户只会觉得「名单里怎么没有我这个工具」。
 */
import { describe, it, expect } from "vitest";
import { groupMcpClients, type ProbeForGrouping } from "./mcpGroups";
import { MCP_CLIENTS, canOneClick, type McpClientDef } from "./mcpClients";

// 分组只看 id，其余字段用不着。
const A = { id: "a" } as McpClientDef;
const B = { id: "b" } as McpClientDef;
const C = { id: "c" } as McpClientDef;

const probe = (p: Partial<ProbeForGrouping>): ProbeForGrouping => ({
  exists: false,
  toolPresent: false,
  state: "none",
  ...p,
});

describe("接入面板的分组", () => {
  it("已接入的单独一组", () => {
    const g = groupMcpClients([A, B], {
      a: probe({ exists: true, toolPresent: true, state: "current" }),
      b: probe({ exists: true, toolPresent: true, state: "none" }),
    });
    expect(g.connected.map((c) => c.id)).toEqual(["a"]);
    expect(g.present.map((c) => c.id)).toEqual(["b"]);
    expect(g.absent).toEqual([]);
  });

  /**
   * 🔴 这条是整个改动的由来：ZCode 装了（`~/.zcode/` 在）但从没配过 MCP
   * （`~/.zcode/cli/config.json` 不在）。按 `exists` 分组会把它折起来，
   * 而它恰恰是一键接入最有用的场景——接入会帮用户把文件建出来。
   */
  it("装了但从没配过 MCP 的，不能折起来", () => {
    const g = groupMcpClients([A], { a: probe({ exists: false, toolPresent: true }) });
    expect(g.present.map((c) => c.id)).toEqual(["a"]);
    expect(g.absent).toEqual([]);
  });

  it("本机没这个工具的才折起来", () => {
    const g = groupMcpClients([A], { a: probe({ exists: false, toolPresent: false }) });
    expect(g.absent.map((c) => c.id)).toEqual(["a"]);
    expect(g.present).toEqual([]);
  });

  /**
   * 🔴 兜底：注册表里的 `detectPath` 写错一个字母 → `toolPresent` 变 false，
   * 但配置文件明明就在。这种也绝不能藏起来。
   */
  it("detectPath 写错时，配置文件在就仍然要露出来", () => {
    const g = groupMcpClients([A], { a: probe({ exists: true, toolPresent: false }) });
    expect(g.present.map((c) => c.id)).toEqual(["a"]);
    expect(g.absent).toEqual([]);
  });

  it("stale 与 unreadable 不算已接入，但要留在检测到那组", () => {
    const g = groupMcpClients([A, B], {
      a: probe({ exists: true, toolPresent: true, state: "stale" }),
      b: probe({ exists: true, toolPresent: true, state: "unreadable" }),
    });
    expect(g.connected).toEqual([]);
    expect(g.present.map((c) => c.id)).toEqual(["a", "b"]);
  });

  /**
   * 首帧还没探完。全归到「检测到」组，探测回来后只有真没装的挪走——
   * 反过来（先全当没装）会让面板一打开先塌成一行再整个弹开。
   */
  it("还没探完时不能先当成没装", () => {
    const g = groupMcpClients([A, B, C], {});
    expect(g.probing).toBe(true);
    expect(g.present).toHaveLength(3);
    expect(g.absent).toEqual([]);
  });

  it("探测失败的也留在检测到那组", () => {
    // 探测失败 ≠ 没装。当没装处理的话，一次 IPC 抖动就能让一行凭空消失。
    const g = groupMcpClients([A], { a: null });
    expect(g.probing).toBe(false);
    expect(g.present.map((c) => c.id)).toEqual(["a"]);
  });

  it("分组不重不漏", () => {
    const list = MCP_CLIENTS.filter(canOneClick);
    const probes = Object.fromEntries(
      list.map((c, i) => [
        c.id,
        probe({
          exists: i % 2 === 0,
          toolPresent: i % 3 === 0,
          state: i === 0 ? "current" : "none",
        }),
      ]),
    );
    const g = groupMcpClients(list, probes);
    const all = [...g.connected, ...g.present, ...g.absent].map((c) => c.id);
    expect(all).toHaveLength(list.length);
    expect(new Set(all).size).toBe(list.length);
  });
});
