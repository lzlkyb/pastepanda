import { useState } from "react";
import type { KbJoinRequest } from "@/hooks/useKbSync";
import { fingerprintOf } from "@/lib/fingerprint";
import styles from "../Settings.module.css";

/**
 * 「有人拿着你发出的邀请在敲门」——生成方那一半的核对门。
 *
 * # 🔴 它补的是一个真实的断链
 *
 * 配对本来是**单边**的：只有粘贴方会写设备表，生成邀请码那一台
 * 从来不写自己的表，于是把对方每一次连接都当「未配对」拒掉。
 * 两台机器从来没连通过，而界面上写着「已配对 · 离线」。
 * 后端侧的完整说明在 `src-tauri/src/sync/join.rs` 模块注释。
 *
 * # 🔴 为何这里只有指纹、没有对方的设备名
 *
 * 设备名是**可自称**的，而指纹绑在已认证的连接身份上、伪造不了。
 * 一个可伪造的名字摆在核对框里只会分散注意力，甚至让人拿它当依据。
 * （同 `session.rs` 模块注释：「少一个可自称的字段，就少一处要交叉核对的地方」。）
 * 名字由**本机用户**在下面那个输入框里自己起。
 *
 * # 为何不做成弹框
 *
 * 它会在用户正在干别的事时突然盖上来，而这件事不紧急（对端会一直重试）。
 * 内嵌在面板里，配对向导的等待屏与设置页都能摆一份（同一个组件）。
 */
/**
 * 本组件要的那四个东西。单独导出是因为它要在**两处**渲染
 * （设置面板 + 配对向导的等待屏），而后者还隔着一层弹窗外壳，
 * 四个散装 props 穿两层很容易漏。
 */
export interface KbJoinProps {
  pending: KbJoinRequest[];
  busy: boolean;
  onApprove: (nodeId: string, name: string) => void | Promise<void>;
  onDeny: (nodeId: string) => void | Promise<void>;
}

export function KbJoinRequests({ pending, busy, onApprove, onDeny }: KbJoinProps) {
  /** 每条请求用户输的名字。不填也能提交（后端退到「新设备」）。 */
  const [names, setNames] = useState<Record<string, string>>({});

  if (pending.length === 0) return null;

  return (
    <div className={styles.kbPairWarn} style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>
        🔔 有 {pending.length} 台设备想连到这台
      </div>
      <div className={styles.kbPairNote} style={{ marginBottom: 10 }}>
        到<b>对方机器</b>上看一眼它的「本机指纹」，确认与下面这串一字不差再允许。
        <br />
        对不上就点拒绝——那意味着邀请码在路上被人换过。
      </div>

      {pending.map((r) => (
        <div key={r.node_id} className={styles.kbPairPeer} style={{ marginBottom: 8 }}>
          <div className={styles.kbPairNote} style={{ marginBottom: 4 }}>它的指纹</div>
          <div className={styles.kbPairFp} style={{ color: "var(--accent-strong)" }}>
            {fingerprintOf(r.node_id)}
          </div>

          {/* 名字由本机用户起，不是对方自报的——理由见文件头部。 */}
          <input
            className={styles.kbPairInput}
            style={{ marginTop: 8 }}
            placeholder="给它起个名字（例如：笔记本）——不填也行"
            value={names[r.node_id] ?? ""}
            onChange={(e) => setNames((m) => ({ ...m, [r.node_id]: e.target.value }))}
          />

          <div style={{ display: "flex", gap: 8, marginTop: 8, justifyContent: "flex-end" }}>
            <button className="btn-secondary" disabled={busy} onClick={() => void onDeny(r.node_id)}>
              不一样，拒绝
            </button>
            {/* 按钮文案把「你在确认什么」写进去：
                写「允许」的话，用户不看指纹直接点的概率大得多。 */}
            <button className="btn-primary" disabled={busy}
              onClick={() => void onApprove(r.node_id, names[r.node_id] ?? "")}>
              指纹一致，允许连接
            </button>
          </div>

          {/* 敲了很多次 = 对方一直在试，把这件事说出来，
              否则用户会以为自己错过了什么时机。 */}
          {r.tries > 1 && (
            <div className={styles.kbPairNote} style={{ marginTop: 6 }}>
              它已经试了 {r.tries} 次，你确认之前它会一直试下去。
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
