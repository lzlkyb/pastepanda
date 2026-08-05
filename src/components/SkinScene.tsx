/**
 * SkinScene — 皮肤场景层
 *
 * 为特定主题在窗口背景渲染"世界"氛围（美乐蒂爱心雨 / 深海光柱气泡 / 晨曦流云）。
 * 固定铺满视口、z-index: 0、pointer-events: none：
 * 衬在玻璃卡片（cardWrap z-index: 1）之后，透过半透明卡片可见，不干扰任何交互。
 * 粒子参数在挂载时随机生成一次（useMemo），之后仅跑 CSS 动画。
 *
 * 性能（原注释称“开销极小”，实测不成立，已修正）：
 * 本组件被四个窗口各挂一份（App / TrayPopup / QuickPastePanel / FullscreenEditor），
 * 而托盘弹窗与快捷面板关闭走的是 window.hide() 而非 close()，WebView 仍存活，
 * 动画会在看不见的窗口里继续跑——常态是 3 份并发。再叠上卡片/面板的
 * backdrop-filter（背后内容一变就得重新采样模糊），持续吃 GPU。
 * 故失焦时给场景根加 .paused 暂停整层，任一时刻最多一份在跑。
 */
import { useMemo, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "@/stores/appStore";
import melodyUrl from "@/assets/melody.png";
import styles from "./SkinScene.module.css";

const rnd = (n: number) => Math.random() * n;

export function SkinScene() {
  const theme = useAppStore((s) => s.config.theme);

  /**
   * 窗口不可见 / 失焦时暂停整层动画。
   * 初始值取 isVisible()（而非 isFocused）：主窗启动时可见但可能尚未获焦，
   * 若用 focus 作初值会让场景开局就是冻住的；而隐藏的托盘/快捷窗口 isVisible 为假，
   * 正好从一开始就不跑。之后由 onFocusChanged 驱动（获焦时必已可见）。
   */
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const w = getCurrentWindow();
        const visible = await w.isVisible();
        if (cancelled) return;
        setPaused(!visible);
        const un = await w.onFocusChanged(({ payload: focused }) => {
          if (!cancelled) setPaused(!focused);
        });
        // 异步注册期间可能已卸载（StrictMode 双调用），自行解绑避免泄漏
        if (cancelled) un();
        else unlisten = un;
      } catch {
        // 非 Tauri 环境（单测 / 浏览器预览）拿不到窗口 API，保持动画常开即可
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const sceneCls = paused ? `${styles.scene} ${styles.paused}` : styles.scene;

  // 美乐蒂爱心雨（14 → 10：粒子数直接决定常驻动画层数）
  const hearts = useMemo(
    () =>
      Array.from({ length: 10 }, () => ({
        left: rnd(100),
        size: 10 + rnd(12),
        dur: 8 + rnd(8),
        delay: -rnd(14),
        color: ["#FF7BAC", "#FFA5C6", "#FF6FA5", "#FF8BB4"][Math.floor(rnd(4))],
      })),
    []
  );
  // 美乐蒂蝴蝶结（粉 / 蝴蝶结淡蓝双色）
  const bows = useMemo(
    () =>
      Array.from({ length: 5 }, () => {
        const blue = Math.random() < 0.4;
        return {
          left: rnd(90),
          top: 10 + rnd(70),
          size: 20 + rnd(16),
          delay: -rnd(7),
          color: blue ? "#8FD5EF" : "#FF87B5",
          knot: blue ? "#5BB8DC" : "#F0568C",
        };
      }),
    []
  );
  // 美乐蒂星光（8 → 6）
  const sparks = useMemo(
    () =>
      Array.from({ length: 6 }, () => ({
        left: rnd(95),
        top: rnd(80),
        size: 6 + rnd(7),
        delay: -rnd(3),
        color: Math.random() < 0.6 ? "#FFD1E3" : "#CDEBF7",
      })),
    []
  );
  // 深海气泡（12 → 9）
  const bubbles = useMemo(
    () =>
      Array.from({ length: 9 }, () => ({
        left: rnd(100),
        size: 9 + rnd(22),
        dur: 8 + rnd(9),
        delay: -rnd(14),
        bottom: -20 - rnd(120),
      })),
    []
  );
  // 深海浮游生物（20 → 12）
  const plankton = useMemo(
    () =>
      Array.from({ length: 12 }, () => ({
        left: rnd(100),
        top: rnd(100),
        delay: -rnd(3),
      })),
    []
  );
  // 晨曦流云
  const clouds = useMemo(
    () =>
      Array.from({ length: 6 }, () => ({
        left: rnd(90),
        top: 40 + rnd(220),
        width: 150 + rnd(180),
        opacity: 0.5 + rnd(0.4),
        dur: 24 + rnd(18),
        delay: -rnd(30),
      })),
    []
  );
  // 海洋水面碎金（26 → 14）
  // 这 26 个点各自跑 opacity 闪烁，自身很便宜，但它们衬在所有卡片之下，
  // 每帧变化会持续使几十张卡片的 backdrop-filter 失效重算——海洋主题的主要开销在此。
  const glints = useMemo(
    () =>
      Array.from({ length: 14 }, () => ({
        left: rnd(100),
        top: 55 + rnd(38),
        delay: -rnd(3),
      })),
    []
  );
  // 午夜满天星（80 → 36：全项目最多的常驻动画元素）
  const stars = useMemo(
    () =>
      Array.from({ length: 36 }, () => ({
        left: rnd(100),
        top: rnd(68),
        size: Math.random() < 0.85 ? 2 : 3,
        delay: -rnd(4),
        opacity: 0.3 + rnd(0.7),
      })),
    []
  );
  // 森林落叶（10 → 8）
  const leaves = useMemo(
    () =>
      Array.from({ length: 8 }, () => ({
        left: rnd(100),
        dur: 8 + rnd(8),
        delay: -rnd(10),
      })),
    []
  );
  // 森林萤火虫（12 → 9）
  const flies = useMemo(
    () =>
      Array.from({ length: 9 }, () => ({
        left: 5 + rnd(90),
        top: 40 + rnd(50),
        delay: -rnd(7),
      })),
    []
  );

  if (theme === "blossom") {
    return (
      <div className={sceneCls} aria-hidden>
        <div className={styles.haze} style={{ top: "12%" }} />
        <div className={styles.haze} style={{ bottom: "6%", opacity: 0.6 }} />
        {hearts.map((h, i) => (
          <svg
            key={i}
            className={styles.melodyHeart}
            style={{ left: `${h.left}%`, width: h.size, animationDuration: `${h.dur}s`, animationDelay: `${h.delay}s` }}
            viewBox="0 0 24 24"
          >
            <path
              fill={h.color}
              d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
            />
          </svg>
        ))}
        {bows.map((b, i) => (
          <svg
            key={i}
            className={styles.melodyBow}
            style={{ left: `${b.left}%`, top: `${b.top}%`, width: b.size, animationDelay: `${b.delay}s` }}
            viewBox="0 0 48 30"
          >
            <path d="M24 15 C14 4, 3 6, 4 15 C3 24, 14 26, 24 15 Z" fill={b.color} />
            <path d="M24 15 C34 4, 45 6, 44 15 C45 24, 34 26, 24 15 Z" fill={b.color} />
            <circle cx="24" cy="15" r="4.5" fill={b.knot} />
          </svg>
        ))}
        {sparks.map((s, i) => (
          <svg
            key={i}
            className={styles.melodySpark}
            style={{ left: `${s.left}%`, top: `${s.top}%`, width: s.size, animationDelay: `${s.delay}s` }}
            viewBox="0 0 24 24"
          >
            <path fill={s.color} d="M12 0l2.5 9.5L24 12l-9.5 2.5L12 24l-2.5-9.5L0 12l9.5-2.5z" />
          </svg>
        ))}
        <img className={styles.melodyChar} src={melodyUrl} alt="" draggable={false} />
      </div>
    );
  }

  if (theme === "ocean-dark") {
    return (
      <div className={sceneCls} aria-hidden>
        <div className={styles.ray} style={{ left: "18%" }} />
        <div className={styles.ray} style={{ left: "46%", animationDelay: "-4s" }} />
        <div className={styles.ray} style={{ left: "72%", animationDelay: "-7s" }} />
        <svg
          className={styles.jelly}
          style={{ right: "8%", top: "12%" }}
          width="120"
          height="150"
          viewBox="0 0 120 150"
        >
          <defs>
            <radialGradient id="skinSceneJelly" cx="50%" cy="30%">
              <stop offset="0%" stopColor="rgba(150,238,255,0.9)" />
              <stop offset="100%" stopColor="rgba(80,160,255,0.04)" />
            </radialGradient>
          </defs>
          <ellipse cx="60" cy="42" rx="46" ry="36" fill="url(#skinSceneJelly)" />
          <path
            d="M30,66 q-6,36 -13,54 M48,74 q-2,40 -7,60 M62,76 q2,42 5,62 M78,72 q8,36 15,52 M92,60 q11,30 19,44"
            stroke="rgba(140,225,255,0.45)"
            strokeWidth="2.5"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
        {bubbles.map((b, i) => (
          <span
            key={i}
            className={styles.bubble}
            style={{
              left: `${b.left}%`,
              bottom: b.bottom,
              width: b.size,
              height: b.size,
              animationDuration: `${b.dur}s`,
              animationDelay: `${b.delay}s`,
            }}
          />
        ))}
        {plankton.map((p, i) => (
          <span
            key={i}
            className={styles.plankton}
            style={{ left: `${p.left}%`, top: `${p.top}%`, animationDelay: `${p.delay}s` }}
          />
        ))}
      </div>
    );
  }

  if (theme === "ocean") {
    return (
      <div className={sceneCls} aria-hidden>
        <div className={styles.sun} />
        <span className={styles.gull} style={{ top: "14%", left: "100%", fontSize: 20 }}>⌄</span>
        <span className={styles.gull} style={{ top: "9%", left: "110%", fontSize: 14, animationDelay: "-5s" }}>⌄</span>
        <div className={styles.boat}>⛵</div>
        <svg className={styles.waves} viewBox="0 0 1200 560" preserveAspectRatio="none">
          <path d="M0,380 C200,350 400,420 600,390 C800,360 1000,420 1200,390 L1200,560 L0,560 Z" fill="rgba(9,60,110,0.14)" />
          <path d="M0,430 C220,400 420,470 640,435 C860,400 1040,470 1200,435 L1200,560 L0,560 Z" fill="rgba(9,60,110,0.22)" />
          <path d="M0,480 C240,450 460,515 680,480 C900,450 1060,515 1200,480 L1200,560 L0,560 Z" fill="rgba(6,42,80,0.34)" />
          <path d="M0,525 C260,500 480,550 700,522 C920,500 1080,550 1200,525 L1200,560 L0,560 Z" fill="rgba(5,34,66,0.5)" />
        </svg>
        {glints.map((g, i) => (
          <span
            key={i}
            className={styles.glint}
            style={{ left: `${g.left}%`, top: `${g.top}%`, animationDelay: `${g.delay}s` }}
          />
        ))}
      </div>
    );
  }

  if (theme === "midnight") {
    return (
      <div className={sceneCls} aria-hidden>
        <div className={styles.aurora} />
        {stars.map((s, i) => (
          <span
            key={i}
            className={styles.star}
            style={{
              left: `${s.left}%`,
              top: `${s.top}%`,
              width: s.size,
              height: s.size,
              animationDelay: `${s.delay}s`,
            }}
          />
        ))}
        <span className={styles.shoot} style={{ left: "70%", top: "8%" }} />
        <span className={styles.shoot} style={{ left: "40%", top: "4%", animationDelay: "-3s" }} />
        <div className={styles.moon} />
        <svg className={styles.mountains} viewBox="0 0 1200 560" preserveAspectRatio="none">
          <path d="M0,560 L0,470 L180,380 L340,470 L520,400 L700,490 L900,410 L1080,480 L1200,440 L1200,560 Z" fill="rgba(20,18,38,0.8)" />
          <path d="M0,560 L0,510 L240,460 L480,515 L720,470 L960,520 L1200,490 L1200,560 Z" fill="rgba(12,11,24,0.95)" />
        </svg>
      </div>
    );
  }

  if (theme === "forest") {
    return (
      <div className={sceneCls} aria-hidden>
        <svg className={styles.canopy} viewBox="0 0 1200 560" preserveAspectRatio="none">
          <g fill="#8fa383" opacity="0.4">
            <ellipse cx="300" cy="110" rx="95" ry="48" />
            <ellipse cx="385" cy="80" rx="72" ry="37" />
            <ellipse cx="225" cy="85" rx="62" ry="31" />
            <ellipse cx="830" cy="140" rx="105" ry="50" />
            <ellipse cx="915" cy="105" rx="74" ry="37" />
          </g>
          <g fill="#5f7a58" opacity="0.6">
            <path d="M1080,560 L1080,235 Q1080,210 1100,210 Q1120,210 1120,235 L1120,560 Z" />
            <path d="M1053,295 Q1012,258 1026,206 Q1077,232 1079,283 Z" />
            <path d="M1118,335 Q1161,299 1150,247 Q1099,271 1097,325 Z" />
          </g>
          <g fill="#7a8f6f" opacity="0.5">
            <path d="M55,560 L55,300 Q55,280 70,280 Q85,280 85,300 L85,560 Z" />
            <path d="M35,330 Q5,300 15,260 Q55,280 57,320 Z" />
            <path d="M83,360 Q115,330 107,290 Q67,308 65,350 Z" />
          </g>
          <g fill="#6b8266" opacity="0.5">
            <path d="M170,560 l28,-150 l28,150 Z" />
            <path d="M232,560 l22,-110 l22,110 Z" />
            <path d="M920,560 l30,-170 l30,170 Z" />
          </g>
        </svg>
        <div className={styles.mist} style={{ bottom: 30 }} />
        <div className={styles.mist} style={{ bottom: 150, opacity: 0.55, animationDelay: "-8s" }} />
        {leaves.map((l, i) => (
          <span
            key={i}
            className={styles.leaf}
            style={{ left: `${l.left}%`, top: -20, animationDuration: `${l.dur}s`, animationDelay: `${l.delay}s` }}
          />
        ))}
        {flies.map((f, i) => (
          <span
            key={i}
            className={styles.fly}
            style={{ left: `${f.left}%`, top: `${f.top}%`, animationDelay: `${f.delay}s` }}
          />
        ))}
      </div>
    );
  }

  if (theme === "dawn") {
    return (
      <div className={sceneCls} aria-hidden>
        <div className={styles.dawnSun} />
        <div className={styles.dawnRay} style={{ left: "12%" }} />
        <div className={styles.dawnRay} style={{ left: "38%", animationDelay: "-5s" }} />
        <div className={styles.dawnRay} style={{ left: "64%", animationDelay: "-9s" }} />
        {clouds.map((c, i) => (
          <span
            key={i}
            className={styles.dawnCloud}
            style={{
              left: `${c.left}%`,
              top: c.top,
              width: c.width,
              opacity: c.opacity,
              animationDuration: `${c.dur}s`,
              animationDelay: `${c.delay}s`,
            }}
          />
        ))}
      </div>
    );
  }

  return null;
}
