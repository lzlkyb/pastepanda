/**
 * RcAdhocCodePane — 「让别人帮我」那一屏（方案甲 · 被协助方）。
 *
 * 与长期配对的 `RcPairCreatePane` 差在**三处刻意的不一样**，所以没有复用：
 *
 * 1. **没有设备名输入框**。长期配对里那个框是有用的（名字进码、对方列表里显示），
 *    但这里要的是「一步出码」——名字直接用本机 `identity.device_name`，
 *    用户不用为了被帮一次先想做叫什么名字。
 * 2. **没有本机指纹框**。那个框存在的唯一理由是「让对方念出来互相比对」，
 *    而在一次性协助里，把关的确认发生在**对方那台**（他点头才连得上），
 *    本机不需要出示指纹。摆着只会让人以为还要念一串。
 * 3. **码用大字**。它要被对方抄进「帮别人连一次」，11px 读 65 个字符容易抄错。
 *
 * 唯一真源说明：剩余时间由父组件每秒推进的 `now` 与后端 `expires_at` 算出，
 * 不在本文件里跑计时器（一屏一个 interval，关掉就漏）。
 */
import type { ToastFn } from "@/components/Toast";
import { RcCredTag } from "./RcCredTag";
import styles from "../rc/RemoteComputer.module.css";

/** 码的寿命读法用**分钟**：这是给人看的「还能用多久」，不是倒计时的秒表。 */
function remainText(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "已过期，请重新生成";
  const min = Math.ceil(ms / 60_000);
  return min <= 1 ? "不足 1 分钟" : `约 ${min} 分钟`;
}

export function RcAdhocCodePane({
  code,
  expiresAt,
  now,
  busy,
  error,
  toast,
  onGenerate,
  onBack,
}: {
  /** 已生成的帮助码；null = 还没生成或生成失败。 */
  code: string | null;
  expiresAt: number;
  now: number;
  busy: boolean;
  /** 生成失败的原因（后端字符串），有值时显示在按钮上方。 */
  error: string;
  toast: ToastFn;
  onGenerate: () => void;
  onBack: () => void;
}) {
  return (
    <>
      <RcCredTag tone="help" label="一次性帮助码" note="双方都要在场" />
      {code ? (
        <>
          <div className={styles.noteWarn} style={{ flexDirection: "column", alignItems: "stretch" }}>
            <div>
              把这个码给对方。他粘贴即可连过来，<b>当场要你点确认</b>
              —— 这次之后他会<b>默认留在你的设备列表里</b>，不想留随时在列表删。
              {expiresAt > 0 && (
                <>
                  {" "}
                  剩余 <b>{remainText(expiresAt, now)}</b>
                </>
              )}
            </div>
            <textarea
              readOnly
              className={styles.inviteCode}
              style={{ fontSize: 14, letterSpacing: "0.06em", marginTop: 8 }}
              value={code}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="一次性帮助码"
            />
            <button
              type="button"
              className={styles.miniBtn}
              style={{ alignSelf: "flex-start", marginTop: 6 }}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(code);
                  toast("帮助码已复制，发给帮你的人", "success");
                } catch {
                  toast("复制失败，请手动选中上方文本复制", "error");
                }
              }}
            >
              复制并发送给对方
            </button>
          </div>
          <div className={styles.foot}>
            对方同意后你会在<b>主窗口横幅</b>上看到「正在被 … 远程」；任何时候点「立即结束」。
          </div>
        </>
      ) : (
        <>
          <div className={styles.foot}>
            生成一串只对这一次有效的帮助码，发给帮你的人；他连过来时你仍会收到确认。
          </div>
          {error && <div className={styles.noteBad}>{error}</div>}
          <button
            type="button"
            className={styles.miniBtnPri}
            disabled={busy}
            onClick={() => void onGenerate()}
          >
            {busy ? "生成中…" : "生成帮助码"}
          </button>
        </>
      )}
      <button type="button" className={styles.miniBtn} onClick={onBack}>
        返回
      </button>
    </>
  );
}
