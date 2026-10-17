import { useEffect, useState } from "react";
import type { RecHudData } from "@/lib/api/rec";
import { RecResultCard } from "./RecResultCard";
import styles from "./RecOffice.module.css";

export function RecMainResult() {
  const [data, setData] = useState<RecHudData | null>(null);
  useEffect(() => {
    const show = (event: Event) => setData((event as CustomEvent<RecHudData>).detail);
    window.addEventListener("rec-result", show);
    return () => window.removeEventListener("rec-result", show);
  }, []);
  return data ? (
    <div className={styles.mainResult}>
      <RecResultCard key={data.path ?? data.message} data={data} onClose={() => setData(null)} />
    </div>
  ) : null;
}
