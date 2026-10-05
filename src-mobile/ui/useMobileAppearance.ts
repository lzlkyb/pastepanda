import { useEffect, useState } from "react";

export type MobileAppearance = "light" | "dark" | "system";
const KEY = "pastepanda-mobile-appearance";

export function useMobileAppearance() {
  const [appearance, setAppearance] = useState<MobileAppearance>(() => {
    try {
      const saved = localStorage.getItem(KEY);
      return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      document.documentElement.dataset.theme =
        appearance === "dark" || (appearance === "system" && media.matches) ? "midnight" : "ocean";
    };
    update();
    try {
      localStorage.setItem(KEY, appearance);
    } catch {
      /* 存储不可用时仍保留本次会话选择。 */
    }
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [appearance]);
  return { appearance, setAppearance };
}
