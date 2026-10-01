/**
 * mcpConnectActions —— MCP「一键接入 / 移除」的确认文案与写入。
 *
 * 从 `McpConnectPanel.tsx` 拎出来（规则 #7），但真正的理由是**可测**：
 * 确认框这句话的全部意义就是「告诉你我到底要动什么」，而它写错的方式是静默的——
 * 容器键写死成 `mcpServers` 时，OpenCode（`mcp`）/ Codex（`mcp_servers`）的
 * 用户会看到一句关于一个我们根本不会去改的键的承诺。文案是纯函数，能单独钉。
 *
 * 🔴 这两条链路的铁律（留在调用点也成立，这里只是复述）：
 * 1. **一个一个来、每次都要用户确认**——改的是用户自己的配置文件；
 * 2. **一键写入永远用本机回环地址**，与「复制用哪个地址」无关。
 */
import { confirmDialog } from "@/lib/confirm";
import { copyToClipboard } from "@/lib/utils";
import {
  MCP_CONTAINER_KEY,
  MCP_ENTRY_NAME,
  MCP_STDIO_ARGS,
  buildMcpConfigSnippet,
  buildMcpEntryForConnect,
  isStdioClient,
  type McpClientDef,
} from "@/lib/mcpClients";
import {
  mcpClientConnect,
  mcpClientDisconnect,
  type McpClientProbe,
} from "@/lib/api/mcp";

export type McpToast = (
  msg: string,
  type?: "success" | "error" | "info",
  duration?: number,
) => void;

/** 本次真正要写的容器键——确认框与写入必须用同一个表达式，不能各写一遍。 */
export function mcpContainerKeyOf(c: McpClientDef): string {
  return c.containerKey ?? MCP_CONTAINER_KEY;
}

/**
 * 确认框里那句「会往里写什么」。
 *
 * 🔴 stdio 那一类**没有令牌可写**（方案 ①：桥跟主程序读同一个 DPAPI 文件）。
 * 不分开的话，这句承诺对它是假的——而确认框是唯一一处告诉用户
 * 「我们要往你自己的文件里塞什么」的地方，塞什么必须说准。
 */
function writePromiseLine(c: McpClientDef): string {
  return isStdioClient(c)
    ? `• 写入本程序的绝对路径 + ${MCP_STDIO_ARGS[0]}（stdio 子进程模式，不含访问令牌）`
    : `• 会把本机的访问令牌写进去（${c.name} 靠它访问你的笔记）`;
}

/** 接入确认框的标题与正文（纯函数）。 */
export function connectConfirmText(c: McpClientDef, probe: McpClientProbe) {
  return {
    title: `把知识库接入 ${c.name}？`,
    message:
      `将修改这个文件：\n${probe.path}\n\n` +
      `• 修改前会先备份一份（同目录，文件名带 pastepanda-bak）\n` +
      `• 只添加/更新 ${mcpContainerKeyOf(c)} 里名为 「${MCP_ENTRY_NAME}」 的那一条，` +
      `其他服务器与配置原封不动\n` +
      writePromiseLine(c) +
      (probe.exists ? "" : "\n• 该文件目前不存在，会新建") +
      (c.connectCaveat ? `\n\n⚠ ${c.connectCaveat}` : ""),
  };
}

/** 移除确认框的标题与正文（纯函数）。 */
export function disconnectConfirmText(c: McpClientDef, probe: McpClientProbe) {
  return {
    title: `从 ${c.name} 移除接入？`,
    message:
      `将从这个文件里删掉名为 「${MCP_ENTRY_NAME}」 的条目：\n${probe.path}\n\n` +
      `删除前会先备份，其他服务器与配置原封不动。` +
      `${c.name} 将不再能访问你的知识库。`,
  };
}

/**
 * 复制某家的配置卡片。
 *
 * 🔴 分两条路，而且差别是实质性的：
 *   · http 类：屏幕上永远是占位符，**只有点复制这一刻**才取真令牌
 *     （设置页可能被录屏或截图）；
 *   · stdio 类（方案 ①）：条目里一个令牌都没有，它要的是**本程序的绝对路径**。
 *     照 http 那条走的话有两个后果——白取一次令牌（它根本用不上，
 *     而取令牌是要弹「已显示」提示的），以及那句「已复制（含令牌）」变成假话。
 *
 * 拿不到 `stdioCommand` 时宁可报错，**不能**把 `__PASTEPANDA_EXE__` 复制出去：
 * 那是后端才换得掉的记号，用户粘进 Claude Desktop 只会得到一句 `failed to start`。
 */
export async function copyMcpClientConfig(
  c: McpClientDef,
  ctx: {
    /** 复制用哪个地址（本机 / 局域网）。stdio 忽略它——桥永远是本机进程。 */
    copyUrl: string;
    /** 后端 `mcp_stdio_status` 给的本程序路径；`null` = 还没读到或读失败。 */
    stdioCommand: string | null;
    /** 只在 http 那条路上才会被调用。 */
    onNeedToken: () => Promise<string | null>;
    /** 只影响提示文案。 */
    lanOn: boolean;
    copyMode: "local" | "lan";
  },
  toast: McpToast,
): Promise<void> {
  if (isStdioClient(c)) {
    if (!ctx.stdioCommand) {
      toast("读不到本程序路径，暂时复制不了这份配置", "error", 8000);
      return;
    }
    // 令牌位给空串：stdio 分支根本不读它（见 `buildMcpEntry`）。
    const text = buildMcpConfigSnippet(c, "", "", ctx.stdioCommand);
    const ok = await copyToClipboard(text);
    toast(
      ok ? `${c.name} 的配置已复制（含本机程序路径，不含令牌）` : "复制失败",
      ok ? "success" : "error",
    );
    return;
  }
  const t = await ctx.onNeedToken();
  if (!t) return;
  const ok = await copyToClipboard(buildMcpConfigSnippet(c, ctx.copyUrl, t));
  toast(
    ok
      ? `${c.name} 的配置已复制（含令牌${ctx.lanOn && ctx.copyMode === "lan" ? " · 局域网地址" : ""}）`
      : "复制失败",
    ok ? "success" : "error",
  );
}

/**
 * 接入：确认 → 写 → toast。返回 `true` 表示写成功了，调用方据此重探。
 *
 * 后端的错误话术写得很具体（哪个文件、为什么没改），原样给用户看。
 */
export async function connectMcpClient(
  c: McpClientDef,
  probe: McpClientProbe,
  url: string,
  toast: McpToast,
): Promise<boolean> {
  const { title, message } = connectConfirmText(c, probe);
  if (!(await confirmDialog({ title, message, confirmText: "接入" }))) return false;

  const r = await mcpClientConnect(
    c.configPath!,
    // 🔴 永远写本机回环地址，与「复制用哪个地址」无关
    buildMcpEntryForConnect(c, url),
    c.containerKey,
  );
  if ("err" in r) {
    toast(r.err, "error", 8000);
    return false;
  }
  toast(
    r.ok.backup ? `已接入 ${c.name}（旧配置已备份）` : `已接入 ${c.name}（新建了配置文件）`,
    "success",
    6000,
  );
  return true;
}

/** 移除：同样先确认。返回 `true` 表示要重探。 */
export async function disconnectMcpClient(
  c: McpClientDef,
  probe: McpClientProbe,
  toast: McpToast,
): Promise<boolean> {
  const { title, message } = disconnectConfirmText(c, probe);
  if (
    !(await confirmDialog({ title, message, confirmText: "移除", variant: "danger" }))
  )
    return false;

  const r = await mcpClientDisconnect(c.configPath!, c.containerKey);
  if ("err" in r) {
    toast(r.err, "error", 8000);
    return false;
  }
  toast(r.ok.replaced ? `已从 ${c.name} 移除` : `${c.name} 本来就没有接入`, "success");
  return true;
}
