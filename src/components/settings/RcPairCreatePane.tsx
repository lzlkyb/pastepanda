import { useEffect, useRef, useState } from "react";
import { formatDuration } from "@/lib/rcSessionStats";
import type { ToastFn } from "@/components/Toast";
import { RcCredTag } from "./RcCredTag";
import { RcPairDigest } from "./RcPairDigest";
import { FpBox } from "./RcPairFpBox";
import styles from "../rc/RemoteComputer.module.css";

/** 「生成邀请码」一侧：展示本机指纹 + 设备名输入 + 复制。受控展示，状态在父组件。 */
export function RcPairCreatePane({ name, setName, created, expiresAt, now, busy, myFp, selfName, toast, onBack, revealed, onReveal }: {
  name: string;
  setName: (v: string) => void;
  created: string | null;
  expiresAt: number;
  now: number;
  busy: boolean;
  myFp: string;
  selfName: string;
  toast: ToastFn;
  onGenerate: () => void;
  onBack: () => void;
  /** 凭证是否已亮出（设计稿 §2：默认遮罩，二维码与接入串都不留明文）。 */
  revealed: boolean;
  onReveal: () => void;
}) {
  const remain = expiresAt > 0 ? Math.max(0, expiresAt - now) : 0;

  /* 二维码（手机扫）：与 `QRCodeDialog` 同一条渲染路径（动态 import + toCanvas），
     不引第二个实现。码本身只有 50+ 字符，M 级纠错下画布 200px 足够手机近扫。
     `qrState` 三态：画布没画完 / 画好了 / 画失败——失败要给一句人话，
     不能让屏幕上留一块空白让用户以为代码坏了。 */
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [qrState, setQrState] = useState<"pending" | "ok" | "failed">("pending");
  useEffect(() => {
    if (!created) return;
    let cancelled = false;
    setQrState("pending");
    void import("qrcode")
      .then((QRCode) =>
        // 不传 color：默认就用黑模块 + 白底，主题再深也不影响扫
        QRCode.toCanvas(canvasRef.current, created, {
          width: 200,
          margin: 2,
          errorCorrectionLevel: "M",
        }),
      )
      .then(() => {
        if (!cancelled) setQrState("ok");
      })
      .catch(() => {
        if (!cancelled) setQrState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [created]);
  return (
    <>
      <RcCredTag tone="pair" label="长期配对码" note="配对一次，以后随时直接连" />
      <div className={styles.pairPane}>
        <FpBox label="本机指纹（对方核对用）" fp={myFp} name={name || selfName || ""} />
        <div className={styles.fpBox}>
          <div className={styles.fpLabel}>设备名（对方列表里显示）</div>
          <input
            style={{
              width: "100%",
              marginTop: 4,
              font: "inherit",
              fontSize: 12,
              padding: "6px 8px",
              borderRadius: 6,
              border: "1px solid var(--border-color, #e3e6ea)",
              background: "var(--card-bg, #fff)",
              color: "var(--text-primary)",
            }}
            placeholder="例如：办公室台式机"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {created && (
            <div className={styles.noteWarn} style={{ marginTop: 10, flexDirection: "column", alignItems: "stretch" }}>
              <div>
                配对码已生成，发给对方粘贴后，对方那台会弹出确认（带你的指纹）。
                {remain > 0 && (
                  <>
                    {" "}
                    剩余 <b>{formatDuration(remain)}</b>
                  </>
                )}
              </div>
              <textarea
                readOnly
                className={`${styles.inviteCode} ${revealed ? "" : styles.inviteCodeMasked}`}
                value={created}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="长期配对码"
                tabIndex={revealed ? 0 : -1}
              />
              <button
                type="button"
                className={styles.miniBtn}
                style={{ alignSelf: "flex-start", marginTop: 6 }}
                disabled={!revealed}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(created);
                    toast("配对码已复制", "success");
                  } catch {
                    toast("复制失败，请手动选中上方文本复制", "error");
                  }
                }}
              >
                复制配对码
              </button>
              <div className={styles.pairQrWrap}>
                {revealed ? (
                  <>
                    <div className={styles.foot}>
                      手机在这台电脑旁边？用相机或本应用「扫一扫」扫下面这个码，就不用搬字符串了。
                    </div>
                    {qrState === "failed" && (
                      <div className={styles.foot}>
                        二维码没画出来——不影响配对，用上面的「复制配对码」把码发给对方即可。
                      </div>
                    )}
                  </>
                ) : (
                  <div className={styles.foot}>
                    二维码与接入串默认收起。点下面的「出示」才生成并亮 60 秒——这份凭证<strong>照抄即全部</strong>，
                    比 8 位码更要紧，所以遮罩比那边更严。
                  </div>
                )}
                <canvas
                  ref={canvasRef}
                  aria-label="配对码二维码"
                  className={styles.pairQr}
                  data-ready={revealed && qrState === "ok" ? 1 : 0}
                />
              </div>
            </div>
          )}
        </div>
      </div>
      {created && revealed && <RcPairDigest tone="show" code={created} />}
      {/* 未亮出时主按钮是「出示」：点它才生成凭证；已生成过就直接亮。 */}
      {revealed ? (
        <div className={styles.foot}>
          亮码 60 秒后自动收起（会话与有效期都不动）。有效期 {formatDuration(Math.max(0, expiresAt - now))}，
          到点整份作废——<strong>不提供续期</strong>，重新出示会得到一份新凭证。
        </div>
      ) : (
        <button
          type="button"
          className={styles.miniBtnPri}
          disabled={busy}
          onClick={() => void onReveal()}
        >
          出示（生成凭证）
        </button>
      )}
      <button type="button" className={styles.miniBtn} onClick={onBack}>
        返回
      </button>
    </>
  );
}
