import styles from "../rc/RemoteComputer.module.css";

/** 指纹卡：标题 + 指纹串（+ 可选设备名）。配对向导「create / paste」两侧复用。 */
export function FpBox({ label, fp, name, accent }: {
  label: string;
  fp: string;
  name?: string;
  accent?: boolean;
}) {
  return (
    <div className={styles.fpBox}>
      <div className={styles.fpLabel}>{label}</div>
      <div className={styles.fpVal} style={accent ? { color: "var(--accent, #4f7cff)" } : undefined}>
        {fp}
      </div>
      {name != null && (
        <>
          <div className={styles.fpLabel} style={{ marginTop: 8 }}>设备名</div>
          <div style={{ fontSize: 12, marginTop: 2 }}>{name || "（未填）"}</div>
        </>
      )}
    </div>
  );
}
