import type { AppConfig } from "@/stores/appStore";
import { HelpTooltip } from "@/components/HelpTooltip";
import { SettingTile } from "../ToggleRow";
import styles from "../../Settings.module.css";

export function ClipboardBrowseRows({ config, updateAndSave }: {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<boolean>;
}) {
  return (
    <>
      <div className={styles.sRow}>
        <SettingTile hue="system">🖱️</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>
            卡片悬浮行为
            <span className={`${styles.sRowRecommend}`}>⭐推荐</span>
            <HelpTooltip
              tooltip="鼠标悬停或键盘聚焦卡片时的交互方式"
              detailTitle="卡片悬浮行为"
              detail={<>
                <p>设置鼠标悬停在卡片上时的交互方式。</p>
                <p>📌 <b>关闭</b>：无悬浮交互，界面最简洁</p>
                <p>📌 <b>操作按钮</b>：悬停或键盘聚焦时显示复制/置顶/编辑/删除按钮，时间自动隐藏</p>
                <p>📌 <b>预览气泡</b>：弹出 Popover 气泡，内容预览+操作</p>
                <p>💡 <b>推荐气泡模式</b>，适合浏览长文本内容</p>
              </>}
            />
          </div>
          <div className={`${styles.sRowDesc}`}>
            {config.hover_mode === "off" ? "无悬浮交互，界面最简洁" : config.hover_mode === "inline" ? "悬停或键盘聚焦显示操作按钮，时间自动隐藏" : "弹出 Popover 预览气泡，内容预览+操作"}
          </div>
        </div>
        <div className={styles.sSegGroup}>
          <button className={`${styles.sSegText}${config.hover_mode === "off" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ hover_mode: "off" })} aria-pressed={config.hover_mode === "off"}>
            关闭
          </button>
          <button className={`${styles.sSegText}${config.hover_mode === "inline" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ hover_mode: "inline" })} aria-pressed={config.hover_mode === "inline"}>
            操作按钮
          </button>
          <button className={`${styles.sSegText}${config.hover_mode === "popover" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ hover_mode: "popover" })} aria-pressed={config.hover_mode === "popover"}>
            预览气泡
          </button>
        </div>
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="system">👆</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>
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
          <div className={`${styles.sRowDesc}`}>{config.double_click_action === "copy" ? "双击复制到剪贴板" : "双击预览/编辑"}</div>
        </div>
        <button className={styles.sVal} onClick={() => updateAndSave({ double_click_action: config.double_click_action === "copy" ? "preview" : "copy" })}>
          {config.double_click_action === "copy" ? "复制" : "预览"}
        </button>
      </div>
      <div className={styles.sRow}>
        <SettingTile hue="paste">🗂️</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>快捷粘贴布局</div>
          <div className={`${styles.sRowDesc}`}>
            {config.quick_paste_layout === "list" ? "单栏列表，同屏可查看更多条记录" : "双栏网格，卡片预览更多内容"}
          </div>
        </div>
        <div className={styles.sSegGroup}>
          {/* 🔴 这两个按钮的内容只有一个 emoji 字形，读屏会念成「black square」之类
              的码点名；含义必须写进 aria-label（title 只做鼠标提示）。 */}
          <button className={`${styles.sSegOpt}${config.quick_paste_layout === "grid" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ quick_paste_layout: "grid" })} title="双栏网格" aria-label="双栏网格" aria-pressed={config.quick_paste_layout === "grid"}>
            <span className={styles.sSegEmoji}>🔲</span>
          </button>
          <button className={`${styles.sSegOpt}${config.quick_paste_layout === "list" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ quick_paste_layout: "list" })} title="单栏列表" aria-label="单栏列表" aria-pressed={config.quick_paste_layout === "list"}>
            <span className={styles.sSegEmoji}>☰</span>
          </button>
        </div>
      </div>
    </>
  );
}
