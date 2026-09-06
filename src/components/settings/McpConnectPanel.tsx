/**
 * McpConnectPanel — 「接入到哪个 AI 工具」。MCP 面板的**第一屏**。
 *
 * # 为什么它要放到最上面
 *
 * 改之前，接入指引是面板的**最后一块且默认折叠**，上面压着地址/令牌/端口/
 * 写权限/调用记录五块。而用户开完服务后想知道的只有一件事：怎么连上。
 * 那五块都是「配好之后才会回来看」的，现已收进「高级」。
 *
 * # 本轮只做复制卡片
 *
 * 探测与一键写入在下一步。本组件**不读也不写任何外部文件**。
 *
 * 🔴 屏幕上永远是占位符，只有点「复制」时才取真令牌——设置页可能被录屏或截图。
 *   这条跟原 `McpClientGuide` 一致，不能因为改版式就丢。
 */
import { useState } from "react";
import { Copy, ChevronRight, ChevronDown, Info } from "lucide-react";
import { copyToClipboard } from "@/lib/utils";
import { MCP_CLIENTS, buildMcpConfigJson, type McpClientDef } from "@/lib/mcpClients";
import styles from "../Settings.module.css";

/** 屏幕上的占位符。真令牌只在点复制时才取。 */
const TOKEN_PLACEHOLDER = "<你的访问令牌>";

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

  /** 复制时才取真令牌；`build` 决定复的是 JSON 还是 CLI 命令。 */
  const copyFor = async (
    c: McpClientDef,
    build: (c: McpClientDef, url: string, token: string) => string,
    what: string,
  ) => {
    const t = await onNeedToken();
    if (!t) return;
    const ok = await copyToClipboard(build(c, url, t));
    toast(ok ? `${c.name} 的${what}已复制（含令牌）` : "复制失败", ok ? "success" : "error");
  };

  return (
    <div className={styles.mcpConnect}>
      <div className={styles.mcpConnectTitle}>接入到 AI 工具</div>

      {MCP_CLIENTS.map((c) => {
        const open = openId === c.id;
        return (
          <div key={c.id} className={styles.mcpClientRow}>
            <div className={styles.mcpClientHead}>
              <button
                type="button"
                className={styles.mcpClientName}
                onClick={() => setOpenId(open ? null : c.id)}
              >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span>{c.name}</span>
                {/* 路径就是最好的副标题：用户一眼能对上自己机器上有没有这个文件。 */}
                <code className={styles.mcpClientPath}>
                  {c.configPath ?? "应用内配置"}
                </code>
              </button>
              <button type="button" className={styles.mcpIconBtn} title="复制配置（含令牌）"
                onClick={() => void copyFor(c, buildMcpConfigJson, "配置")}>
                <Copy size={12} />
              </button>
            </div>

            {open && (
              <div className={styles.mcpClientBody}>
                <p className={styles.mcpGuideNote}>{c.where}</p>

                {/* 不能一键的要说清楚为什么，否则用户只会觉得“为什么它没有按钮”。 */}
                {c.manualReason && (
                  <p className={styles.mcpGuideNote}>
                    <Info size={11} /> 不提供一键接入：{c.manualReason}
                  </p>
                )}

                {/* 有官方 CLI 就先给它：比让用户手改 JSON 可靠得多。 */}
                {c.cli && (
                  <>
                    <div className={styles.mcpGuideRow}>
                      <span>命令行（推荐）</span>
                      <button type="button"
                        onClick={() => void copyFor(c, (cc, u, t) => cc.cli!(u, t), "命令")}>
                        <Copy size={12} /> 复制
                      </button>
                    </div>
                    <pre className={styles.mcpCode}>{c.cli(url, TOKEN_PLACEHOLDER)}</pre>
                    {c.cliNote && <p className={styles.mcpGuideNote}>{c.cliNote}</p>}
                    <div className={styles.mcpGuideRow}><span>或手写配置</span></div>
                  </>
                )}

                <pre className={styles.mcpCode}>
                  {buildMcpConfigJson(c, url, TOKEN_PLACEHOLDER)}
                </pre>
              </div>
            )}
          </div>
        );
      })}

      <p className={styles.mcpGuideNote}>
        上面显示的是占位符，<b>点复制拿到的才是带真令牌的完整内容</b>。
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
