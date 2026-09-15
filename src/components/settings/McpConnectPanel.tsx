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
import { useCallback, useEffect, useMemo, useState } from "react";
import { copyToClipboard } from "@/lib/utils";
import { confirmDialog } from "@/lib/confirm";
import {
  MCP_CLIENTS,
  MCP_CONTAINER_KEY,
  MCP_ENTRY_NAME,
  buildMcpConfigSnippet,
  buildMcpEntryForConnect,
  canOneClick,
  type McpClientDef,
} from "@/lib/mcpClients";
import { groupMcpClients } from "@/lib/mcpGroups";
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

/** 永远只能手动配的那几家。单独成组，顺带回答了「为什么它没有按钮」。 */
const MANUAL = MCP_CLIENTS.filter((c) => !canOneClick(c));

export function McpConnectPanel({
  url,
  lanUrl,
  onNeedToken,
  toast,
}: {
  /** 本机回环地址（一键写入本地配置**永远**用它）。 */
  url: string;
  /**
   * 局域网地址；局域网未开或探测不到网卡时为 `""`。
   * 只影响「复制配置 / 复制命令」，不影响一键写入。
   */
  lanUrl?: string;
  /** 懒取真令牌。只在用户点复制时调。 */
  onNeedToken: () => Promise<string | null>;
  toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, McpClientProbe | null>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  /**
   * 复制时用哪个地址。
   *
   * 🔴 **一键写入永远用本机 url**：写的是这台机器上的客户端配置，
   *   填局域网地址会让本机客户端绕一圈还可能被防火墙拦。
   */
  const [copyMode, setCopyMode] = useState<"local" | "lan">("local");
  const lanOn = !!lanUrl;
  const copyUrl = copyMode === "lan" && lanOn ? lanUrl! : url;

  /** 重新探测全部可一键的客户端。 */
  const refresh = useCallback(async () => {
    const rows = await Promise.all(
      // ❗ `containerKey` 三处（探测 / 接入 / 移除）必须都传且一致——
      //   只传一处的话，OpenCode 会出现「接入了却报未接入」或「移除成功但条目还在」。
      PROBEABLE.map(
        async (c) =>
          [c.id, await mcpClientProbe(c.configPath!, c.containerKey, c.detectPath)] as const,
      ),
    );
    setProbes(Object.fromEntries(rows));
  }, []);

  // 地址变了（换端口）就要重探：旧条目会从 current 变成 stale，
  // 而那正是用户需要看到的——否则他不知道已配好的客户端已经连不上了。
  useEffect(() => {
    void refresh();
  }, [refresh, url]);

  /** 复制时才取真令牌；`build` 决定复的是 JSON 还是 CLI 命令。地址用 `copyUrl`。 */
  const copyFor = useCallback(
    async (
      c: McpClientDef,
      build: (c: McpClientDef, url: string, token: string) => string,
      what: string,
    ) => {
      const t = await onNeedToken();
      if (!t) return;
      const ok = await copyToClipboard(build(c, copyUrl, t));
      toast(
        ok
          ? `${c.name} 的${what}已复制（含令牌${lanOn && copyMode === "lan" ? " · 局域网地址" : ""}）`
          : "复制失败",
        ok ? "success" : "error",
      );
    },
    [onNeedToken, toast, copyUrl, lanOn, copyMode],
  );

  /** 接入：先确认，再写。 */
  const doConnect = useCallback(
    async (c: McpClientDef, probe: McpClientProbe) => {
      const ok = await confirmDialog({
        title: `把知识库接入 ${c.name}？`,
        message:
          `将修改这个文件：\n${probe.path}\n\n` +
          `• 修改前会先备份一份（同目录，文件名带 pastepanda-bak）\n` +
          // ❗ 容器键得跟着客户端读（OpenCode 是 `mcp`、Codex 是 `mcp_servers`）。
          //   写死 `mcpServers` 的话，确认框会告诉用户一个我们根本不会去改的键——
          //   而这句话的全部意义就是“告诉你我到底要动什么”。
          `• 只添加/更新 ${c.containerKey ?? MCP_CONTAINER_KEY} 里名为 「${MCP_ENTRY_NAME}」 的那一条，` +
          `其他服务器与配置原封不动\n` +
          `• 会把本机的访问令牌写进去（${c.name} 靠它访问你的笔记）` +
          (probe.exists ? "" : "\n• 该文件目前不存在，会新建") +
          (c.connectCaveat ? `\n\n⚠ ${c.connectCaveat}` : ""),
        confirmText: "接入",
      });
      if (!ok) return;

      const r = await mcpClientConnect(
        c.configPath!,
        // 🔴 永远写本机回环地址，与 copyMode 无关
        buildMcpEntryForConnect(c, url),
        c.containerKey,
      );
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

      const r = await mcpClientDisconnect(c.configPath!, c.containerKey);
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

  /**
   * 分组。名单长到十几家之后，一视同仁地铺平就不行了：
   * 用户机器上只装了一两个工具，其余十几行全是噪音，
   * 真正要操作的那一两行反而埋在中间。
   *
   * 规则本体在 `lib/mcpGroups.ts`——拎出去是为了能直接测：
   * 分错组不会报错，只会让本该露出来的行落进折叠区，而那种 bug 没人会发现。
   */
  const groups = useMemo(() => groupMcpClients(PROBEABLE, probes), [probes]);

  const renderRow = (c: McpClientDef) => (
    <McpClientRow
      key={c.id}
      client={c}
      url={url}
      open={openId === c.id}
      busy={busyId === c.id}
      probe={probes[c.id] ?? null}
      onToggle={() => setOpenId(openId === c.id ? null : c.id)}
      onCopyConfig={() => void copyFor(c, buildMcpConfigSnippet, "配置")}
      onCopyCli={() => void copyFor(c, (cc, u, t) => cc.cli!(u, t), "命令")}
      onAction={() => void onAction(c)}
    />
  );

  return (
    <div className={styles.mcpConnect}>
      <div className={styles.mcpConnectHead}>
        <div className={styles.mcpConnectTitle}>接入到 AI 工具</div>
        {/* ❗ 右边那个数不能写成「检测到 N」：它只是 present 组的大小，
            而已接入的那几个同样是检测到的——那会变成一个少报的假数字。
            present 里的三种状态（未接入 / 令牌或地址已变更 / 配置读不了）
            都确实是「现在连不上」，所以叫未接入才是准的。 */}
        {!groups.probing && (
          <div className={styles.mcpConnectSummary}>
            已接入 {groups.connected.length} · 未接入 {groups.present.length}
          </div>
        )}
      </div>

      {/* 局域网开着才出现：只影响「复制」，一键写入永远本机地址。 */}
      {lanOn && (
        <div className={styles.mcpUrlMode}>
          <span className={styles.mcpUrlModeLabel}>复制地址</span>
          <button
            type="button"
            className={`${styles.mcpUrlModeBtn}${copyMode === "local" ? ` ${styles.mcpUrlModeOn}` : ""}`}
            onClick={() => setCopyMode("local")}
          >
            本机
          </button>
          <button
            type="button"
            className={`${styles.mcpUrlModeBtn}${copyMode === "lan" ? ` ${styles.mcpUrlModeOn}` : ""}`}
            onClick={() => setCopyMode("lan")}
          >
            局域网
          </button>
          <span className={styles.mcpHint} style={{ width: "auto", paddingLeft: 0, flex: 1 }}>
            选「局域网」时，复制出去的配置/命令给别的机器用；一键接入仍写本机地址
          </span>
        </div>
      )}

      {groups.connected.length > 0 && (
        <details className={styles.mcpGroup} open>
          <summary className={styles.mcpGroupSummary}>
            已接入<span className={styles.mcpGroupCount}>{groups.connected.length}</span>
          </summary>
          {groups.connected.map(renderRow)}
        </details>
      )}

      {groups.present.length > 0 && (
        <details className={styles.mcpGroup} open>
          <summary className={styles.mcpGroupSummary}>
            {groups.probing ? (
              "正在检测本机装了哪些工具…"
            ) : (
              <>
                本机检测到的工具
                <span className={styles.mcpGroupCount}>{groups.present.length}</span>
              </>
            )}
          </summary>
          {groups.present.map(renderRow)}
        </details>
      )}

      {/* 下面两组默认折着。标题里带上名字：不展开也能知道里面是谁，
          省得用户为了确认「我的工具在不在名单里」而挨个点开。 */}
      {groups.absent.length > 0 && (
        <details className={styles.mcpGroup}>
          <summary className={styles.mcpGroupSummary}>
            本机没检测到<span className={styles.mcpGroupCount}>{groups.absent.length}</span>
            <span className={styles.mcpGroupNames}>
              {groups.absent.map((c) => c.name).join("、")}
            </span>
          </summary>
          {groups.absent.map(renderRow)}
        </details>
      )}

      {MANUAL.length > 0 && (
        <details className={styles.mcpGroup}>
          <summary className={styles.mcpGroupSummary}>
            需要手动配置<span className={styles.mcpGroupCount}>{MANUAL.length}</span>
            <span className={styles.mcpGroupNames}>
              {MANUAL.map((c) => c.name).join("、")}
            </span>
          </summary>
          {MANUAL.map(renderRow)}
        </details>
      )}

      {/* 🔴 自定义接入永远保留：上面那份内置名单不可能穷举所有工具。
          自定义接入写的是**本机**配置文件，所以永远传本机 url。 */}
      <McpCustomConnect url={url} toast={toast} />

      <p className={styles.mcpGuideNote}>
        一键接入会先备份对方的配置文件，且<b>只动其中属于本软件的那一条</b>。
        一键写入永远用本机地址；复制可选本机/局域网。
      </p>
      <p className={styles.mcpGuideNote}>
        展开后显示的是占位符 <code>{TOKEN_PLACEHOLDER}</code>，
        <b>点复制拿到的才是带真令牌的完整内容</b>。
        {lanOn
          ? "选「局域网」时，把复制的内容粘到远程机器上即可接入。"
          : "默认只监听本机回环地址；若要远程接入，请先在下方打开局域网访问。"}
      </p>
      {!lanOn && (
        <p className={styles.mcpGuideWarn}>
          ⚠ 别把它写进项目里的 <code>.mcp.json</code>（也就是别用
          <code>--scope project</code>）——那个文件是提交进仓库给团队共享的，
          <b>你的访问令牌会跟着进 git</b>。
        </p>
      )}
      {lanOn && copyMode === "lan" && (
        <p className={styles.mcpGuideWarn}>
          ⚠ 若用 <code>--scope project</code> 复制命令，注意项目配置若会进 git，
          <b>令牌也会跟着提交</b>。团队仓库请改用 <code>user</code> scope 或本地私有配置。
        </p>
      )}
    </div>
  );
}
