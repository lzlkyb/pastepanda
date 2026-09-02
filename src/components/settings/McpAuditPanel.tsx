/**
 * MCP 调用记录（W3）。
 *
 * 🔴 红线②：使用日志永不出本机，且用户**可见可删**。
 * 这个面板就是「可见」，底下那个清空按钮就是「可删」——缺一个都不成立。
 *
 * 为什么要有它：在这之前，外部程序把你全部笔记读走也**一点痕迹都没有**；
 * 只有被拒绝的请求会进日志，而那个日志只存在于开发控制台。
 */
import { useCallback, useEffect, useState } from "react";
import { Trash2, AlertTriangle } from "lucide-react";
import { confirmDialog } from "@/lib/confirm";
import { useAppStore } from "@/stores/appStore";
import {
  mcpAuditList,
  mcpAuditClients,
  mcpAuditClear,
  type McpAuditRow,
  type McpClientRow,
} from "@/lib/api/mcp";
import styles from "../Settings.module.css";

/** 列表只拉这么多条。审计是拿来「看最近发生了什么」的，不是归档查询器。 */
const LIST_LIMIT = 100;

/** `at` 是 `YYYY-MM-DD HH:mm:ss.SSS`。只给到秒，毫秒在这里是噪声。 */
function shortTime(at: string): string {
  return at.slice(5, 19);
}

export function McpAuditPanel({
  auditError,
  onDismissError,
  toast,
}: {
  /** 非空 = 后端报过「审计写不下」。fail-open 下服务照常跑，但必须让用户看见 */
  auditError: string;
  onDismissError: () => void;
  toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void;
}) {
  const [rows, setRows] = useState<McpAuditRow[]>([]);
  const [clients, setClients] = useState<McpClientRow[]>([]);
  const [open, setOpen] = useState(false);
  const retainDays = useAppStore((s) => s.config.mcp_audit_days);

  const reload = useCallback(async () => {
    const [r, c] = await Promise.all([mcpAuditList(LIST_LIMIT), mcpAuditClients()]);
    setRows(r);
    setClients(c);
  }, []);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  const handleClear = useCallback(async () => {
    const ok = await confirmDialog({
      title: "清空调用记录？",
      message: `${rows.length} 条记录将被删除。这只删记录本身，不影响任何笔记。`,
      confirmText: "清空",
      variant: "warning",
    });
    if (!ok) return;
    const n = await mcpAuditClear();
    if (n === null) return;
    toast(`已清空 ${n} 条调用记录`, "success");
    await reload();
  }, [rows.length, reload, toast]);

  return (
    <div className={styles.mcpGuide}>
      {/* 审计断过必须看得见：静默地丢审计等于审计不可信，
          而不可信的审计比没有审计更糟。 */}
      {auditError && (
        <div className={styles.mcpAlert}>
          <AlertTriangle size={13} />
          <span>调用记录写入失败，期间的访问没被记下：{auditError}</span>
          <button type="button" onClick={onDismissError}>知道了</button>
        </div>
      )}

      <button type="button" className={styles.mcpGuideToggle} onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} 调用记录
      </button>

      {open && (
        <div className={styles.mcpGuideBody}>
          {/* ❗ 文案必须是「最近活动过」而不是「当前连着」——MCP over HTTP
              无状态，根本没有「连着」这回事，报连接数就是假的。 */}
          {clients.length > 0 && (
            <p className={styles.mcpGuideNote}>
              最近活动过的客户端：
              {clients.map((c) => (
                <span key={c.client} className={styles.mcpClientChip}>
                  {c.client || "（未报名）"} · {c.calls} 次
                </span>
              ))}
            </p>
          )}

          {rows.length === 0 ? (
            <p className={styles.mcpGuideNote}>还没有调用记录。</p>
          ) : (
            <>
              <ul className={styles.mcpAuditList}>
                {rows.map((r) => (
                  <li key={r.id} className={styles.mcpAuditRow}>
                    <span className={styles.mcpAuditTime}>{shortTime(r.at)}</span>
                    <code className={styles.mcpAuditTool}>{r.tool}</code>
                    <span className={styles.mcpAuditArgs} title={r.args}>{r.args}</span>
                    <span className={r.ok ? styles.mcpAuditHit : styles.mcpAuditFail}>
                      {r.ok ? `返回 ${r.hit_count} 篇` : "失败"}
                    </span>
                  </li>
                ))}
              </ul>
              <p className={styles.mcpGuideNote}>
                只记录调用本身与命中的笔记 id，<b>不保存笔记正文</b>。
                {retainDays > 0
                  ? `记录保留 ${retainDays} 天，到期自动清理。`
                  : "当前设为不自动清理，记录会一直累积。"}
              </p>
              <button type="button" className={styles.mcpAuditClear} onClick={() => void handleClear()}>
                <Trash2 size={12} /> 清空调用记录
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
