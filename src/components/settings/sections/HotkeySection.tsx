import type { AppConfig } from "@/stores/appStore";
import { useToast } from "@/components/Toast";
import { logger } from "@/lib/logger";
import { ToggleRow } from "../ToggleRow";
import { NoteTemplateRows } from "../NoteTemplateRows";
import { HotkeyRecorder } from "../HotkeyRecorder";
import { ScreenshotRows } from "./ScreenshotRows";
import type { SettingsData } from "@/hooks/useSettingsData";
import styles from "../../Settings.module.css";

interface HotkeySectionProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
  chains: SettingsData["chains"];
}

// 🔴 必须返回片段，原因同 StatsSection。
// 截图行为那一组在 ScreenshotRows，它也返回片段，所以容器 children 依旧扁平。
export function HotkeySection({ config, updateAndSave, chains }: HotkeySectionProps) {
  const { toast } = useToast();
  return (
    <>
      {/* ── 快捷键 ── */}
      <div className={styles.sSection}>快捷键</div>
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #3B82F6, #0078D4)" }}>⌨</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>唤出窗口</div>
          <div className={`${styles.sRowDesc}`}>全局快捷键，在任何位置唤出</div>
        </div>
        <HotkeyRecorder value={config.hotkey} allowClear taken={[config.sequential_hotkey ?? "", config.stack_toggle_hotkey ?? "", config.stack_paste_hotkey ?? "", config.quick_paste_hotkey ?? "", config.screenshot_hotkey ?? "", config.daily_note_hotkey ?? ""]} onChange={async (v) => {
          const oldVal = config.hotkey;
          await updateAndSave({ hotkey: v });
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("reregister_hotkeys");
            toast("快捷键已更新", "success");
          } catch (e) {
            await updateAndSave({ hotkey: oldVal });
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("热键设置失败", e);
            toast(`快捷键设置失败：${msg}。变更未生效，已恢复原值`, "error");
          }
        }} />
      </div>
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #8B5CF6, #5856D6)" }}>📋</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>依次粘贴</div>
          <div className={`${styles.sRowDesc}`}>按顺序逐条粘贴剪贴板</div>
        </div>
        <HotkeyRecorder value={config.sequential_hotkey ?? ""} allowClear taken={[config.hotkey, config.stack_toggle_hotkey ?? "", config.stack_paste_hotkey ?? "", config.quick_paste_hotkey ?? "", config.screenshot_hotkey ?? "", config.daily_note_hotkey ?? ""]} onChange={async (v) => {
          const oldVal = config.sequential_hotkey ?? "";
          await updateAndSave({ sequential_hotkey: v });
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("reregister_hotkeys");
            toast("快捷键已更新", "success");
          } catch (e) {
            await updateAndSave({ sequential_hotkey: oldVal });
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("热键设置失败", e);
            toast(`快捷键设置失败：${msg}。变更未生效，已恢复原值`, "error");
          }
        }} />
      </div>
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #F97316, #EA580C)" }}>📚</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>收集模式开关</div>
          <div className={`${styles.sRowDesc}`}>进入/退出剪贴板收集模式（栈模式）</div>
        </div>
        <HotkeyRecorder value={config.stack_toggle_hotkey ?? ""} allowClear taken={[config.hotkey, config.sequential_hotkey ?? "", config.stack_paste_hotkey ?? "", config.quick_paste_hotkey ?? "", config.screenshot_hotkey ?? "", config.daily_note_hotkey ?? ""]} onChange={async (v) => {
          const oldVal = config.stack_toggle_hotkey ?? "";
          await updateAndSave({ stack_toggle_hotkey: v });
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("reregister_hotkeys");
            toast("快捷键已更新", "success");
          } catch (e) {
            await updateAndSave({ stack_toggle_hotkey: oldVal });
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("热键设置失败", e);
            toast(`快捷键设置失败：${msg}。变更未生效，已恢复原值`, "error");
          }
        }} />
      </div>
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #FB923C, #F97316)" }}>📤</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>粘贴最近收集</div>
          <div className={`${styles.sRowDesc}`}>粘贴最近收集的内容并移出收集列表</div>
        </div>
        <HotkeyRecorder value={config.stack_paste_hotkey ?? ""} allowClear taken={[config.hotkey, config.sequential_hotkey ?? "", config.stack_toggle_hotkey ?? "", config.quick_paste_hotkey ?? "", config.screenshot_hotkey ?? "", config.daily_note_hotkey ?? ""]} onChange={async (v) => {
          const oldVal = config.stack_paste_hotkey ?? "";
          await updateAndSave({ stack_paste_hotkey: v });
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("reregister_hotkeys");
            toast("快捷键已更新", "success");
          } catch (e) {
            await updateAndSave({ stack_paste_hotkey: oldVal });
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("热键设置失败", e);
            toast(`快捷键设置失败：${msg}。变更未生效，已恢复原值`, "error");
          }
        }} />
      </div>
      <ToggleRow icon="📐" gradient="linear-gradient(135deg, #FB923C, #EA580C)" label="表格自动拆行入栈" desc="栈模式下复制表格时自动按行拆分（关闭=表格整块入栈）" value={config.table_split_enabled}
        tooltip="栈模式下复制表格（或非栈模式下按栈粘贴热键且剪贴板是表格）会自动按行拆分，可在「⋯」菜单里一键撤销"
        detailTitle="表格自动拆行入栈"
        detail={<>
          <p>开启后，在栈模式下复制表格内容会自动按行拆分成多条独立文本入栈，依次粘贴时一次贴一行。</p>
          <p>非栈模式下按粘贴热键且剪贴板是表格，也会自动开栈拆行并贴第一条。</p>
          <p>误拆时可在栈横幅「⋯」菜单里点「撤销拆分」一键还原。</p>
        </>}
        onChange={(v) => updateAndSave({ table_split_enabled: v })} />
      {config.table_split_enabled && (
        <>
          <div className={styles.sRow}>
            <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #FB923C, #EA580C)" }}>📝</span>
            <div className={`${styles.sRowBody}`}>
              <div className={`${styles.sRowLabel}`}>拆行格式</div>
              <div className={`${styles.sRowDesc}`}>入栈后每条的文本样子</div>
            </div>
            <div className={styles.sSegGroup}>
              <button className={`${styles.sSegText}${config.table_split_format === "raw" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ table_split_format: "raw" })}>原始行</button>
              <button className={`${styles.sSegText}${config.table_split_format === "field-value" ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ table_split_format: "field-value" })}>字段: 值</button>
            </div>
          </div>
          <div className={styles.sRow}>
            <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #FB923C, #EA580C)" }}>🏷️</span>
            <div className={`${styles.sRowBody}`}>
              <div className={`${styles.sRowLabel}`}>表头</div>
              <div className={`${styles.sRowDesc}`}>拆分时是否保留第一行表头</div>
            </div>
            <div className={styles.sSegGroup}>
              <button className={`${styles.sSegText}${!config.table_split_include_header ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ table_split_include_header: false })}>排除</button>
              <button className={`${styles.sSegText}${config.table_split_include_header ? ` ${styles.sSegActive}` : ""}`} onClick={() => updateAndSave({ table_split_include_header: true })}>包含</button>
            </div>
          </div>
        </>
      )}
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #14B8A6, #0D9488)" }}>⚡</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>快捷粘贴</div>
          <div className={`${styles.sRowDesc}`}>在光标处弹出面板，快速选择并粘贴（类 Win+V）</div>
        </div>
        <HotkeyRecorder value={config.quick_paste_hotkey ?? ""} allowClear taken={[config.hotkey, config.sequential_hotkey ?? "", config.stack_toggle_hotkey ?? "", config.stack_paste_hotkey ?? "", config.screenshot_hotkey ?? "", config.daily_note_hotkey ?? ""]} onChange={async (v) => {
          const oldVal = config.quick_paste_hotkey ?? "";
          await updateAndSave({ quick_paste_hotkey: v });
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("reregister_hotkeys");
            toast("快捷键已更新", "success");
          } catch (e) {
            await updateAndSave({ quick_paste_hotkey: oldVal });
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("热键设置失败", e);
            toast(`快捷键设置失败：${msg}。变更未生效，已恢复原值`, "error");
          }
        }} />
      </div>
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #8B5CF6, #6D28D9)" }}>📸</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>截图标注</div>
          <div className={`${styles.sRowDesc}`}>全局热键唤出截图：选区 → 标注 → OCR 识别 → 复制/保存/AI 处理</div>
        </div>
        <HotkeyRecorder value={config.screenshot_hotkey ?? ""} allowClear taken={[config.hotkey, config.sequential_hotkey ?? "", config.stack_toggle_hotkey ?? "", config.stack_paste_hotkey ?? "", config.quick_paste_hotkey ?? "", config.daily_note_hotkey ?? ""]} onChange={async (v) => {
          const oldVal = config.screenshot_hotkey ?? "";
          await updateAndSave({ screenshot_hotkey: v });
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("reregister_hotkeys");
            toast("快捷键已更新", "success");
          } catch (e) {
            await updateAndSave({ screenshot_hotkey: oldVal });
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("热键设置失败", e);
            toast(`快捷键设置失败：${msg}。变更未生效，已恢复原值`, "error");
          }
        }} />
      </div>
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #10B981, #059669)" }}>📅</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>今日速记</div>
          <div className={`${styles.sRowDesc}`}>把剪贴板当前内容追加到「今天」那条笔记，不用打开窗口</div>
        </div>
        <HotkeyRecorder value={config.daily_note_hotkey ?? ""} allowClear taken={[config.hotkey, config.sequential_hotkey ?? "", config.stack_toggle_hotkey ?? "", config.stack_paste_hotkey ?? "", config.quick_paste_hotkey ?? "", config.screenshot_hotkey ?? ""]} onChange={async (v) => {
          const oldVal = config.daily_note_hotkey ?? "";
          await updateAndSave({ daily_note_hotkey: v });
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("reregister_hotkeys");
            toast("快捷键已更新", "success");
          } catch (e) {
            await updateAndSave({ daily_note_hotkey: oldVal });
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("热键设置失败", e);
            toast(`快捷键设置失败：${msg}。变更未生效，已恢复原值`, "error");
          }
        }} />
      </div>
      <ScreenshotRows config={config} updateAndSave={updateAndSave} chains={chains} />

      {/* ── 转笔记模板（B2 #8）──
          自己一节而不是塞进「数据管理」：塞进去就得在那节中间插一个小节标题，把那节从中间切断 */}
      <NoteTemplateRows config={config} updateAndSave={updateAndSave} />
    </>
  );
}
