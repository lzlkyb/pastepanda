/**
 * RcNetDiagCard — 侧栏「这台电脑」卡内的本机网络诊断折叠段（R0）。
 *
 * 判定与文案来自 `rcNetDiag`（Rust `punch_verdict` 收口，前端只显示不复算）。
 * 取数时机：**展开时才取**（折叠态零请求；每次展开重新取一份最新报告，
 * 规则 15.2：接受展开即重取，本组件无需要保活的草稿态）。
 * 观测含公网映射，仅本地显示——不写日志、不随任何遥测上传（红线②口径）。
 */
import { useCallback, useEffect, useState } from "react";
import { Activity, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import {
  mappingLabel,
  punchSummary,
  rcNetDiag,
  type NetDiagSnapshot,
  type PunchExpectation,
} from "@/lib/api/rcNetDiag";
import styles from "./RemoteComputerA2.module.css";

/** 判定 → 语义色（U6：只用语义令牌，见 css 里 data-tone）。 */
function toneOf(v: PunchExpectation): "ok" | "warn" | "neutral" {
  switch (v) {
    case "direct_likely":
      return "ok";
    case "relay_only":
    case "udp_blocked":
    case "captive":
      return "warn";
    default:
      return "neutral";
  }
}

export function RcNetDiagCard() {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<NetDiagSnapshot | null>(null);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const diag = await rcNetDiag();
      setSnapshot(diag.snapshot);
      setReason(diag.unavailable_reason);
    } finally {
      setLoading(false);
    }
  }, []);

  /* 展开即取最新报告；收起不清状态（重开展开再取，旧值仅作占位）。 */
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const verdict = snapshot?.verdict ?? "unknown";

  return (
    <div className={styles.netDiag}>
      <button
        type="button"
        className={styles.netDiagToggle}
        aria-expanded={open}
        aria-controls="rc-net-diag-body"
        onClick={() => setOpen(!open)}
      >
        <Activity size={13} aria-hidden="true" />
        网络诊断
        <span className={styles.netDiagBadge} data-tone={toneOf(verdict)}>
          {punchSummary(verdict)}
        </span>
        {open ? (
          <ChevronUp size={13} aria-hidden="true" />
        ) : (
          <ChevronDown size={13} aria-hidden="true" />
        )}
      </button>
      {open && (
        <div id="rc-net-diag-body" className={styles.netDiagBody}>
          {snapshot ? (
            <>
              <div className={styles.netDiagRow}>
                <span>直连判定</span>
                <strong>{punchSummary(snapshot.verdict)}</strong>
              </div>
              <div className={styles.netDiagRow}>
                <span>IPv4 映射</span>
                <strong>
                  {mappingLabel(snapshot.family_v4)}
                  {snapshot.family_v4.observed ? ` · ${snapshot.family_v4.observed}` : ""}
                </strong>
              </div>
              <div className={styles.netDiagRow}>
                <span>IPv6 映射</span>
                <strong>
                  {mappingLabel(snapshot.family_v6)}
                  {snapshot.family_v6.observed ? ` · ${snapshot.family_v6.observed}` : ""}
                </strong>
              </div>
              {snapshot.relay_latencies_ms.length > 0 && (
                <div className={styles.netDiagRow}>
                  <span>最快中继</span>
                  <strong className={styles.mono}>
                    {snapshot.relay_latencies_ms[0].ms} ms
                  </strong>
                </div>
              )}
              <p className={styles.netDiagNote}>
                判定来自 iroh 网络探测，只在本机显示。
                {snapshot.verdict === "relay_only" && "对称 NAT 下打洞失败会直接走中继。"}
              </p>
            </>
          ) : (
            <p className={styles.netDiagNote}>
              {reason ||
                "报告还没生成：开启远程电脑或知识库同步后数秒自动出现，或点下方「重新探测」"}
            </p>
          )}
          <button
            type="button"
            className={styles.netDiagRefresh}
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw size={12} aria-hidden="true" className={loading ? styles.netDiagSpin : ""} />
            {loading ? "探测中…" : "重新探测"}
          </button>
        </div>
      )}
    </div>
  );
}
