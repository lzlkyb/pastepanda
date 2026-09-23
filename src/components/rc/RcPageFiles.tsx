/**
 * RcPageFiles — 工作台「文件传输」页（G6，B4 · 决策 8）。
 *
 * 这是竞品三范式里的**范式 A：独立文件会话**——「我只拿文件，不看你屏幕」。
 * 商业产品都有它，且被控方看到「对方是文件模式」比「对方在看我的屏」心理负担低。
 *
 * 对我们的架构来说它**本来就成立**：文件走独立 ALPN，与画面/会话解耦
 * （`rc/net.rs` 双 ALPN 分派）。缺的从来只是 UE —— 这一页就是那个 UE，
 * 不需要新建会话、不占会话位、对方屏幕上不会出现你的画面。
 *
 * 设备选择支持两种模式：旧壳由本页局部维护，A2 工作台则由常驻设备侧栏通过
 * `selectedPeer/onSelectPeer` 受控。A2 同时隐藏页内目标条，避免两套选择器互相打架。
 */
import { useEffect, useState } from "react";
import { Monitor } from "lucide-react";
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDisplayName } from "@/lib/rcDevice";
import { RcFilePanel } from "./RcFilePanel";
import type { UseRc } from "@/hooks/useRc";
import styles from "./RemoteComputer.module.css";

export function RcPageFiles({
  rc,
  initialPeer,
  selectedPeer,
  onSelectPeer,
  showTargetPicker = true,
}: {
  rc: UseRc;
  /** 设备卡片「传文件」带进来的目标；null = 让用户在本页里挑。 */
  initialPeer?: string | null;
  /** A2 工作台由常驻设备侧栏统一选目标，避免页面里再重复一套设备选择器。 */
  selectedPeer?: string | null;
  onSelectPeer?: (id: string) => void;
  showTargetPicker?: boolean;
}) {
  const targets = rc.targets;
  const [sel, setSel] = useState<string>("");

  useEffect(() => {
    if (initialPeer) setSel(initialPeer);
  }, [initialPeer]);

  // 没有选中（或选中的设备已不在列表）时，落到第一台**在线**的设备上：
  // 用户进这一页的意图就是要传东西，多一步「先选设备」是白加的摩擦。
  const requested = selectedPeer === undefined ? sel : (selectedPeer ?? "");
  const active =
    (requested && targets.some((t) => t.node_id === requested) ? requested : "") ||
    (targets.find((t) => t.presence === "live") ?? targets[0])?.node_id ||
    "";

  if (targets.length === 0) {
    return (
      <div className={styles.filePage}>
        <div className={styles.fileEmpty}>
          还没有可传文件的设备。
          <br />
          点击左侧「添加设备」完成配对；之后无需建立画面会话也能安全传文件。
        </div>
      </div>
    );
  }

  const cur = targets.find((t) => t.node_id === active);

  return (
    <div className={styles.filePage}>
      {showTargetPicker && (
        <div className={styles.fileTargets} aria-label="选择目标设备">
          {targets.map((t) => {
            const name = rcDisplayName(t, fingerprintOf(t.node_id));
            const on = t.node_id === active;
            return (
              <button
                key={t.node_id}
                type="button"
                className={on ? `${styles.fileTarget} ${styles.fileTargetOn}` : styles.fileTarget}
                title={`${name} · ${fingerprintOf(t.node_id)}${t.denied ? "（已禁止远程本机）" : ""}`}
                onClick={() => {
                  if (selectedPeer === undefined) setSel(t.node_id);
                  onSelectPeer?.(t.node_id);
                }}
              >
                <Monitor size={13} aria-hidden="true" />
                <span className={styles.fileTargetName}>{name}</span>
                <span
                  className={`${styles.fileTargetDot} ${t.presence === "live" ? styles.ftDotLive : ""}`}
                  aria-label={t.presence === "live" ? "在线" : "未确认在线"}
                />
                {t.denied && <span className={styles.fileTargetDeny}>已禁止本机</span>}
              </button>
            );
          })}
        </div>
      )}

      {cur && (
        <RcFilePanel
          peer={cur.node_id}
          /* 统一显示名（备注优先），与设备列表同一口径 */
          peerName={rcDisplayName(cur, fingerprintOf(cur.node_id))}
          showEmpty
        />
      )}

      <div className={styles.filePageNote}>
        传输与画面会话相互独立：不建立远程会话也能传，也不会让对方看到你的屏幕。
        每次接收都需要本机用户点「接受」，超时视为拒绝。
      </div>
    </div>
  );
}
