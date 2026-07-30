/**
 * SkinScene — 皮肤场景层
 *
 * 为特定主题在窗口背景渲染"世界"氛围（飘落花瓣 / 深海光柱气泡 / 终端字符雨）。
 * 固定铺满视口、z-index: 0、pointer-events: none：
 * 衬在玻璃卡片（cardWrap z-index: 1）之后，透过半透明卡片可见，不干扰任何交互。
 * 粒子参数在挂载时随机生成一次（useMemo），之后仅跑 CSS 动画，性能开销极小。
 */
import { useMemo } from "react";
import { useAppStore } from "@/stores/appStore";
import styles from "./SkinScene.module.css";

const rnd = (n: number) => Math.random() * n;

export function SkinScene() {
  const theme = useAppStore((s) => s.config.theme);

  // 樱花花瓣
  const petals = useMemo(
    () =>
      Array.from({ length: 16 }, () => ({
        left: rnd(110),
        size: 10 + rnd(10),
        dur: 7 + rnd(8),
        delay: -rnd(14),
      })),
    []
  );
  // 深海气泡
  const bubbles = useMemo(
    () =>
      Array.from({ length: 12 }, () => ({
        left: rnd(100),
        size: 9 + rnd(22),
        dur: 8 + rnd(9),
        delay: -rnd(14),
        bottom: -20 - rnd(120),
      })),
    []
  );
  // 深海浮游生物
  const plankton = useMemo(
    () =>
      Array.from({ length: 20 }, () => ({
        left: rnd(100),
        top: rnd(100),
        delay: -rnd(3),
      })),
    []
  );
  // 终端字符雨
  const glyphs = useMemo(() => {
    const chars = "01<>{}/$#*+=%&パンダ";
    return Array.from({ length: 22 }, () => {
      const n = 3 + Math.floor(rnd(6));
      let col = "";
      for (let k = 0; k < n; k++) col += chars[Math.floor(rnd(chars.length))] + "\n";
      return { left: rnd(100), dur: 6 + rnd(9), delay: -rnd(14), col };
    });
  }, []);
  // 海洋水面碎金
  const glints = useMemo(
    () =>
      Array.from({ length: 26 }, () => ({
        left: rnd(100),
        top: 55 + rnd(38),
        delay: -rnd(3),
      })),
    []
  );
  // 午夜满天星
  const stars = useMemo(
    () =>
      Array.from({ length: 80 }, () => ({
        left: rnd(100),
        top: rnd(68),
        size: Math.random() < 0.85 ? 2 : 3,
        delay: -rnd(4),
        opacity: 0.3 + rnd(0.7),
      })),
    []
  );
  // 森林落叶
  const leaves = useMemo(
    () =>
      Array.from({ length: 10 }, () => ({
        left: rnd(100),
        dur: 8 + rnd(8),
        delay: -rnd(10),
      })),
    []
  );
  // 森林萤火虫
  const flies = useMemo(
    () =>
      Array.from({ length: 12 }, () => ({
        left: 5 + rnd(90),
        top: 40 + rnd(50),
        delay: -rnd(7),
      })),
    []
  );

  if (theme === "blossom") {
    return (
      <div className={styles.scene} aria-hidden>
        <div className={styles.haze} style={{ top: "15%" }} />
        <div className={styles.haze} style={{ bottom: "8%", opacity: 0.6 }} />
        {petals.map((p, i) => (
          <span
            key={i}
            className={styles.petal}
            style={{
              left: `${p.left}%`,
              width: p.size,
              height: p.size * 0.75,
              animationDuration: `${p.dur}s`,
              animationDelay: `${p.delay}s`,
            }}
          />
        ))}
      </div>
    );
  }

  if (theme === "ocean-dark") {
    return (
      <div className={styles.scene} aria-hidden>
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

  if (theme === "terminal") {
    return (
      <div className={styles.scene} aria-hidden>
        {glyphs.map((g, i) => (
          <span
            key={i}
            className={styles.glyph}
            style={{
              left: `${g.left}%`,
              animationDuration: `${g.dur}s`,
              animationDelay: `${g.delay}s`,
            }}
          >
            {g.col}
          </span>
        ))}
        <div className={styles.scan} />
        <div className={styles.crtGlow} />
      </div>
    );
  }

  if (theme === "ocean") {
    return (
      <div className={styles.scene} aria-hidden>
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
      <div className={styles.scene} aria-hidden>
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
      <div className={styles.scene} aria-hidden>
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

  if (theme === "sunset") {
    return (
      <div className={styles.scene} aria-hidden>
        <div className={styles.sunsetSun} />
        <div className={styles.cloud} style={{ left: "14%", top: 110, width: 230, animationDuration: "26s" }} />
        <div className={styles.cloud} style={{ left: "56%", top: 80, width: 290, animationDuration: "34s", animationDelay: "-10s" }} />
        <div className={styles.cloud} style={{ left: "32%", top: 190, width: 190, opacity: 0.7, animationDuration: "30s", animationDelay: "-20s" }} />
        <span className={styles.bird} style={{ top: 140, left: "100%", fontSize: 16 }}>⌄</span>
        <span className={styles.bird} style={{ top: 120, left: "108%", fontSize: 12, animationDelay: "-6s" }}>⌄</span>
        <svg className={styles.mountains} viewBox="0 0 1200 560" preserveAspectRatio="none">
          <path d="M0,560 L0,460 Q300,410 600,455 Q900,495 1200,435 L1200,560 Z" fill="rgba(30,10,30,0.55)" />
          <path d="M0,560 L0,505 Q400,465 800,502 Q1000,518 1200,498 L1200,560 Z" fill="rgba(20,6,22,0.78)" />
        </svg>
      </div>
    );
  }

  return null;
}
