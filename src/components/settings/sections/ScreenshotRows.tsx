import type { AppConfig } from "@/stores/appStore";
import { useDialogStore } from "@/stores/dialogStore";
import { ToggleRow } from "../ToggleRow";
import type { SettingsData } from "@/hooks/useSettingsData";
import styles from "../../Settings.module.css";

interface ScreenshotRowsProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
  chains: SettingsData["chains"];
}

// 「快捷键」分区里截图相关的行为设置（自动框选、窗口常驻、默认动作链、快速粘贴布局）。
// 与前面的热键录制器只是把文件切开（规则 #7），渲染顺序没变。
// 🔴 必须返回片段，原因同 StatsSection。
export function ScreenshotRows({ config, updateAndSave, chains }: ScreenshotRowsProps) {
  return (
    <>
      <ToggleRow icon="🪟" gradient="linear-gradient(135deg, #F59E0B, #D97706)" label="自动框选当前窗口"
        desc="按截图热键后自动选中光标所在窗口（微信同款），可直接完成或重新拖选"
        value={config.auto_frame_window}
        onChange={(v) => updateAndSave({ auto_frame_window: v })}
        detailTitle="自动框选当前窗口"
        detail={<>
          <p>按截图热键后，自动选中光标所在窗口作为选区（微信同款），可直接完成或重新拖选。</p>
          <p>光标停在桌面空白时不自动框选，保持 hover 吸附全屏。</p>
        </>} />
      <ToggleRow icon="⚡" gradient="linear-gradient(135deg, #10B981, #059669)" label="截图窗口常驻"
        desc="开启后截图窗关闭时仅隐藏不销毁，再次按热键秒开（微信同款）；关闭则每次冷启动，首次画面慢几秒。代价：常驻约几十~百 MB 内存"
        value={config.screenshot_window_persist}
        onChange={(v) => updateAndSave({ screenshot_window_persist: v })}
        detailTitle="截图窗口常驻"
        detail={<>
          <p>开启后截图窗关闭时仅隐藏不销毁，再次按热键秒开（微信同款）。</p>
          <p>关闭则每次冷启动，首次画面慢几秒。</p>
          <p>代价：常驻约几十~百 MB 内存。</p>
        </>} />
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #6366F1, #8B5CF6)" }}>🔤</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>OCR 选字模式</div>
          <div className={`${styles.sRowDesc}`}>
            标注时文字识别与画标注共存、互不抢事件。智能意图：默认矩形工具下，落在文字上拖即选字（光标离开文字带则冻结已选内容）；修饰键：按住 Ctrl/⌘ 拖才选字，裸拖一律画标注
          </div>
        </div>
        <div className={styles.sSegGroup}>
          <button
            className={`${styles.sSegText}${config.ocr_select_mode === "smart" ? ` ${styles.sSegActive}` : ""}`}
            onClick={() => void updateAndSave({ ocr_select_mode: "smart" })}
            title="落在文字上拖=选字；光标离开文字带则冻结已选内容"
          >
            智能意图
          </button>
          <button
            className={`${styles.sSegText}${config.ocr_select_mode === "modifier" ? ` ${styles.sSegActive}` : ""}`}
            onClick={() => void updateAndSave({ ocr_select_mode: "modifier" })}
            title="Ctrl/⌘ + 落在文字上拖=选字；裸拖一律画标注"
          >
            Ctrl 修饰键
          </button>
        </div>
      </div>
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #F59E0B, #D97706)" }}>⚡</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>完成后自动执行动作链</div>
          <div className={`${styles.sRowDesc}`}>
            截图完成自动跑链（OCR 文字为输入）；自动执行仅限纯本地步骤，云端步骤会跳过
          </div>
        </div>
        {chains.length === 0 ? (
          // 空态：还没建过动作链——下拉只有"不自动执行"会让用户困惑，直接给"创建"入口
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className={styles.sVal} style={{ width: 132, opacity: 0.55, cursor: "default", textAlign: "center" }}>
              暂无动作链
            </span>
            <button
              className={styles.sAction}
              onClick={() => useDialogStore.getState().openChainEditor(null)}
              title="打开动作链编辑器，创建第一个动作链"
            >
              创建
            </button>
          </div>
        ) : (
          <select
            className={styles.sVal}
            style={{ width: 132 }}
            value={config.auto_chain_after_screenshot ?? ""}
            onChange={(e) => void updateAndSave({ auto_chain_after_screenshot: e.target.value })}
            title="选择截图后自动执行的动作链"
          >
            <option value="">不自动执行</option>
            {chains.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
      </div>
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #0EA5E9, #0284C7)" }}>🗂️</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>面板布局</div>
          <div className={`${styles.sRowDesc}`}>
            {config.quick_paste_layout === "list" ? "单栏列表，贴近原生 Win+V，同屏可览更多条" : "双栏网格，卡片预览更多内容"}
          </div>
        </div>
        <div className={styles.sSegGroup}>
          <button className={`${styles.sSegOpt}${config.quick_paste_layout === "grid" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ quick_paste_layout: "grid" })} title="双栏网格">
            <span className={styles.sSegEmoji}>🔲</span>
          </button>
          <button className={`${styles.sSegOpt}${config.quick_paste_layout === "list" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ quick_paste_layout: "list" })} title="单栏列表">
            <span className={styles.sSegEmoji}>☰</span>
          </button>
        </div>
      </div>
    </>
  );
}
