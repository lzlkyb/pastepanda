/**
 * MCP 服务设置面板（M4 步骤 4）。设计稿：design/知识库MCP服务-设置面板-设计稿.html
 *
 * 只在服务开着时渲染（GeneralTab 里 `{running && <McpServerPanel/>}`），
 * 关态就只有一行开关——同 LAN 同步那一节的做法。
 *
 * 状态与副作用全在 `useMcpServer`，这里只管渲染（规则 #7）。
 */
import { useCallback, useState } from "react";
import { Copy, Eye, EyeOff, RefreshCw, AlertTriangle } from "lucide-react";
import { copyToClipboard } from "@/lib/utils";
import { confirmDialog } from "@/lib/confirm";
import { mcpGetToken, mcpRegenerateToken, type McpStatus } from "@/lib/api/mcp";
import { McpClientGuide } from "./McpClientGuide";
import { McpWritePanel } from "./McpWritePanel";
import { McpAuditPanel } from "./McpAuditPanel";
import styles from "../Settings.module.css";

/** 令牌是 43 个字符的 base64url。遮码时只留头尾，够用户认出是哪一把。 */
function mask(token: string): string {
  if (token.length <= 12) return "•".repeat(token.length);
  return `${token.slice(0, 6)}${"•".repeat(12)}${token.slice(-4)}`;
}

export function McpServerPanel({
  status,
  busy,
  startError,
  auditError,
  onSetPort,
  onDismissError,
  onDismissAuditError,
  toast,
}: {
  status: McpStatus;
  busy: boolean;
  startError: string;
  auditError: string;
  onSetPort: (port: number) => Promise<boolean>;
  onDismissError: () => void;
  onDismissAuditError: () => void;
  toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void;
}) {
  const [token, setToken] = useState("");
  const [shown, setShown] = useState(false);
  const [portInput, setPortInput] = useState(String(status.port));

  /** 懒取令牌：没点「显示」或「复制」之前它从不进前端（见 lib/api/mcp.ts 头部）。 */
  const ensureToken = useCallback(async () => {
    if (token) return token;
    const t = await mcpGetToken();
    if (t) setToken(t);
    return t;
  }, [token]);

  const handleCopyToken = useCallback(async () => {
    const t = await ensureToken();
    if (!t) return;
    // 复制令牌不会被剪贴板监听记成明文历史：
    // 后端 `secret_registry` 登记了本机自有凭证，识别到就无条件跳过，
    // **不看用户的「跳过敏感内容」开关**。
    const ok = await copyToClipboard(t);
    toast(ok ? "访问令牌已复制" : "复制失败", ok ? "success" : "error");
  }, [ensureToken, toast]);

  const handleRegenerate = useCallback(async () => {
    const ok = await confirmDialog({
      title: "重置访问令牌？",
      message:
        "旧令牌立即失效，所有已经配好的客户端（Claude Code 等）都会断连，需要用新令牌重新配一遍。",
      confirmText: "重置令牌",
      variant: "danger",
    });
    if (!ok) return;
    const t = await mcpRegenerateToken();
    if (!t) return;
    setToken(t);
    setShown(true);
    toast("令牌已重置，请重新配置客户端", "success");
  }, [toast]);

  return (
    <div className={styles.lanPanel}>
      <div className={styles.lanPanelHeader}>
        <div className={styles.lanStatus}>
          <span className={`${styles.lanDot}${status.running ? "" : ` ${styles.off}`}`} />
          <span className={styles.lanStatusText}>
            {status.running ? `监听中 · 端口 ${status.port}` : "未运行"}
          </span>
        </div>
      </div>

      {/* 启动失败必须看得见：最常见的原因是端口被占，而用户能自己改端口解决。
          用横幅而不是 toast：toast 会飘走，而开机自启失败发生在设置页打开之前。 */}
      {startError && (
        <div className={styles.mcpAlert}>
          <AlertTriangle size={13} />
          <span>{startError}</span>
          <button type="button" onClick={onDismissError}>知道了</button>
        </div>
      )}

      <McpFieldRows
        status={status}
        busy={busy}
        token={token}
        shown={shown}
        portInput={portInput}
        onPortInput={setPortInput}
        onSetPort={onSetPort}
        onToggleShow={async () => {
          if (!shown && !(await ensureToken())) return;
          setShown((v) => !v);
        }}
        onCopyToken={handleCopyToken}
        onRegenerate={handleRegenerate}
        toast={toast}
      />

      {/* 写权限放在最上面：它回答的是「这东西到底能对我的笔记做什么」，
          比「它做过什么」（调用记录）与「怎么接」（指引）都更该先看到。 */}
      <McpWritePanel toast={toast} />

      {/* 调用记录放在接入指引**之上**：指引是配一次就不看了的，
          而「谁读过我什么」是需要反复回来看的。 */}
      <McpAuditPanel
        auditError={auditError}
        onDismissError={onDismissAuditError}
        toast={toast}
      />

      <McpClientGuide url={status.url} onNeedToken={ensureToken} toast={toast} />
    </div>
  );
}

/** 地址 / 令牌 / 端口三行。拆出来只为了上面那个组件别超 300 行（规则 #7）。 */
function McpFieldRows({
  status,
  busy,
  token,
  shown,
  portInput,
  onPortInput,
  onSetPort,
  onToggleShow,
  onCopyToken,
  onRegenerate,
  toast,
}: {
  status: McpStatus;
  busy: boolean;
  token: string;
  shown: boolean;
  portInput: string;
  onPortInput: (v: string) => void;
  onSetPort: (port: number) => Promise<boolean>;
  onToggleShow: () => void;
  onCopyToken: () => void;
  onRegenerate: () => void;
  toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void;
}) {
  const port = Number(portInput);
  // 后端也拦 1024 以下，但前端得先拦——否则用户要点一下才知道不行。
  const portValid = Number.isInteger(port) && port >= 1024 && port <= 65535;
  const portDirty = port !== status.port;

  return (
    <div className={styles.mcpRows}>
      <div className={styles.mcpRow}>
        <span className={styles.mcpLabel}>服务地址</span>
        <code className={styles.mcpValue}>{status.url || "—"}</code>
        <button
          type="button"
          className={styles.mcpIconBtn}
          title="复制地址"
          disabled={!status.url}
          onClick={async () => {
            const ok = await copyToClipboard(status.url);
            toast(ok ? "地址已复制" : "复制失败", ok ? "success" : "error");
          }}
        >
          <Copy size={13} />
        </button>
      </div>

      <div className={styles.mcpRow}>
        <span className={styles.mcpLabel}>访问令牌</span>
        <code className={styles.mcpValue}>
          {token ? (shown ? token : mask(token)) : "•".repeat(22)}
        </code>
        <button type="button" className={styles.mcpIconBtn} title={shown ? "隐藏" : "显示"} onClick={onToggleShow}>
          {shown ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
        <button type="button" className={styles.mcpIconBtn} title="复制令牌" onClick={onCopyToken}>
          <Copy size={13} />
        </button>
        <button type="button" className={styles.mcpIconBtn} title="重置令牌" onClick={onRegenerate}>
          <RefreshCw size={13} />
        </button>
      </div>

      <div className={styles.mcpRow}>
        <span className={styles.mcpLabel}>监听端口</span>
        <input
          className={styles.mcpPortInput}
          type="number"
          min={1024}
          max={65535}
          value={portInput}
          onChange={(e) => onPortInput(e.target.value)}
        />
        <button
          type="button"
          className={styles.mcpApplyBtn}
          disabled={busy || !portValid || !portDirty}
          onClick={() => void onSetPort(port)}
        >
          应用
        </button>
        {!portValid && <span className={styles.mcpHint}>端口要在 1024–65535 之间</span>}
        {portValid && portDirty && (
          // 改端口会重启服务，已配好的客户端地址就失效了——得先说。
          <span className={styles.mcpHint}>应用后需要把新地址重新配给客户端</span>
        )}
      </div>
    </div>
  );
}
