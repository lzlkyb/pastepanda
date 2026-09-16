/**
 * McpLanPanel —— 知识库 MCP 局域网直连。
 *
 * 嵌在 `McpServerPanel` 的「高级」折叠内、HTTPS 之后、写权限之前。
 *
 * 🔴 `lanEnabled`（配置）与 `lanActive`（真的绑上 0.0.0.0）必须一起读：
 *   bind 失败时前者是 true、后者是 false，原因在 `lanError` 横幅里
 *   （规则 #15.3）。
 *
 * 🔴 **不做 IP 白名单**（2026-09-15 拍板）：开着时凭 Bearer 令牌即可连入。
 * 写权限与本机共用现有 8 档开关。
 *
 * 局域网开着时提供「复制远程接入命令」（project / user 两种 scope）：
 * 复制到**别的机器**上粘贴执行即可一键接入（同 cc-bridge 的用法）。
 */
import { useCallback, useEffect, useState } from "react";
import { copyToClipboard, toastActionFailed } from "@/lib/utils";
import { confirmDialog } from "@/lib/confirm";
import {
  buildClaudeCliCommand,
  buildGenericMcpJson,
  buildMcpAiSetupPrompt,
} from "@/lib/mcpClients";
import { mcpSetLanEnabled, type McpStatus } from "@/lib/api/mcp";
import shared from "../Settings.module.css";
import styles from "./Mcp.module.css";

export function McpLanPanel({
  status,
  onNeedToken,
  onRefresh,
  toast,
}: {
  status: McpStatus;
  /** 懒取真令牌。只在用户点复制命令时调（规则：令牌不进轮询）。 */
  onNeedToken: () => Promise<string | null>;
  onRefresh: () => Promise<void>;
  toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [errDismissed, setErrDismissed] = useState(false);

  const lanError = status.lanError || "";
  useEffect(() => {
    setErrDismissed(false);
  }, [lanError]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      if (next) {
        const ok = await confirmDialog({
          title: "允许局域网访问知识库 MCP？",
          message:
            "打开后，局域网内任何拿到访问令牌的机器都可以读写你的笔记。\n\n" +
            "• 仍需访问令牌；令牌在局域网内以明文 HTTP 传输\n" +
            "• 写权限走下方 8 档开关，与本机同一套\n" +
            "• 删除仍只进回收站；写入计入调用记录\n\n" +
            "⚠ 请只在可信网络里开启，并妥善保管令牌。",
          confirmText: "开启局域网访问",
          variant: "warning",
        });
        if (!ok) return;
      }
      setBusy(true);
      const { err } = await mcpSetLanEnabled(next);
      if (err) toastActionFailed(next ? "开启局域网访问" : "关闭局域网访问", err);
      else toast(next ? "局域网访问已开启" : "局域网访问已关闭", "success");
      await onRefresh();
      setBusy(false);
    },
    [onRefresh, toast],
  );

  const lanUrl =
    status.lanIps[0] != null && status.port
      ? `http://${status.lanIps[0]}:${status.port}/mcp`
      : "";

  const handleCopyUrl = useCallback(async () => {
    if (!lanUrl) return;
    const ok = await copyToClipboard(lanUrl);
    toast(ok ? "局域网地址已复制" : "复制失败", ok ? "success" : "error");
  }, [lanUrl, toast]);

  /**
   * 复制「给 AI 的自配置说明」。普通用户主路径：
   * 贴到**远程那台机器**上的 AI，由 AI 代写 MCP 配置。
   */
  const handleCopyAiPrompt = useCallback(async () => {
    if (!lanUrl) return;
    const t = await onNeedToken();
    if (!t) return;
    const ok = await copyToClipboard(buildMcpAiSetupPrompt(lanUrl, t));
    toast(
      ok
        ? "已复制 AI 自配置说明（含令牌）——发到远程机器上的 AI，让它代你配置"
        : "复制失败",
      ok ? "success" : "error",
    );
  }, [lanUrl, onNeedToken, toast]);

  /** 复制带令牌的通用 mcpServers JSON（高级 / 手动改配置时用）。 */
  const handleCopyJson = useCallback(async () => {
    if (!lanUrl) return;
    const t = await onNeedToken();
    if (!t) return;
    const ok = await copyToClipboard(buildGenericMcpJson(lanUrl, t));
    toast(
      ok ? "已复制通用 MCP 配置 JSON（含令牌）" : "复制失败",
      ok ? "success" : "error",
    );
  }, [lanUrl, onNeedToken, toast]);

  /** 复制带令牌的 `claude mcp add`（次入口：只对 Claude Code 有用）。 */
  const handleCopyCli = useCallback(
    async (scope: "user" | "project") => {
      if (!lanUrl) return;
      const t = await onNeedToken();
      if (!t) return;
      const cmd = buildClaudeCliCommand(lanUrl, t, scope);
      const ok = await copyToClipboard(cmd);
      const label = scope === "project" ? "仅本项目" : "全局";
      toast(
        ok
          ? `已复制 Claude 命令（${label}，含令牌）——粘到远程机器终端执行`
          : "复制失败",
        ok ? "success" : "error",
      );
    },
    [lanUrl, onNeedToken, toast],
  );

  return (
    <div className={styles.mcpRows} style={{ marginTop: 12 }}>
      <div className={styles.mcpSectionLabel}>局域网访问（默认关）</div>

      <div className={styles.mcpRow}>
        <span className={styles.mcpLabel} style={{ width: 72 }}>
          允许局域网
        </span>
        <button
          type="button"
          className={`${styles.mcpSwitch}${status.lanEnabled ? ` ${styles.mcpSwitchOn}` : ""}`}
          role="switch"
          aria-checked={status.lanEnabled}
          aria-label="局域网访问开关"
          disabled={busy}
          onClick={() => void handleToggle(!status.lanEnabled)}
        />
        <span
          className={
            status.lanEnabled && status.lanActive
              ? styles.mcpPillOk
              : status.lanEnabled && lanError
                ? styles.mcpPillWarn
                : styles.mcpPillMute
          }
        >
          {status.lanEnabled
            ? status.lanActive
              ? "局域网监听中 · 凭令牌接入"
              : "配置已开，未能监听"
            : "关闭 · 仅本机"}
        </span>
      </div>

      {lanError && !errDismissed && (
        <div className={shared.mcpAlert}>
          <span>⚠</span>
          <span>{lanError}</span>
          <button type="button" onClick={() => setErrDismissed(true)}>
            知道了
          </button>
        </div>
      )}

      {status.lanEnabled && status.lanIps.length > 0 && (
        <>
          <div className={styles.mcpRow}>
            <span className={styles.mcpLabel} style={{ width: 72 }}>
              本机地址
            </span>
            <code className={styles.mcpValue}>{lanUrl || "—"}</code>
            <button
              type="button"
              className={styles.mcpApplyBtn}
              disabled={!lanUrl}
              onClick={() => void handleCopyUrl()}
            >
              复制
            </button>
          </div>

          <div className={styles.mcpRow}>
            <span className={styles.mcpLabel} style={{ width: 72 }}>
              远程接入
            </span>
            <button
              type="button"
              className={styles.mcpApplyBtn}
              disabled={!lanUrl || busy}
              title="复制完整说明，发到远程机器上的 AI，由它自动写入 MCP 配置"
              onClick={() => void handleCopyAiPrompt()}
            >
              复制给 AI 自动配置
            </button>
            <button
              type="button"
              className={styles.mcpApplyBtn}
              disabled={!lanUrl || busy}
              title="标准 mcpServers JSON（手动改配置时用）"
              onClick={() => void handleCopyJson()}
            >
              复制 JSON
            </button>
            <button
              type="button"
              className={styles.mcpApplyBtn}
              disabled={!lanUrl || busy}
              title="仅 Claude Code：只对当前文件夹/项目生效"
              onClick={() => void handleCopyCli("project")}
            >
              Claude · 仅本项目
            </button>
            <button
              type="button"
              className={styles.mcpApplyBtn}
              disabled={!lanUrl || busy}
              title="仅 Claude Code：对这台电脑上所有项目生效"
              onClick={() => void handleCopyCli("user")}
            >
              Claude · 全局
            </button>
            <span className={styles.mcpHint}>
              推荐：复制第一项 → 发到<strong>远程电脑上的 AI</strong>，让它代你改 MCP 配置。
              JSON / Claude 命令给会手动配置的人用。复制时才取令牌。
            </span>
          </div>
        </>
      )}
    </div>
  );
}
