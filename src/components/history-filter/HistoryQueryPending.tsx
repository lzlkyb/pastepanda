import { useEffect, useState } from "react";
import { useInterfaceMotion } from "@/components/MotionPolicy";
import styles from "./HistoryFilterStatus.module.css";

export function HistoryQueryPending({ queryKey }: { queryKey: string }) {
  const mode = useInterfaceMotion();
  const [shownKey, setShownKey] = useState<string | null>(null);
  useEffect(() => {
    if (mode === "hidden") return;
    const timer = window.setTimeout(() => setShownKey(queryKey), 1000);
    return () => window.clearTimeout(timer);
  }, [queryKey, mode]);
  return <div className={styles.pending} role="status" aria-live="polite">
    {shownKey === queryKey && mode !== "hidden" && <><b>正在筛选记录…</b><span>读取完成后显示新结果</span></>}
  </div>;
}
