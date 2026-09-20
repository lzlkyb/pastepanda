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
 * 设备选择状态是**本页局部**的：用户点设备卡片「传文件」时由 `initialPeer` 带进来，
 * 用户在本页里换设备不回写外层——外层没有「当前文件设备」这个概念，硬造一个
 * 只会多一处可能与真实状态不同步的地方。
 */
import { useEffect, useState } from "react";
import { Monitor } from "lucide-react";
import { fingerprintOf } from "@/lib/fingerprint";
import { RcFilePanel } from "./RcFilePanel";
import type { UseRc } from "@/hooks/useRc";
import styles from "./RemoteComputer.module.css";

export function RcPageFiles({
  rc,
  initialPeer,
}: {
  rc: UseRc;
  /** 设备卡片「传文件」带进来的目标；null = 让用户在本页里挑。 */
  initialPeer?: string | null;
}) {
  const targets = rc.targets;
  const [sel, setSel] = useState<string>("");

  useEffect(() => {
    if (initialPeer) setSel(initialPeer);
  }, [initialPeer]);

  // 没有选中（或选中的设备已不在列表）时，落到第一台**在线**的设备上：
  // 用户进这一页的意图就是要传东西，多一步「先选设备」是白加的摩擦。
  const active =
    (sel && targets.some((t) => t.node_id === sel) ? sel : "") ||
    (targets.find((t) => t.presence === "live") ?? targets[0])?.node_id ||
    "";

  if (targets.length === 0) {
    return (
      <div className={styles.filePage}>
        <div className={styles.fileEmpty}>
          还没有配对的设备。文件传输要求两台机器已远程配对（与知识库同步配对无关）——
          不配对就能往你机器上写文件，那不是功能，那是漏洞。
          <br />
          先到「设备列表」或左侧「配对设备」完成一次配对。
        </div>
      </div>
    );
  }

  const cur = targets.find((t) => t.node_id === active);

  return (
    <div className={styles.filePage}>
      <div className={styles.fileTargets} aria-label="选择目标设备">
        {targets.map((t) => {
          const name = t.note?.trim() || t.name?.trim() || fingerprintOf(t.node_id);
          const on = t.node_id === active;
          return (
            <button
              key={t.node_id}
              type="button"
              className={on ? `${styles.fileTarget} ${styles.fileTargetOn}` : styles.fileTarget}
              title={`${name} · ${fingerprintOf(t.node_id)}${t.denied ? "（已禁止远程本机）" : ""}`}
              onClick={() => setSel(t.node_id)}
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

      {cur && (
        <RcFilePanel
          peer={cur.node_id}
          /* 备注名优先，与设备列表同一口径 */
          peerName={cur.note?.trim() || cur.name?.trim() || fingerprintOf(cur.node_id)}
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
