/**
 * RcWorkbenchErrorSlot — 工作台**页面态**（文件/历史/设置/详情）的错误条。
 * 2026-09-23 从 RcWorkbench 拆出（`.tsx ≤ 300` 红线，为入站申请条腾位）。
 *
 * 🔴 与 RcStage 顶部的 RcErrorPanel 分工：会话四态（session/pending/inbound）
 * 的错误由那边呈现，这里只服务页面态——两边同时挂会出两条一模一样的错误条。
 */
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDisplayName } from "@/lib/rcDevice";
import { rcErrorRetryable } from "@/lib/rcDeny";
import type { RcCapability, RcTargetDevice } from "@/lib/api/rc";
import { RcErrorPanel } from "./RcErrorPanel";
import styles from "./RemoteComputerA2.module.css";

export function RcWorkbenchErrorSlot({
  error,
  isOpError,
  lastAttempt,
  targets,
  capFor,
  onRequest,
  onRefresh,
  onDismiss,
}: {
  error: string;
  isOpError: boolean;
  lastAttempt: string | null;
  targets: RcTargetDevice[];
  capFor: (id: string) => RcCapability;
  onRequest: (id: string, c: RcCapability) => void;
  onRefresh: () => void;
  onDismiss: () => void;
}) {
  const retryable = isOpError && lastAttempt != null && rcErrorRetryable(error);
  return (
    <div className={styles.errorSlot} role="status">
      <RcErrorPanel
        error={error}
        onRetry={
          retryable
            ? /* U3：操作类错误里「再点一次可能成功」的，就地重连同一台同档 */
              () => onRequest(lastAttempt as string, capFor(lastAttempt))
            : isOpError
              ? undefined
              : onRefresh
        }
        retryLabel={
          retryable
            ? `重试连接「${
                rcDisplayName(
                  targets.find((t) => t.node_id === lastAttempt) ?? {},
                  fingerprintOf(lastAttempt as string),
                ) || fingerprintOf(lastAttempt as string)
              }」`
            : undefined
        }
        onDismiss={onDismiss}
      />
    </div>
  );
}
