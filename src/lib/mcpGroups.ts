/**
 * mcpGroups.ts —— 接入面板的分组规则。
 *
 * 单独拎出来只为一件事：**它能被直接测**。
 * 这里判错了不会报错，只会让某一行悄悄跑到折叠区里去——
 * 而「本该露出来的行被折起来了」是没人会注意到的那种 bug。
 *
 * # 为什么要分组
 *
 * 内置名单已经十几家，而用户机器上只装一两个。一视同仁地铺平，
 * 真正要操作的那一两行就埋在十几行「未检测到配置文件」中间。
 */
import type { McpClientDef } from "./mcpClients";

/** 分组只用得着探测结果里的这三个字段。 */
export interface ProbeForGrouping {
  exists: boolean;
  toolPresent: boolean;
  state: string;
}

export interface McpGroups {
  /** 还没探完（首帧）。界面拿它决定组标题写什么。 */
  probing: boolean;
  /** 已接入且地址令牌都对。 */
  connected: McpClientDef[];
  /** 本机检测到了这个工具，但还没（正确）接入。 */
  present: McpClientDef[];
  /** 本机没检测到。默认折起来。 */
  absent: McpClientDef[];
}

/**
 * 把名单按「跟你有没有关系」分三组。
 *
 * ❗ 传进来的 `clients` 应该已经过滤成「能一键的」那些；
 *   只能手动配的那几家压根不探测，由界面单独成组。
 */
export function groupMcpClients(
  clients: McpClientDef[],
  probes: Record<string, ProbeForGrouping | null | undefined>,
): McpGroups {
  // 首帧 probes 还是空的。这时先全归到「检测到」组，探测回来后
  // 只有真没装的那几个会挪走——比先铺一个骨架屏再整体重排跳动小。
  const probing = Object.keys(probes).length === 0;
  const connected: McpClientDef[] = [];
  const present: McpClientDef[] = [];
  const absent: McpClientDef[] = [];

  for (const c of clients) {
    const p = probes[c.id] ?? null;
    if (p?.state === "current") {
      connected.push(c);
      continue;
    }
    // 🔴 `toolPresent || exists` 两个都要看：
    //    ① `toolPresent` 才是主句——工具装了但从没配过 MCP（目录在、
    //      配置文件不在）恰恰是一键接入最有用的场景，不能折起来；
    //    ② `exists` 是个双保险：注册表里的 `detectPath` 万一写错，
    //      也绝不能把一个配置文件明明就在那儿的客户端藏起来。
    if (probing || !p || p.toolPresent || p.exists) present.push(c);
    else absent.push(c);
  }

  return { probing, connected, present, absent };
}
