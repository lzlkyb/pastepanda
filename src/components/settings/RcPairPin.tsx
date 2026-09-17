/**
 * RcPairPin — 6 位数字核对屏（A3 局域网配对的第 3 步）。
 *
 * 设计稿：`design/远程电脑-配对流程重做-设计稿.html` §4.3。
 *
 * # 🔴 三条硬约束（设计稿原文，改之前先读）
 *
 * ① **数字要够大够疏**：它是逐位比对用的，做小了等于逼用户猜。
 *    尺寸（30px / 字距 9px / 700）来自 `Lan.module.css` 的 `.lanPairPin`，
 *    与知识库同步那边的配对核对**同一个类**——不新造数值。
 * ② **确认按钮不预选**：不能让人回车就过。所以 `autoFocus` 落在「取消」上。
 * ③ **文案直说「不一样就取消」**：不写这句，用户会以为两个按钮只是「再想想」。
 *
 * # 为什么两端各点一次
 *
 * 不是「确认对方的确认」，而是「我这边也核对过了」。这句解释是用户反馈的产物，
 * 从 `LanNearby.tsx` 照搬——少了它，发起方会觉得多一步。
 *
 * # 少了什么（与知识库同步那一版相比）
 *
 * 那边有一句「确认后本机会改用对方的配对密钥，之前配过的设备会断开」——
 * 那是**剪贴板同步只用一把配对密钥**才成立的话。远程电脑是**一串设备**、
 * 各授权各的，照搬过来就是错的，所以这里没有。
 */
import type { RcPairPrompt } from "@/lib/api/rcPair";
import lanStyles from "./Lan.module.css";

export function RcPairPin({ prompt, busy, onConfirm, onCancel }: {
  prompt: RcPairPrompt;
  busy: boolean;
  onConfirm: () => void;
  /** 取消这一轮配对。本端是被请求方时后端会顺带记一次「拒绝」。 */
  onCancel: () => void;
}) {
  const name = prompt.peer_name.trim() || "这台设备";
  const negotiating = prompt.pin === "";
  /** 已点过确认就在等对方，不让用户反复点（文案写清在等什么）。 */
  const done = prompt.me_ok;

  return (
    <div className={lanStyles.lanPairBox}>
      <div className={lanStyles.lanPairTitle}>与「{name}」配对</div>

      {negotiating ? (
        <div className={lanStyles.lanPairHint} style={{ padding: "12px 0" }}>
          正在与对方建立一次性加密信道（X25519），
          <br />
          然后各自算一串 6 位数字…
        </div>
      ) : (
        <>
          <div className={lanStyles.lanPairPin}>{prompt.pin}</div>
          <div className={lanStyles.lanPairHint}>
            确认<b>另一台设备</b>上显示的是同一串数字。
            <br />
            两台设备<b>各自都要确认一次</b>（谁先点都行）——
            <br />
            这串数字只有两边放在一起比才有意义。
            <br />
            两边不一样就点取消——那意味着有人在中间插足。
          </div>
        </>
      )}

      <div className={lanStyles.lanPairBtns}>
        {/* autoFocus 落在这里而不是「确认」上：见文件头约束 ②。
            回车走的是取消，不是放行。 */}
        <button
          type="button"
          className="btn-secondary"
          autoFocus
          disabled={busy}
          onClick={onCancel}
        >
          不一样，取消
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={busy || negotiating || done}
          onClick={onConfirm}
        >
          {done ? "已确认 · 等对方核对…" : "两边一样，确认"}
        </button>
      </div>
    </div>
  );
}
