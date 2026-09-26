import { formatDuration } from "@/lib/rcSessionStats";
import type { ToastFn } from "@/components/Toast";
import { RcCredTag } from "./RcCredTag";
import { FpBox } from "./RcPairFpBox";
import styles from "../rc/RemoteComputer.module.css";

/** 「生成邀请码」一侧：展示本机指纹 + 设备名输入 + 复制。受控展示，状态在父组件。 */
export function RcPairCreatePane({ name, setName, created, expiresAt, now, busy, myFp, selfName, toast, onGenerate, onBack }: {
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
}) {
  const remain = expiresAt > 0 ? Math.max(0, expiresAt - now) : 0;
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
                className={styles.inviteCode}
                value={created}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="长期配对码"
              />
              <button
                type="button"
                className={styles.miniBtn}
                style={{ alignSelf: "flex-start", marginTop: 6 }}
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
            </div>
          )}
        </div>
      </div>
      {!created ? (
        <button
          type="button"
          className={styles.miniBtnPri}
          disabled={busy}
          onClick={() => void onGenerate()}
        >
          生成并复制
        </button>
      ) : null}
      <button type="button" className={styles.miniBtn} onClick={onBack}>
        返回
      </button>
    </>
  );
}
