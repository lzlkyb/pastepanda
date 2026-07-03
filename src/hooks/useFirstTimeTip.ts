import { useCallback } from "react";

const STORAGE_KEY = "pasteship_shown_tips";

function getShownTips(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveShownTips(tips: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...tips]));
  } catch { /* ignore */ }
}

/**
 * 首次提示 Hook
 * 每个 tipId 的提示只显示一次，记录在 localStorage
 */
export function useFirstTimeTip() {
  const shouldShow = useCallback((tipId: string): boolean => {
    const shown = getShownTips();
    return !shown.has(tipId);
  }, []);

  const markShown = useCallback((tipId: string) => {
    const shown = getShownTips();
    shown.add(tipId);
    saveShownTips(shown);
  }, []);

  return { shouldShow, markShown };
}
