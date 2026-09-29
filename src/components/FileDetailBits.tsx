/**
 * FileDetailBits — 文件详情弹框的纯展示小组件（FileActionBtn / RowIconBtn / InfoRow）。
 *
 * 从 FileDetailDialog.tsx 提出：这些是被三个主体（单文件壳 / 预览面板 / 多文件列表）
 * 共用的按钮与信息行，本身零状态、零 IO。
 */
import type { ReactNode } from "react";

export function InfoRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
      <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0, minWidth: 60 }}>{label}</span>
      <span style={{
        fontSize: 12, color: "var(--text-primary)", textAlign: "right", wordBreak: "break-all",
        fontFamily: mono ? "'SF Mono', Consolas, monospace" : "inherit",
        lineHeight: 1.5,
      }}>{value}</span>
    </div>
  );
}

export function FileActionBtn({ icon, label, onClick, primary, disabled }: {
  icon: ReactNode; label: string; onClick: () => void; primary?: boolean; disabled?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8,
      border: primary ? "none" : "1px solid var(--border-color)",
      background: primary ? (disabled ? "var(--text-muted)" : "var(--accent)") : "var(--card-bg)",
      color: primary ? "var(--text-on-accent)" : (disabled ? "var(--text-muted)" : "var(--text-secondary)"),
      fontSize: 12, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer",
      fontFamily: "inherit", transition: "all 0.15s",
      boxShadow: primary && !disabled ? "0 2px 8px rgba(0,120,212,0.25)" : "none",
      opacity: disabled ? 0.5 : 1,
    }}>
      {icon}{label}
    </button>
  );
}

/** 文件行内的小型图标按钮 */
export function RowIconBtn({ title, onClick, disabled, children }: {
  title: string; onClick: (e: React.MouseEvent) => void; disabled?: boolean; children: ReactNode;
}) {
  return (
    <button title={title} onClick={onClick} disabled={disabled} style={{
      width: 26, height: 26, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
      border: "1px solid var(--border-color)", background: "var(--card-bg)",
      color: disabled ? "var(--text-muted)" : "var(--text-secondary)",
      cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1,
      transition: "all 0.15s",
    }}>
      {children}
    </button>
  );
}
