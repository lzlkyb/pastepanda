import type { AppConfig } from "@/stores/appStore";
import { emit } from "@tauri-apps/api/event";
import { THEMES, applyTheme, ThemeKey } from "@/lib/theme";
import { HelpTooltip } from "@/components/HelpTooltip";
import styles from "../../Settings.module.css";

const THEME_PREVIEWS: Record<string, { bg: string; accent: string; text: string; barBg: string; bodyBg: string; lineBg: string }> = {
  "ocean":      { bg: "#F4F6F9", accent: "#0284C7", text: "#64748B", barBg: "#fff", bodyBg: "linear-gradient(180deg, #EAF6FD 0%, #CFE9F8 40%, #9ED0EA 75%, #79B8DD 100%)", lineBg: "#E0E4EB" },
  "ocean-dark": { bg: "#060D14", accent: "#3B9EFF", text: "#8BA4C0", barBg: "#0A1628", bodyBg: "radial-gradient(130% 120% at 70% -5%, #14415F 0%, #0A2440 45%, #041225 100%)", lineBg: "#162B45" },
  "midnight":   { bg: "#09090B", accent: "#818CF8", text: "#A1A1AA", barBg: "#18181B", bodyBg: "radial-gradient(100% 80% at 50% -10%, #1C1832 0%, #0B0B13 55%, #07070C 100%)", lineBg: "#27272A" },
  "forest":     { bg: "#F2F7F5", accent: "#059669", text: "#78716C", barBg: "#fff", bodyBg: "linear-gradient(180deg, #F5F1E3 0%, #EAE5D1 55%, #DCD6BD 100%)", lineBg: "#D1D9D3" },
  "blossom":    { bg: "#FFF7FA", accent: "#F0568C", text: "#86596D", barBg: "#fff", bodyBg: "linear-gradient(168deg, #FFE4EF 0%, #FFC9DD 42%, #FFAECF 78%, #FF9BC4 100%)", lineBg: "#F9D3E2" },
  "dawn":       { bg: "#FFF4E6", accent: "#E8734A", text: "#A08C72", barBg: "#fff", bodyBg: "linear-gradient(180deg, #FFF8EE 0%, #FFE9D2 42%, #FFD9AE 72%, #F9C78F 100%)", lineBg: "#F0DDC8" },
};

interface AppearanceSectionProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
  tabStyle: string;
  handleSwitchTabStyle: (style: "segmented" | "circle") => void;
}

// 🔴 必须返回片段，原因同 StatsSection。
export function AppearanceSection({ config, updateAndSave, tabStyle, handleSwitchTabStyle }: AppearanceSectionProps) {
  return (
    <>
      {/* ── 外观 ── */}
      <div className={styles.sSection}>外观</div>
      <div className={styles.sRow} style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
        <span className={styles.sRowIcon} style={{ background: "linear-gradient(135deg, #0078D4, #5856D6)", width: "fit-content", padding: "6px 12px" }}>🎨</span>
        <div className={styles.sRowBody}>
          <div className={styles.sRowLabel}>
            主题配色
            <HelpTooltip
              tooltip="6种精心调配的主题配色"
              detailTitle="主题配色"
              detail={<>
                <p>6 种精心调配的主题，点击即可预览，实时生效。</p>
                <p>💡 <b>经典白</b>：纯白卡片 + 素面背景，无动效，最省资源</p>
                <p>💡 <b>晨曦</b>：暖阳晨光，温柔唤醒每一天</p>
                <p>💡 <b>午夜</b>：暗色模式，夜间使用不刺眼</p>
                <p>💡 <b>美乐蒂</b>：甜系卡通粉，爱心雨+官方立绘，少女心爆棚</p>
              </>}
            />
          </div>
          <div className={styles.sRowDesc}>选择你喜欢的配色方案</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {THEMES.map((t, idx) => {
            const prev = THEME_PREVIEWS[t.key];
            const isActive = config.theme === t.key;
            return (
              <button key={t.key || `theme-${idx}`}
                onClick={() => {
                  updateAndSave({ theme: t.key });
                  applyTheme(t.key as ThemeKey);
                  // 广播到所有独立窗口（快捷粘贴/托盘弹窗/编辑器），使其切主题实时跟随。
                  // emit 广播是幂等的：主窗口自身也会收到，但 applyTheme 重复执行无副作用。
                  emit("theme-changed", { theme: t.key }).catch(() => { /* 广播失败不影响本窗口已生效 */ });
                }}
                style={{
                  width: 64, borderRadius: 10, overflow: "hidden",
                  border: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                  cursor: "pointer", background: "none", padding: 0,
                  boxShadow: isActive ? "0 0 0 3px var(--accent-light)" : "0 2px 6px rgba(0,0,0,0.08)",
                  transition: "all 0.2s", fontFamily: "inherit",
                }}>
                <div style={{
                  height: 24, background: prev.barBg, display: "flex",
                  alignItems: "center", padding: "0 6px", gap: 3,
                  borderBottom: `1px solid ${prev.lineBg}`,
                }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: prev.accent }} />
                  <div style={{ fontSize: 8, color: prev.text }}>{t.displayName}</div>
                </div>
                <div style={{
                  height: 36, background: prev.bodyBg, padding: 6,
                  display: "flex", flexDirection: "column", gap: 3,
                  position: "relative",
                }}>
                  <div style={{ height: 5, borderRadius: 3, background: prev.barBg, width: "100%", border: `1px solid ${prev.lineBg}` }} />
                  <div style={{ height: 5, borderRadius: 3, background: prev.lineBg, width: "70%" }} />
                  <div style={{ height: 5, borderRadius: 3, background: prev.accent, width: "45%" }} />
                  {t.key === "blossom" && (
                    <span style={{ position: "absolute", right: 4, bottom: 2, fontSize: 10, lineHeight: 1 }}>💗</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #8B5CF6, #AF52DE)" }}>📑</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>标签样式</div>
          <div className={`${styles.sRowDesc}`}>切换筛选标签的显示风格</div>
        </div>
        <button className={styles.sVal} onClick={() => handleSwitchTabStyle(tabStyle === "segmented" ? "circle" : "segmented")}>
          {tabStyle === "segmented" ? "分段控件" : "圆形图标"}
        </button>
      </div>
    </>
  );
}
