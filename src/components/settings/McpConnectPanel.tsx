/**
 * McpConnectPanel —— 「接入到哪个 AI 工具」。MCP 面板的**第一屏**。
 *
 * # 为什么它要放到最上面
 *
 * 改之前，接入指引是面板的**最后一块且默认折叠**，上面压着地址/令牌/端口/
 * 写权限/调用记录五块。而用户开完服务后想知道的只有一件事：怎么连上。
 *
 * # 🔴 一键接入的两条约束
 *
 * 1. **一个一个来，每次都要用户确认**。没有也不会有「全部接入」按钮——
 *    这是在改**用户自己的配置文件**，不是改我们的设置。
 * 2. 确认框里必须写清楚**动哪个文件（绝对路径）、会备份、只动哪一个键**。
 *
 * 手动接入（复制卡片）永远保留：内置名单不可能穷举所有工具。
 *
 * 🔴 屏幕上永远是占位符，只有点「复制」时才取真令牌——设置页可能被录屏或截图。
 *   一键接入走的是另一条路：令牌根本不进前端，后端拿到占位符自己换（见 mcpClients.ts）。
 */
import { useCallback, useEffect, useState } from "react";
import { copyToClipboard } from "@/lib/utils";
import { confirmDialog } from "@/lib/confirm";
import {
  MCP_CLIENTS,
  MCP_ENTRY_NAME,
  buildMcpConfigJson,
  buildMcpEntryForConnect,
  canOneClick,
  type McpClientDef,
} from "@/lib/mcpClients";
import {
  mcpClientProbe,
  mcpClientConnect,
  mcpClientDisconnect,
  type McpClientProbe,
} from "@/lib/api/mcp";
import { McpClientRow, TOKEN_PLACEHOLDER } from "./McpClientRow";
import { McpCustomConnect } from "./McpCustomConnect";
import styles from "../Settings.module.css";

/** 只对有磁盘配置路径的客户端探测。 */
const PROBEABLE = MCP_CLIENTS.filter(canOneClick);

export function McpConnectPanel({
  url,
  onNeedToken,
  toast,
}: {
  url: string;
  /** 懒取真令牌。只在用户点复制时调。 */
  onNeedToken: () => Promise<string | null>;
  toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, McpClientProbe | null>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  /** 重新探测全部可一键的客户端。 */
  const refresh = useCallback(async () => {
    const rows = await Promise.all(
      PROBEABLE.map(async (c) => [c.id, await mcpClientProbe(c.configPath!)] as const),
    );
    setProbes(Object.fromEntries(rows));
  }, []);

  // 地址变了（换端口）就要重探：旧条目会从 current 变成 stale，
  // 而那正是用户需要看到的——否则他不知道已配好的客户端已经连不上了。
  useEffect(() => {
    void refresh();
  }, [refresh, url]);

  /** 复制时才取真令牌；`build` 决定复的是 JSON 还是 CLI 命令。 */
  const copyFor = useCallback(
    async (
      c: McpClientDef,
      build: (c: McpClientDef, url: string, token: string) => string,
      what: string,
    ) => {
      const t = await onNeedToken();
      if (!t) return;
      const ok = await copyToClipboard(build(c, url, t));
      toast(ok ? `${c.name} 的${what}已复制（含令牌）` : "复制失败", ok ? "success" : "error");
    },
    [onNeedToken, toast, url],
  );

  /** 接入：先确认，再写。 */
  const doConnect = useCallback(
    async (c: McpClientDef, probe: McpClientProbe) => {
      const ok = await confirmDialog({
        title: `把知识库接入 ${c.name}？`,
        message:
          `将修改这个文件：\n${probe.path}\n\n` +
          `• 修改前会先备份一份（同目录，文件名带 pastepanda-bak）\n` +
          `• 只添加/更新 mcpServers 里名为 「${MCP_ENTRY_NAME}」 的那一条，` +
          `其他服务器与配置原封不动\n` +
          `• 会把本机的访问令牌写进去（${c.name} 靠它访问你的笔记）` +
          (probe.exists ? "" : "\n• 该文件目前不存在，会新建") +
          (c.writeRaceCaveat ? `\n\n⚠ ${c.writeRaceCaveat}` : ""),
        confirmText: "接入",
      });
      if (!ok) return;

      const r = await mcpClientConnect(c.configPath!, buildMcpEntryForConnect(c, url));
      if ("err" in r) {
        // 后端的错误话术写得很具体（哪个文件、为什么没改），原样给用户看。
        toast(r.err, "error", 8000);
        return;
      }
      toast(
        r.ok.backup
          ? `已接入 ${c.name}（旧配置已备份）`
          : `已接入 ${c.name}（新建了配置文件）`,
        "success",
        6000,
      );
      await refresh();
    },
    [refresh, toast, url],
  );

  /** 移除：同样先确认。 */
  const doDisconnect = useCallback(
    async (c: McpClientDef, probe: McpClientProbe) => {
      const ok = await confirmDialog({
        title: `从 ${c.name} 移除接入？`,
        message:
          `将从这个文件里删掉名为 「${MCP_ENTRY_NAME}」 的条目：\n${probe.path}\n\n` +
          `删除前会先备份，其他服务器与配置原封不动。` +
          `${c.name} 将不再能访问你的知识库。`,
        confirmText: "移除",
        variant: "danger",
      });
      if (!ok) return;

      const r = await mcpClientDisconnect(c.configPath!);
      if ("err" in r) {
        toast(r.err, "error", 8000);
        return;
      }
      toast(r.ok.replaced ? `已从 ${c.name} 移除` : `${c.name} 本来就没有接入`, "success");
      await refresh();
    },
    [refresh, toast],
  );

  /** 按钮到底是接入还是移除，由探测状态决定。 */
  const onAction = useCallback(
    async (c: McpClientDef) => {
      const probe = probes[c.id];
      if (!probe) return;
      setBusyId(c.id);
      try {
        if (probe.state === "current") await doDisconnect(c, probe);
        else await doConnect(c, probe);
      } finally {
        setBusyId(null);
      }
    },
    [probes, doConnect, doDisconnect],
  );

  return (
    <div className={styles.mcpConnect}>
      <div className={styles.mcpConnectTitle}>接入到 AI 工具</div>

      {MCP_CLIENTS.map((c) => (
        <McpClientRow
          key={c.id}
          client={c}
          url={url}
          open={openId === c.id}
          busy={busyId === c.id}
          probe={probes[c.id] ?? null}
          onToggle={() => setOpenId(openId === c.id ? null : c.id)}
          onCopyConfig={() => void copyFor(c, buildMcpConfigJson, "配置")}
          onCopyCli={() => void copyFor(c, (cc, u, t) => cc.cli!(u, t), "命令")}
          onAction={() => void onAction(c)}
        />
      ))}

      {/* 🔴 自定义接入永远保留：上面那份内置名单不可能穷举所有工具。 */}
      <McpCustomConnect url={url} toast={toast} />

      <p className={styles.mcpGuideNote}>
        一键接入会先备份对方的配置文件，且<b>只动 mcpServers 里属于本软件的那一条</b>。
      </p>
      <p className={styles.mcpGuideNote}>
        展开后显示的是占位符 <code>{TOKEN_PLACEHOLDER}</code>，
        <b>点复制拿到的才是带真令牌的完整内容</b>。
        服务只监听本机回环地址，同一台电脑上的客户端才连得上。
      </p>
      <p className={styles.mcpGuideWarn}>
        ⚠ 别把它写进项目里的 <code>.mcp.json</code>（也就是别用
        <code>--scope project</code>）——那个文件是提交进仓库给团队共享的，
        <b>你的访问令牌会跟着进 git</b>。
      </p>
    </div>
  );
}
