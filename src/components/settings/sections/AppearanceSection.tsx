import type { AppConfig } from "@/stores/appStore";
import { THEMES } from "@/lib/theme";
import { HelpTooltip } from "@/components/HelpTooltip";
import { SettingTile, ToggleRow } from "../ToggleRow"
import shared from "../../Settings.module.css";
import { WindowBehaviorRows } from "./WindowBehaviorRows";
import styles from "./Appearance.module.css";

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
  updateAndSave: (partial: Record<string, unknown>) => Promise<boolean>;
  tabStyle: string;
  handleSwitchTabStyle: (style: "segmented" | "circle") => void;
}

// 🔴 必须返回片段，原因同 StatsSection。
export function AppearanceSection({ config, updateAndSave, tabStyle, handleSwitchTabStyle }: AppearanceSectionProps) {
  return (
    <>
      {/* ── 外观 ── */}
      <div className={shared.sSection}>外观与窗口</div>
      <div data-settings-parent="外观与窗口" className={shared.sSection}>主题与界面</div>
      <div className={shared.sRow} style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
        <SettingTile hue="brand">🎨</SettingTile>
        <div className={shared.sRowBody}>
          <div className={shared.sRowLabel}>
            主题配色
            <HelpTooltip
              tooltip="6种精心调配的主题配色"
              detailTitle="主题配色"
              detail={<>
                <p>6 种精心调配的主题，点击即可预览，实时生效。</p>
                <p>💡 <b>月白</b>：纯白卡片 + 冷调淡渐变底，无动效，最省资源</p>
                <p>💡 <b>晨曦</b>：暖阳晨光，温柔唤醒每一天</p>
                <p>💡 <b>午夜</b>：暗色模式，夜间使用不刺眼</p>
                <p>💡 <b>美乐蒂</b>：甜系卡通粉，爱心雨+官方立绘，少女心爆棚</p>
              </>}
            />
          </div>
          <div className={shared.sRowDesc}>选择你喜欢的配色方案</div>
        </div>
        {/* `data-stack="true"`：这六张卡是一条纵向行的 last-child。不挂标记就被
            `.sRow > :last-child` 那条右控件列规则拍成 `justify-content:flex-end`——
            实测首卡左偏 42px(340 档) / 262px(800 档)，左边一大片空白；
            而降级门现在改成按子节点数档，6 张卡正好会被误当成「6 档宽控件」，
            同一个标记同时挡住这两条规则。 */}
        <div className={styles.themeGrid} data-stack="true">
          {THEMES.map((t, idx) => {
            const prev = THEME_PREVIEWS[t.key];
            const isActive = config.theme === t.key;
            return (
              <button key={t.key || `theme-${idx}`}
                onClick={() => {
                  updateAndSave({ theme: t.key });
                }}
                className={`${styles.themeCard}${isActive ? ` ${styles.themeCardOn}` : ""}`}
                title={t.displayName}
                aria-pressed={isActive}>
                {/* 内联 style 里只剩下「这个主题长什么颜色」这一类真正因主题而异的值，
                    尺寸/圆角/阴影这些六张卡完全一样的东西都进了 ./Appearance.module.css。 */}
                <div
                  className={styles.themeCardBar}
                  style={{ background: prev.barBg, borderBottom: `1px solid ${prev.lineBg}` }}
                >
                  <div className={styles.themeCardDot} style={{ background: prev.accent }} />
                  <div className={styles.themeCardName} style={{ color: prev.text }}>{t.displayName}</div>
                </div>
                <div className={styles.themeCardBody} style={{ background: prev.bodyBg }}>
                  <div className={styles.themeCardLine} style={{ background: prev.barBg, width: "100%", border: `1px solid ${prev.lineBg}` }} />
                  <div className={styles.themeCardLine} style={{ background: prev.lineBg, width: "70%" }} />
                  <div className={styles.themeCardLine} style={{ background: prev.accent, width: "45%" }} />
                  {t.key === "blossom" && (
                    <span className={styles.themeCardHeart}>💗</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <div className={shared.sRow}>
        <SettingTile hue="system">📑</SettingTile>
        <div className={`${shared.sRowBody}`}>
          <div className={`${shared.sRowLabel}`}>标签样式</div>
          <div className={`${shared.sRowDesc}`}>切换筛选标签的显示风格</div>
        </div>
        <button className={shared.sVal} onClick={() => handleSwitchTabStyle(tabStyle === "segmented" ? "circle" : "segmented")}>
          {tabStyle === "segmented" ? "分段控件" : "圆形图标"}
        </button>
      </div>

      <div className={shared.sRow}>
        <SettingTile hue="system">🎯</SettingTile>
        <div className={`${shared.sRowBody}`}>
          <div className={`${shared.sRowLabel}`}>
            来源图标
            <span className={`${shared.sRowRecommend}`}>⭐推荐</span>
            <HelpTooltip
              tooltip="应用真实图标更直观，首次提取约需 50ms"
              detailTitle="来源图标"
              detail={<>
                <p>控制剪贴板卡片中来源 Badge 的图标显示方式。</p>
                <p>📌 <b>应用图标</b>：提取真实程序图标（推荐，更直观）</p>
                <p>📌 <b>Emoji</b>：使用预设的 emoji 图标</p>
                <p>💡 <b>推荐真实图标</b>，一眼就能识别来源应用</p>
              </>}
            />
          </div>
          <div className={`${shared.sRowDesc}`}>
            {config.source_icon_mode === "app" ? "显示真实程序图标，更直观" : "显示预设 Emoji 图标"}
          </div>
        </div>
        {/* 纯 emoji 按钮的含义只写在 title= 里、且不在四个公认符号的例外内 ⇒ 改成文字（用 .sSegText） */}
        <div className={shared.sSegGroup}>
          <button className={`${shared.sSegText}${config.source_icon_mode === "emoji" ? ` ${shared.sSegActive}` : ""}`} onClick={() => updateAndSave({ source_icon_mode: "emoji" })} aria-pressed={config.source_icon_mode === "emoji"}>
            Emoji
          </button>
          <button className={`${shared.sSegText}${config.source_icon_mode === "app" ? ` ${shared.sSegActive}` : ""}`} onClick={() => updateAndSave({ source_icon_mode: "app" })} aria-pressed={config.source_icon_mode === "app"}>
            应用图标
          </button>
        </div>
      </div>
      <ToggleRow icon="✨" hue="system" label="界面动效" desc="页面、菜单和弹窗自然衔接；跟随系统减少动态效果设置" value={config.window_animation}
        tooltip="动效可随时打断；关闭后即时显示，操作反馈仍保留"
        detailTitle="界面动效"
        detail={<>
          <p>统一页面、控件和弹层的过渡节奏，高频操作立即响应。</p>
          <p>开启时，新内容短距离进入，菜单从触发位置出现。</p>
          <p>关闭时即时显示；文字、选中、保存与错误提示仍保留。</p>
          <p>系统启用减少动态效果时，自动减少位移与缩放。</p>
        </>}
        onChange={(v) => updateAndSave({ window_animation: v })} />
      <WindowBehaviorRows config={config} updateAndSave={updateAndSave} />
    </>
  );
}
