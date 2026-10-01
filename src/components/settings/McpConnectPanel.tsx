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
import {
  MCP_CLIENTS,
  canOneClick,
  stdioBridgeNote,
  type McpClientDef,
} from "@/lib/mcpClients";
import { groupMcpClients } from "@/lib/mcpGroups";
import { useMcpStdioStatus } from "@/hooks/useMcpStdioStatus";
import { mcpClientProbe, type McpClientProbe } from "@/lib/api/mcp";
import {
  connectMcpClient,
  copyMcpClientConfig,
  disconnectMcpClient,
} from "@/lib/mcpConnectActions";
import { McpClientRow } from "./McpClientRow";
import { McpConnectFootnote } from "./McpConnectFootnote";
import { McpCustomConnect } from "./McpCustomConnect";
import styles from "./Mcp.module.css";

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

  /** stdio 那一行的 `command` 与「服务/端口文件在不在」（见钩子的注释）。 */
  const { stdio, failed: stdioFailed } = useMcpStdioStatus();
  // 🔴 `stdio === null` 有两种意思：还没读到 / 读失败了，而只有后者能报错。
  // 拿 `failed` 把它们分开，否则面板一打开会先闪一句「读不到状态」的假警报。
  const stdioNote = stdio || stdioFailed ? stdioBridgeNote(stdio) : null;

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

  /**
   * 复制**命令行**（只有带 `cli` 的那几家有）。地址用 `copyUrl`，令牌此刻才取。
   *
   * 配置卡片不在这里：那张要按 http / stdio 分岔（stdio 不含令牌，见
   * `mcpConnectActions.copyMcpClientConfig`），纯判断的部分拎到 lib 里才能单测。
   */
  const copyCli = useCallback(
    async (c: McpClientDef) => {
      const t = await onNeedToken();
      if (!t) return;
      const ok = await copyToClipboard(c.cli!(copyUrl, t));
      toast(
        ok
          ? `${c.name} 的命令已复制（含令牌${lanOn && copyMode === "lan" ? " · 局域网地址" : ""}）`
          : "复制失败",
        ok ? "success" : "error",
      );
    },
    [onNeedToken, toast, copyUrl, lanOn, copyMode],
  );

  /**
   * 接入 / 移除：确认框与写入都在 `lib/mcpConnectActions`（文案是纯函数，能单测）。
   * 这两个包装只补一件事——写成功之后重探一次，让分组数字与按钮态回到真值。
   */
  const doConnect = useCallback(
    async (c: McpClientDef, probe: McpClientProbe) => {
      if (await connectMcpClient(c, probe, url, toast)) await refresh();
    },
    [refresh, toast, url],
  );

  const doDisconnect = useCallback(
    async (c: McpClientDef, probe: McpClientProbe) => {
      if (await disconnectMcpClient(c, probe, toast)) await refresh();
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
      stdioCommand={stdio?.command ?? null}
      stdioNote={stdioNote}
      onCopyConfig={() =>
        void copyMcpClientConfig(
          c,
          {
            copyUrl,
            stdioCommand: stdio?.command ?? null,
            onNeedToken,
            lanOn,
            copyMode,
          },
          toast,
        )
      }
      onCopyCli={() => void copyCli(c)}
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

      <McpConnectFootnote lanOn={lanOn} copyMode={copyMode} />
    </div>
  );
}
