import type { AppConfig } from "@/stores/appStore";
import { emit } from "@tauri-apps/api/event";
import { THEMES, applyTheme, ThemeKey } from "@/lib/theme";
import { HelpTooltip } from "@/components/HelpTooltip";
import { SettingTile, ToggleRow } from "../ToggleRow"
import shared from "../../Settings.module.css";
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
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
  tabStyle: string;
  handleSwitchTabStyle: (style: "segmented" | "circle") => void;
}

// 🔴 必须返回片段，原因同 StatsSection。
export function AppearanceSection({ config, updateAndSave, tabStyle, handleSwitchTabStyle }: AppearanceSectionProps) {
  return (
    <>
      {/* ── 外观 ── */}
      <div className={shared.sSection}>外观</div>
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
                <p>💡 <b>经典白</b>：纯白卡片 + 素面背景，无动效，最省资源</p>
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
                  applyTheme(t.key as ThemeKey);
                  // 广播到所有独立窗口（快捷粘贴/托盘弹窗/编辑器），使其切主题实时跟随。
                  // emit 广播是幂等的：主窗口自身也会收到，但 applyTheme 重复执行无副作用。
                  emit("theme-changed", { theme: t.key }).catch(() => { /* 广播失败不影响本窗口已生效 */ });
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

      {/* ── 以下五行 2026-09-29 从「通用」搬来 ──
          它们管的都是「界面长什么样、怎么动」，原先却混在采集/粘贴那一筐里，
          而这一节只剩两行、明显比别的节空。搬过来之后外观才真的叫外观。 */}
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
      <div className={shared.sRow}>
        <SettingTile hue="system">🖱️</SettingTile>
        <div className={`${shared.sRowBody}`}>
          <div className={`${shared.sRowLabel}`}>
            卡片悬浮行为
            <span className={`${shared.sRowRecommend}`}>⭐推荐</span>
            <HelpTooltip
              tooltip="鼠标悬停卡片时的交互方式"
              detailTitle="卡片悬浮行为"
              detail={<>
                <p>设置鼠标悬停在卡片上时的交互方式。</p>
                <p>📌 <b>关闭</b>：无悬浮交互，界面最简洁</p>
                <p>📌 <b>操作按钮</b>：Hover 显示复制/收藏/编辑/删除按钮，时间自动隐藏</p>
                <p>📌 <b>预览气泡</b>：弹出 Popover 气泡，内容预览+操作</p>
                <p>💡 <b>推荐气泡模式</b>，适合浏览长文本内容</p>
              </>}
            />
          </div>
          <div className={`${shared.sRowDesc}`}>
            {config.hover_mode === "off" ? "无悬浮交互，界面最简洁" : config.hover_mode === "inline" ? "Hover 显示操作按钮，时间自动隐藏" : "弹出 Popover 预览气泡，内容预览+操作"}
          </div>
        </div>
        <div className={shared.sSegGroup}>
          <button className={`${shared.sSegText}${config.hover_mode === "off" ? ` ${shared.sSegActive}` : ""}`} onClick={() => updateAndSave({ hover_mode: "off" })} aria-pressed={config.hover_mode === "off"}>
            关闭
          </button>
          <button className={`${shared.sSegText}${config.hover_mode === "inline" ? ` ${shared.sSegActive}` : ""}`} onClick={() => updateAndSave({ hover_mode: "inline" })} aria-pressed={config.hover_mode === "inline"}>
            操作按钮
          </button>
          <button className={`${shared.sSegText}${config.hover_mode === "popover" ? ` ${shared.sSegActive}` : ""}`} onClick={() => updateAndSave({ hover_mode: "popover" })} aria-pressed={config.hover_mode === "popover"}>
            预览气泡
          </button>
        </div>
      </div>
      <div className={shared.sRow}>
        <SettingTile hue="system">👆</SettingTile>
        <div className={`${shared.sRowBody}`}>
          <div className={`${shared.sRowLabel}`}>
            双击列表行为
            <HelpTooltip
              tooltip="设为「复制」更快捷，设为「预览」可查看详情"
              detailTitle="双击行为"
              detail={<>
                <p>设置双击卡片时的默认操作。</p>
                <p>📌 <b>复制</b>：双击直接复制内容到剪贴板</p>
                <p>📌 <b>预览</b>：双击弹出预览面板，可查看详情或编辑</p>
                <p>💡 设为「预览」后仍可通过悬停卡片快速复制</p>
              </>}
            />
          </div>
          <div className={`${shared.sRowDesc}`}>{config.double_click_action === "copy" ? "双击复制到剪贴板" : "双击预览/编辑"}</div>
        </div>
        <button className={shared.sVal} onClick={() => updateAndSave({ double_click_action: config.double_click_action === "copy" ? "preview" : "copy" })}>
          {config.double_click_action === "copy" ? "复制" : "预览"}
        </button>
      </div>
      <ToggleRow icon="⏱️" hue="editor" label="时间线" desc="主页面左侧显示竖版时间轴导航" value={config.timeline_enabled}
        tooltip="在剪贴板列表左侧显示时间轴，可快速跳转到不同时间段的记录"
        detailTitle="时间线"
        detail={<>
          <p>在主页左侧显示一条竖版时间轴导航条。</p>
          <p>📌 <b>功能</b>：按时间分组（今天/昨天/本周/更早）快速定位剪贴板记录</p>
          <p>🖱️ <b>操作</b>：悬停查看卡片预览，点击跳转到对应位置</p>
          <p>💡 适合记录较多时使用，帮助快速浏览</p>
        </>}
        onChange={(v) => updateAndSave({ timeline_enabled: v })} />
      <ToggleRow icon="✨" hue="system" label="窗口动画" desc="弹框与全屏窗口打开/关闭时的过渡动画" value={config.window_animation}
        tooltip="玻璃浮升效果；关闭后弹框与全屏编辑器即时显隐"
        detailTitle="窗口动画"
        detail={<>
          <p>控制弹框与全屏编辑器打开/关闭时的过渡动画（玻璃浮升效果）。</p>
          <p>📌 <b>开启</b>：弹框浮升进入、背景模糊渐显，关闭时平滑退场</p>
          <p>📌 <b>关闭</b>：即时显示/隐藏，无任何过渡</p>
          <p>💡 默认开启；追求极速响应可关闭</p>
        </>}
        onChange={(v) => updateAndSave({ window_animation: v })} />
    </>
  );
}
