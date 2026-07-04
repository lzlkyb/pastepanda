import { useState, useEffect, useCallback } from "react";
import { useLenisRef, useScrollRef } from "@/contexts/ScrollContext";
import styles from "./BackToTop.module.css";

interface BackToTopProps {
  /** 滚动超过多少 px 时显示，默认 150 */
  threshold?: number;
}

export function BackToTop({ threshold = 150 }: BackToTopProps) {
  const lenisRef = useLenisRef();
  const scrollRef = useScrollRef();
  const [visible, setVisible] = useState(false);

  // 监听原生 scroll 事件（CardList 的 Lenis scroll 回调中同步了 wrapper.scrollTop 并派发了原生 scroll 事件）
  useEffect(() => {
    const el = scrollRef?.current;
    if (!el) return;

    const handleScroll = () => {
      setVisible(el.scrollTop > threshold);
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    // 初始检测一次
    handleScroll();

    return () => el.removeEventListener("scroll", handleScroll);
  }, [scrollRef, threshold]);

  const scrollToTop = useCallback(() => {
    const lenis = lenisRef?.current;
    if (lenis) {
      lenis.scrollTo(0, { lerp: 0.1, duration: 1.0 });
    }
  }, [lenisRef]);

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
