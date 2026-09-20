/**
 * RcStage — 「远程电脑」页主区的四态分派（从 RcWorkbench 抽出，2026-09-19）。
 *
 * 抽的原因：v4 布局给 RcWorkbench 加了导航态 + 顶栏 + 三页分派，原文件 296 行
 * 已贴红线（.tsx ≤ 300）。四态判据本身在 `lib/rcWorkbench`（纯函数），这里只做
 * 「按态渲染」；被控时补刷 trusted 的副作用也搬进来——它与 RcInboundView 同生共死。
 *
 * 空态 / 等待态的视觉按 v4 稿 hero 化：等待态不再是一行孤字，而是显示器插画 +
 * 一句话 + 小贴士（数据不变，纯表现层）。
 */
import { useEffect, useMemo } from "react";
import { MonitorUp, Lightbulb } from "lucide-react";
import { fingerprintOf } from "@/lib/fingerprint";
import type { UseRc } from "@/hooks/useRc";
import { useRcLaunch } from "@/hooks/useRcLaunch";
import { useRcTrustEnable } from "@/hooks/useRcTrustEnable";
import { useToast } from "@/components/Toast";
import { explainRcError } from "@/lib/rcDeny";
import { RcSessionView } from "./RcSessionView";
import { RcPendingWait } from "./RcPendingWait";
import { RcErrorPanel } from "./RcErrorPanel";
import { RcEmptyGuide } from "./RcEmptyGuide";
import { RcInboundView } from "./RcInboundView";
import { workbenchMainMode } from "@/lib/rcWorkbench";
import styles from "./RemoteComputer.module.css";

export function RcStage({
  rc,
  cap,
  lastAttempt,
  doRequest,
  onPair,
  onHelpMe,
  onHelpOther,
  onUnoJoin,
}: {
  rc: UseRc;
  /** 发起链路的记忆档（useRcLaunch 返回）——见该 hook。 */
  cap: ReturnType<typeof useRcLaunch>["cap"];
  lastAttempt: ReturnType<typeof useRcLaunch>["lastAttempt"];
  doRequest: ReturnType<typeof useRcLaunch>["doRequest"];
  /** 空态引导的入口（配对 / 方案甲两条 / Q2 接入码直连），弹层由 RcPairLayer 挂。 */
  onPair: () => void;
  onHelpMe: () => void;
  onHelpOther: () => void;
  onUnoJoin: () => void;
}) {
  const { toast } = useToast();
  const enableTrust = useRcTrustEnable(rc, toast);

  const session = rc.status?.session ?? null;
  const mode = workbenchMainMode(rc.status);
  const inbound = mode === "inbound";
  const rcEnabledSelf = rc.status?.enabled ?? false;
  const hasTargets = rc.targets.length > 0;

  const pendingName = useMemo(() => {
    if (!session) return "";
    return (
      session.peer_name ||
      rc.targets.find((t) => t.node_id === session.peer)?.name ||
      fingerprintOf(session.peer)
    );
  }, [session, rc.targets]);

  // 被控视图要显示「这台设备是否已免确认」，而 trusted 在 rc_devices 行上、`rc_status`
  // 不带它。工作台的 rcStore 是**另一个实例**（主窗 RcOverlay 那次 refresh 到不了这里），
  // 所以被控开始时要自己补一次；拿不到按「未开」处理（点了只是重复置真，无害）。
  const refreshTargets = rc.refreshTargets;
  const inboundPeer = inbound ? session?.peer : null;
  useEffect(() => {
    if (inbound) void refreshTargets();
  }, [inbound, inboundPeer, refreshTargets]);

  const peerTarget = rc.targets.find((t) => t.node_id === session?.peer);
  const peerTrusted = peerTarget?.trusted ?? false;
  const peerDenied = peerTarget?.denied ?? false;

  // B2：重试按钮只给「再点一次可能成功」的错误——busy/timeout/offline 类重试
  // 有意义；disabled / device_denied / not_paired / capability 的 hint 已指明
  // 要去改设置/配对，给重试就是假按钮（点了必然原样再失败）。
  const retryable =
    rc.error != null &&
    ["busy", "timeout", "offline"].includes(explainRcError(rc.error).kind);

  return (
    <main className={styles.wbMain}>
      {rc.error && (
        <RcErrorPanel
          error={rc.error}
          onRetry={
            rc.isOpError
              ? retryable && lastAttempt
                ? () => void doRequest(lastAttempt, cap)
                : undefined
              : () => void rc.refresh()
          }
          onDismiss={() => rc.clearError()}
        />
      )}
      {inbound && session ? (
        <RcInboundView
          session={session}
          busy={rc.busy}
          trusted={peerTrusted}
          onTrust={
            peerDenied
              ? undefined
              : () =>
                  void enableTrust(
                    session.peer,
                    session.peer_name || fingerprintOf(session.peer),
                  )
          }
          quality={rc.status?.quality ?? "auto"}
          activeQuality={rc.status?.active_quality}
          captureScope={rc.status?.capture_scope ?? "virtual"}
          scopeNotice={rc.scopeNotice}
          onDismissScopeNotice={rc.clearScopeNotice}
          onEnd={() => {
            void rc.end().then((ok) => {
              if (ok) toast("已结束远程会话", "success");
            });
          }}
        />
      ) : mode === "outbound" && session ? (
        <RcSessionView
          session={session}
          busy={rc.busy}
          onEnd={() => void rc.end()}
          onReconnect={async () => {
            await rc.end();
            await doRequest(session.peer, session.capability);
          }}
          /** B-1 会话内提权：重新协商式（结束 + 重新申请「可控」）。 */
          onRequestControl={async () => {
            await rc.end();
            await doRequest(session.peer, "control");
          }}
          rc={rc}
          quality={rc.status?.quality ?? "auto"}
          captureScope={rc.status?.capture_scope ?? "virtual"}
        />
      ) : mode === "pending" && session ? (
        <RcPendingWait
          peerName={pendingName}
          capability={session.capability}
          startedMs={session.started_ms}
          busy={rc.busy}
          onCancel={() => void rc.cancel()}
          /** 等待态改档零成本——作废重发，对端只看到一次新敲门。 */
          onRaise={
            session.capability !== "control"
              ? async () => {
                  await rc.cancel();
                  await doRequest(session.peer, "control");
                }
              : undefined
          }
        />
      ) : (
        !rc.error &&
        (hasTargets ? (
          // v4 hero：等待连接不再是一行孤字。数据与原 wbIdle 完全一致，纯表现层。
          <div className={styles.wbHero}>
            <span className={styles.heroMonitor} aria-hidden="true">
              {/* v5：呼吸辉光（opacity）+ 高光游移（transform）——都是合成器层，
                  替代 v4 的 box-shadow 扩散动画（性能预算 F 节落地纪律①） */}
              <span className={styles.heroGlow} />
              <span className={styles.heroSheen} />
              <MonitorUp size={46} strokeWidth={1.6} />
            </span>
            <span className={styles.heroShadow} aria-hidden="true" />
            <div className={styles.heroTitle}>正在等待远程会话连接</div>
            <div className={styles.heroLead}>
              在左侧选择一台设备发起远程；或保持「允许被远程」开启，等待对方申请接入。
            </div>
            <div className={styles.heroTip}>
              <Lightbulb size={14} aria-hidden="true" />
              <span>
                小贴士：选择合适画质可获得更好的远程体验，弱网环境建议「流畅」。
              </span>
            </div>
          </div>
        ) : (
          // 空态的教学内容放主区：三步并排要有横向空间，侧栏那 272px 放不下
          // （见 RcEmptyGuide 顶部说明）。
          <div className={styles.wbEmptyWrap}>
            {/* 1A 的「先打开允许被远程」提示条就在这里失效过：组件默认
                selfEnabled=true，而调用方一直没传，于是那条 orange 提示从来没有
                渲染出来过（tsc / vitest 都看不见这种漏传）。这里把两个入参补齐。 */}
            <RcEmptyGuide
              onPair={onPair}
              onHelpMe={onHelpMe}
              onHelpOther={onHelpOther}
              onUnoJoin={onUnoJoin}
              selfEnabled={rcEnabledSelf}
              onEnableSelf={() => void rc.setEnabled(true)}
            />
          </div>
        ))
      )}
    </main>
  );
}
