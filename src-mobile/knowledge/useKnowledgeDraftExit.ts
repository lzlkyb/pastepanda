import { useEffect, useRef, useState } from "react";
import { knowledgeErrorText } from "@/lib/utils";

/** Both editors must confirm durability before their navigation callback runs. */
export function useKnowledgeDraftExit(flush: () => Promise<unknown>, onBack: () => void) {
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const locked = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const leave = async () => {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    try { await flush(); if (mounted.current) { setError(null); onBack(); } }
    catch (cause) { if (mounted.current) setError(knowledgeErrorText(cause)); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  return { error, busy, leave: () => void leave(), cancel: () => { if (!locked.current) setError(null); } };
}
