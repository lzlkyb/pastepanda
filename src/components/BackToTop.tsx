import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLenisRef } from "@/contexts/ScrollContext";
import { useAppStore } from "@/stores/appStore";
import type Lenis from "lenis";
import styles from "./BackToTop.module.css";

interface BackToTopProps {
  /** 滚动超过多少 px 时显示，默认 150 */
  threshold?: number;
}

export function BackToTop({ threshold = 150 }: BackToTopProps) {
  const lenisRef = useLenisRef();
  const theme = useAppStore((s) => s.config.theme);
  const [visible, setVisible] = useState(false);
  // 使用 ref 存储 threshold 避免 effect 因 threshold 变化重新订阅
  const thresholdRef = useRef(threshold);
  thresholdRef.current = threshold;
  // 保存当前的 rAF frame id：trySubscribe 是递归调度的，每次重新调度都必须更新它，
  // 否则 cleanup 只能 cancel 到第一次的 id，后续递归产生的 rAF 永远取消不掉
  const rafIdRef = useRef(0);

  useEffect(() => {
    // 轮询等待 Lenis 实例就绪（Lenis 在 CardList 的 useEffect 中异步创建）
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    const trySubscribe = () => {
      const lenis = lenisRef?.current;
      if (!lenis) {
        if (!cancelled) rafIdRef.current = requestAnimationFrame(trySubscribe);
        return;
      }
      // 拿到实例后先复查 cancelled：rAF 排队期间组件可能已卸载，不检查会订阅一个永远不会被清理的
      // scroll 监听，并对已卸载组件 setState
      if (cancelled) return;

      // Lenis scroll 事件回调
      const onScroll = ({ scroll }: Lenis) => {
        setVisible((prev) => {
          const should = scroll > thresholdRef.current;
          return prev !== should ? should : prev;
        });
      };

      unsubscribe = lenis.on("scroll", onScroll);
      // 立即检查初始状态
      setVisible(lenis.scroll > thresholdRef.current);
    };

    // 用 rAF 等待，因为 Lenis 实例在同一个微任务/宏任务中不会被 BackToTop 的 effect 先拿到
    rafIdRef.current = requestAnimationFrame(trySubscribe);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafIdRef.current);
      unsubscribe?.();
    };
  }, [lenisRef]);

  const scrollToTop = useCallback(() => {
    const lenis = lenisRef?.current;
    if (lenis) {
      lenis.scrollTo(0, { duration: 0.8 });
    }
  }, [lenisRef]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.button
          initial={{ opacity: 0, scale: 0.8, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.8, y: 10 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          className={styles.btn}
          onClick={scrollToTop}
          title="回到顶部"
          aria-label="回到顶部"
        >
          {theme === "blossom" ? (
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          )}
          顶部
        </motion.button>
      )}
    </AnimatePresence>
  );
}
