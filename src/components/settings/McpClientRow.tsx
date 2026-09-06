/**
 * McpClientRow —— 接入列表里的一行。
 *
 * 拆出来只为了 `McpConnectPanel` 别超 300 行（规则 #7）；它不持状态，
 * 探测结果与忙碌标志都由父级传进来。
 */
import { Copy, ChevronRight, ChevronDown, Info } from "lucide-react";
import { canOneClick, buildMcpConfigJson, type McpClientDef } from "@/lib/mcpClients";
import type { McpClientProbe } from "@/lib/api/mcp";
import styles from "../Settings.module.css";

/** 屏幕上的占位符。真令牌只在点复制时才取。 */
export const TOKEN_PLACEHOLDER = "<你的访问令牌>";

/** 状态徽标的文案与颜色。 */
function badgeOf(
  client: McpClientDef,
  probe: McpClientProbe | null,
): { text: string; cls: string } {
  if (!canOneClick(client)) return { text: "手动配置", cls: "" };
  if (!probe) return { text: "检测中…", cls: "" };
  switch (probe.state) {
    case "current":
      return { text: "已接入", cls: styles.mcpBadgeOn };
    // 🔴 不能显示成「已接入」：换过端口或重置过令牌后，那个客户端其实已经
    //   连不上了，而它不会报错——用户只会觉得「工具突然不好用了」。
    case "stale":
      return { text: "令牌或地址已变更", cls: styles.mcpBadgeStale };
    case "unreadable":
      return { text: "配置读不了", cls: styles.mcpBadgeBad };
    default:
      return probe.exists
        ? { text: "未接入", cls: "" }
        : { text: "未检测到配置文件", cls: "" };
  }
}

/** 一键按钮的文案；返回 null = 这一行不给一键按钮。 */
function actionLabel(probe: McpClientProbe | null): string | null {
  if (!probe) return null;
  switch (probe.state) {
    case "current":
      return "移除接入";
    case "stale":
      return "重新接入";
    case "unreadable":
      return null; // 读不懂的文件不提供一键，只能手动处理
    default:
      return "一键接入";
  }
}

export function McpClientRow({
  client,
  url,
  open,
  busy,
  probe,
  onToggle,
  onCopyConfig,
  onCopyCli,
  onAction,
}: {
  client: McpClientDef;
  url: string;
  open: boolean;
  busy: boolean;
  probe: McpClientProbe | null;
  onToggle: () => void;
  onCopyConfig: () => void;
  onCopyCli: () => void;
  /** 接入 / 移除。具体是哪个由 `probe.state` 决定，父级自己再判一次。 */
  onAction: () => void;
}) {
  const badge = badgeOf(client, probe);
  const label = canOneClick(client) ? actionLabel(probe) : null;

  return (
    <div className={styles.mcpClientRow}>
      <div className={styles.mcpClientHead}>
        <button type="button" className={styles.mcpClientName} onClick={onToggle}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>{client.name}</span>
          {/* 路径就是最好的副标题：用户一眼能对上自己机器上有没有这个文件。
              探测回来了就换成展开后的绝对路径（`~` 对不上到底是哪个目录）。 */}
          <code className={styles.mcpClientPath}>
            {probe?.path ?? client.configPath ?? "应用内配置"}
          </code>
        </button>

        <span className={`${styles.mcpBadge} ${badge.cls}`}>{badge.text}</span>

        {label && (
          <button
            type="button"
            className={styles.mcpApplyBtn}
            disabled={busy}
            onClick={onAction}
          >
            {label}
          </button>
        )}

        <button
          type="button"
          className={styles.mcpIconBtn}
          title="复制配置（含令牌）"
          onClick={onCopyConfig}
        >
          <Copy size={12} />
        </button>
      </div>

      {open && (
        <div className={styles.mcpClientBody}>
          <p className={styles.mcpGuideNote}>{client.where}</p>

          {/* 不能一键的要说清楚为什么，否则用户只会觉得“为什么它没有按钮”。 */}
          {client.manualReason && (
            <p className={styles.mcpGuideNote}>
              <Info size={11} /> 不提供一键接入：{client.manualReason}
            </p>
          )}

          {/* 探测失败的原因就地显示，不弹 toast（面板一打开就批量探，弹了就是刷屏）。 */}
          {probe?.state === "unreadable" && (
            <p className={styles.mcpGuideWarn}>⚠ {probe.detail}</p>
          )}

          {/* 有官方 CLI 就先给它：比让用户手改 JSON 可靠得多。 */}
          {client.cli && (
            <>
              <div className={styles.mcpGuideRow}>
                <span>命令行（推荐）</span>
                <button type="button" onClick={onCopyCli}>
                  <Copy size={12} /> 复制
                </button>
              </div>
              <pre className={styles.mcpCode}>{client.cli(url, TOKEN_PLACEHOLDER)}</pre>
              {client.cliNote && <p className={styles.mcpGuideNote}>{client.cliNote}</p>}
              <div className={styles.mcpGuideRow}>
                <span>或手写配置</span>
              </div>
            </>
          )}

          <pre className={styles.mcpCode}>
            {buildMcpConfigJson(client, url, TOKEN_PLACEHOLDER)}
          </pre>
        </div>
      )}
    </div>
  );
}
