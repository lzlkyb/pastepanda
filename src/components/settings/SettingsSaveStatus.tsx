import { Check, TriangleAlert } from "lucide-react";
import type { SettingsSaveState } from "@/hooks/useSettingsSave";
import styles from "./SettingsSaveStatus.module.css";

export function SettingsSaveStatus({ state, onRetry }: { state: SettingsSaveState; onRetry: () => void }) {
  const label = { idle: "所有设置修改后自动保存", pending: "正在保存…", saved: "所有更改已保存", error: "保存未完成，失败项已还原" }[state];
  return <div className={styles.status} data-error={state === "error"}>
    <span role="status">{state === "saved" && <Check size={12} aria-hidden="true" />}
      {state === "error" && <TriangleAlert size={12} aria-hidden="true" />}{label}</span>
    {state === "error" && <button type="button" onClick={onRetry}>重新应用并保存</button>}
  </div>;
}
