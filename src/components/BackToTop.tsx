import { useState, useEffect, useCallback } from "react";
import { useScrollRef } from "@/contexts/ScrollContext";
import styles from "./BackToTop.module.css";

interface BackToTopProps {
  /** 滚动超过多少 px 时显示，默认 150 */
  threshold?: number;
}

export function BackToTop({ threshold = 150 }: BackToTopProps) {
  const scrollRef = useScrollRef();
  const [visible, setVisible] = useState(false);

  const handleScroll = useCallback(() => {
    const el = scrollRef?.current;
    if (!el) return;
    setVisible(el.scrollTop > threshold);
  }, [scrollRef, threshold]);

  useEffect(() => {
    const el = scrollRef?.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => el.removeEventListener("scroll", handleScroll);
  }, [scrollRef, handleScroll]);

  const scrollToTop = useCallback(() => {
    scrollRef?.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [scrollRef]);

  return (
    <button
      className={`${styles.btn} ${visible ? styles.visible : ""}`}
      onClick={scrollToTop}
      title="回到顶部"
      aria-label="回到顶部"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="18 15 12 9 6 15" />
      </svg>
      顶部
    </button>
  );
}
