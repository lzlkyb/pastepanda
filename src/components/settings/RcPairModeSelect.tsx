import styles from "../rc/RemoteComputer.module.css";

/** 第一屏：选哪一侧（生成 / 粘贴）+ 剪贴板里邀请码的「填入」提示。纯展示，无本地状态。 */
export function RcPairModeSelect({ clipInvite, onFill, onIgnore, onCreate, onPaste }: {
  clipInvite: string | null;
  onFill: (clip: string) => void;
  onIgnore: () => void;
  onCreate: () => void;
  onPaste: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {clipInvite && (
        <div className={styles.noteWarn} style={{ flexDirection: "column", alignItems: "stretch" }}>
          <div>检测到剪贴板里可能有一份远程邀请码，要填入吗？</div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className={styles.miniBtnPri}
              onClick={() => onFill(clipInvite)}
            >
              填入
            </button>
            <button
              type="button"
              className={styles.miniBtn}
              onClick={onIgnore}
            >
              忽略
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        className={styles.miniBtnPri}
        onClick={onCreate}
      >
        生成邀请码（给对方粘）
      </button>
      <button
        type="button"
        className={styles.miniBtn}
        onClick={onPaste}
      >
        粘贴对方的邀请码
      </button>
    </div>
  );
}
