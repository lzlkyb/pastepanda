/**
 * McpHttpsPanel —— HTTPS 监听与系统信任库 CA（TLS-1 / TLS-2）。
 *
 * 嵌在 `McpServerPanel` 的「高级」折叠内、端口行之后、写权限之前。
 *
 * 🔴 `httpsRunning` 与 `httpsError` **必须一起读**（规则 #15.3）：
 *   开关开着但端口被占时前者是 false，只显示开关状态等于骗人。
 *
 * 装/卸 CA 是**系统级**动作：前端先弹确认框写清影响范围与可逆性，
 * certutil 自己还会再弹一次系统确认——两道都别省。
 */
import { useCallback, useEffect, useState } from "react";
import { copyToClipboard, toastActionFailed } from "@/lib/utils";
import { confirmDialog } from "@/lib/confirm";
import {
  mcpSetHttpsEnabled,
  mcpTlsCaStatus,
  mcpTlsInstallCa,
  mcpTlsRemoveCa,
  type McpStatus,
  type McpTlsCaStatus,
} from "@/lib/api/mcp";
import styles from "../Settings.module.css";

export function McpHttpsPanel({
  status,
  onRefresh,
  toast,
}: {
  status: McpStatus;
  /** 改完 HTTPS 开关后要让外层刷一次 McpStatus。 */
  onRefresh: () => Promise<void>;
  toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [ca, setCa] = useState<McpTlsCaStatus | null>(null);
  const [httpsErrDismissed, setHttpsErrDismissed] = useState(false);

  const refreshCa = useCallback(async () => {
    const s = await mcpTlsCaStatus();
    setCa(s);
  }, []);

  // 面板挂载时查一次 CA；证书是否生成取决于是否开过 HTTPS
  useEffect(() => {
    void refreshCa();
  }, [refreshCa, status.httpsRunning]);

  // httpsError 变了就重新露出横幅（用户点过「知道了」也不该永久吞掉新错误）
  const httpsError = status.httpsError || "";
  useEffect(() => {
    setHttpsErrDismissed(false);
  }, [httpsError]);

  const handleToggleHttps = useCallback(
    async (next: boolean) => {
      setBusy(true);
      const err = await mcpSetHttpsEnabled(next);
      if (err) {
        // 配置可能已写成功、只是监听没起来——status 会带上 httpsError，
        // 这里只在「配置都写失败」时 toast，监听失败由横幅承担（#15.3）。
        toastActionFailed(next ? "开启 HTTPS" : "关闭 HTTPS", err);
      } else {
        await refreshCa();
      }
      await onRefresh();
      setBusy(false);
    },
    [onRefresh, refreshCa],
  );

  const handleInstallCa = useCallback(async () => {
    if (!ca?.caPath) return;
    const ok = await confirmDialog({
      title: "把本机 CA 装进系统信任库？",
      message:
        "将向「当前用户」的信任根证书库添加一张本机生成的根证书。\n\n" +
        "• 不需要管理员权限\n" +
        "• 证书只对 127.0.0.1 / localhost / ::1 有效\n" +
        "• 用于让 MCP 客户端信任本机 HTTPS 地址\n" +
        "• 可随时点「从信任库移除」卸掉\n\n" +
        `文件位置：\n${ca.caPath}`,
      confirmText: "装进信任库",
    });
    if (!ok) return;
    setBusy(true);
    const s = await mcpTlsInstallCa();
    if (s) {
      setCa(s);
      toast("CA 已装入当前用户信任库", "success");
    }
    setBusy(false);
  }, [ca?.caPath, toast]);

  const handleRemoveCa = useCallback(async () => {
    const ok = await confirmDialog({
      title: "从信任库移除本机 CA？",
      message:
        "将从「当前用户」的信任根证书库移除 PastePanda 的本机 CA。\n\n" +
        "• 已配好 https 的 MCP 客户端会重新报「证书不受信」警告\n" +
        "• 本地证书文件不会删除，下次仍可重新装入\n" +
        "• 不需要管理员权限",
      confirmText: "移除 CA",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(true);
    const s = await mcpTlsRemoveCa();
    if (s) {
      setCa(s);
      toast("CA 已从信任库移除", "success");
    }
    setBusy(false);
  }, [toast]);

  const httpsOn = status.httpsRunning;
  const caInstalled = !!ca?.installed;
  const caGenerated = !!ca?.generated;

  return (
    <div className={styles.mcpRows} style={{ marginTop: 12 }}>
      <div className={styles.mcpSectionLabel}>HTTPS（可选，默认关）</div>

      <div className={styles.mcpRow}>
        <span className={styles.mcpLabel} style={{ width: 72 }}>
          开启 HTTPS
        </span>
        <button
          type="button"
          className={`${styles.mcpSwitch}${httpsOn ? ` ${styles.mcpSwitchOn}` : ""}`}
          role="switch"
          aria-checked={httpsOn}
          aria-label="HTTPS 开关"
          disabled={busy}
          onClick={() => void handleToggleHttps(!httpsOn)}
        />
        <span
          className={
            httpsOn
              ? styles.mcpPillOk
              : status.httpsError
                ? styles.mcpPillWarn
                : styles.mcpPillMute
          }
        >
          {httpsOn
            ? `HTTPS 监听中 · ${status.httpsPort}`
            : status.httpsError
              ? "HTTPS 未监听"
              : "未开启"}
        </span>
      </div>

      <div className={styles.mcpRow}>
        <span className={styles.mcpLabel} style={{ width: 72 }}>
          HTTPS 地址
        </span>
        <code
          className={styles.mcpValue}
          style={!httpsOn ? { opacity: 0.5 } : undefined}
        >
          {status.httpsUrl || "—"}
        </code>
        <button
          type="button"
          className={styles.mcpIconBtn}
          title="复制 HTTPS 地址"
          disabled={!status.httpsUrl}
          onClick={async () => {
            const ok = await copyToClipboard(status.httpsUrl);
            toast(ok ? "HTTPS 地址已复制" : "复制失败", ok ? "success" : "error");
          }}
        >
          复制
        </button>
      </div>

      <div className={styles.mcpRow}>
        <span className={styles.mcpLabel} style={{ width: 72 }}>
          信任库 CA
        </span>
        {ca === null ? (
          <span className={styles.mcpPillMute}>读取中…</span>
        ) : caInstalled ? (
          <>
            <span className={styles.mcpPillOk}>已装入信任库</span>
            <button
              type="button"
              className={styles.mcpApplyBtn}
              disabled={busy}
              onClick={() => void handleRemoveCa()}
            >
              从信任库移除
            </button>
          </>
        ) : (
          <>
            <span className={caGenerated ? styles.mcpPillWarn : styles.mcpPillMute}>
              {caGenerated ? "未装入信任库" : "证书未生成"}
            </span>
            <button
              type="button"
              className={styles.mcpApplyBtn}
              disabled={busy || !caGenerated}
              title={
                caGenerated
                  ? "把本机 CA 装进当前用户信任库"
                  : "先打开 HTTPS 开关以生成证书"
              }
              onClick={() => void handleInstallCa()}
            >
              装进信任库
            </button>
          </>
        )}
      </div>

      {!httpsOn && !status.httpsError && (
        <div className={styles.mcpHint}>
          打开后会自动生成本机证书。客户端仍会因「不受信」警告，需再点「装进信任库」。
        </div>
      )}

      {/* 🔴 监听失败必须就地可见（#15.3）：toast 会飘走，而端口被占是持续状态 */}
      {status.httpsError && !httpsErrDismissed && (
        <div className={styles.mcpAlert} style={{ marginTop: 8 }}>
          <span>{status.httpsError}</span>
          <button type="button" onClick={() => setHttpsErrDismissed(true)}>
            知道了
          </button>
        </div>
      )}
    </div>
  );
}
