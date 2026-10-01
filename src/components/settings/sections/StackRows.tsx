/**
 * 「截图与栈」分区里的**粘贴栈**小节（2026-09-29 分区重排 方案A）。
 *
 * 这五行原先挂在「快捷键」节里，和八行热键录制器混在一起——它们配的是栈的行为，
 * 不是热键。栈自己成一节又被拆成两半也不合适（截图与热键共用一条链路），
 * 于是与截图同节、用一个小节标题分开：小节标题不进左菜单，滚动时菜单仍亮「截图与栈」
 * （`useSettingsNav` 对认不出的标题是跳过而非掉高亮）。
 *
 * 🔴 必须返回片段，原因同 StatsSection。
 */
import { STACK_MAX_TIERS, resolveStackMaxItems, useAppStore } from "@/stores/appStore";
import type { AppConfig } from "@/stores/appStore";
import { hudDismiss, hudStackModeEntered } from "@/lib/stack/hudBridge";
import { isHudEnabled } from "@/lib/stack/types";
import { ToggleRow, SettingTile } from "../ToggleRow";
import styles from "../../Settings.module.css";

interface StackRowsProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
}

export function StackRows({ config, updateAndSave }: StackRowsProps) {
  return (
    <>
      <div className={styles.sSection}>粘贴栈</div>
      <ToggleRow icon="📐" hue="paste" label="表格自动拆行入栈" desc="栈模式下复制表格时自动按行拆分（关闭=表格整块入栈）" value={config.table_split_enabled}
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
            <SettingTile hue="paste">📝</SettingTile>
            <div className={`${styles.sRowBody}`}>
              <div className={`${styles.sRowLabel}`}>拆行格式</div>
              <div className={`${styles.sRowDesc}`}>入栈后每条的文本样子</div>
            </div>
            <div className={styles.sSegGroup}>
              <button className={`${styles.sSegText}${config.table_split_format === "raw" ? ` ${styles.sSegActive}` : ""}`} aria-pressed={config.table_split_format === "raw"} onClick={() => updateAndSave({ table_split_format: "raw" })}>原始行</button>
              <button className={`${styles.sSegText}${config.table_split_format === "field-value" ? ` ${styles.sSegActive}` : ""}`} aria-pressed={config.table_split_format === "field-value"} onClick={() => updateAndSave({ table_split_format: "field-value" })}>字段: 值</button>
            </div>
          </div>
          <div className={styles.sRow}>
            <SettingTile hue="paste">🏷️</SettingTile>
            <div className={`${styles.sRowBody}`}>
              <div className={`${styles.sRowLabel}`}>表头</div>
              <div className={`${styles.sRowDesc}`}>拆分时是否保留第一行表头</div>
            </div>
            <div className={styles.sSegGroup}>
              <button className={`${styles.sSegText}${!config.table_split_include_header ? ` ${styles.sSegActive}` : ""}`} aria-pressed={!config.table_split_include_header} onClick={() => updateAndSave({ table_split_include_header: false })}>排除</button>
              <button className={`${styles.sSegText}${config.table_split_include_header ? ` ${styles.sSegActive}` : ""}`} aria-pressed={config.table_split_include_header} onClick={() => updateAndSave({ table_split_include_header: true })}>包含</button>
            </div>
          </div>
        </>
      )}
      {/* 栈浮标开关：放在「栈容量」上方 —— 它管的是「看得见什么」，容量管的是「攒多少」，
          先看到反馈再看到容量更符合从上往下读的顺序。 */}
      <ToggleRow icon="🎯" hue="paste" label="栈浮标" desc="开栈时贴在工作现场角落的小窗：条数、目标应用、下一条内容、粘贴结果"
        value={isHudEnabled(config.stack_hud_enabled)}
        tooltip="关闭后栈的反馈只剩主窗口横幅与提示；热键照常可用"
        detailTitle="栈浮标"
        detail={<>
          <p>浮标贴在你正在操作的那个窗口旁，显示「栈 N 条 · → 目标应用」，第二行是下一条要粘的内容，第三行提示按哪个热键继续。</p>
          <p>它存在的理由：栈全程用热键操作，那一刻你的视线在别的应用里，主窗口的横幅和提示你都看不到。</p>
          <p>关闭后不影响任何热键与粘贴本身 —— 但粘贴进度、目标应用、失败原因这些反馈就只有主窗口可见了；在别的窗口里按热键将是无声的。</p>
          <p>位置可拖：先开着浮标，从托盘菜单点「调整浮标位置…」，拖动后双击浮标完成。</p>
        </>}
        onChange={async (v) => {
          // 关掉的那一刻就收掉已显示的浮标，不等落盘（否则用户看不到变化）。
          if (!v) hudDismiss();
          await updateAndSave({ stack_hud_enabled: v });
          // 反过来在一轮栈模式里重新打开：立刻补一次显示。不补的话得退出栈、
          // 再开一次栈才看得见 —— 开关的反馈和它的触发不在同一个可见性域（规则 15.1）。
          if (v && useAppStore.getState().stackMode) void hudStackModeEntered();
        }} />
      <div className={styles.sRow}>
        <SettingTile hue="paste">🗃️</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>栈容量</div>
          <div className={`${styles.sRowDesc}`}>最多同时攒多少条；撞上限后新的照常入栈、栈底最旧那条被移出（本轮首次移出会提示一次）</div>
        </div>
        {/* 档位按钮（点选即存，同上方「拆行格式」那行同款控件）。
            刻意不做滑杆：配置每存一次都要全量明文备份，拖动类调参会在松手前
            打好几十次 save_config。 */}
        <div className={styles.sSegGroup} role="group" aria-label="栈容量">
          {STACK_MAX_TIERS.map((n) => (
            <button
              key={n}
              className={`${styles.sSegText}${resolveStackMaxItems(config.stack_max_items) === n ? ` ${styles.sSegActive}` : ""}`}
              aria-pressed={resolveStackMaxItems(config.stack_max_items) === n}
              onClick={() => updateAndSave({ stack_max_items: n })}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
