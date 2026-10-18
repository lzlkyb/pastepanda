import { primaryShortcutLabel } from "@/lib/utils";
import type { AppConfig } from "@/stores/appStore";
import type { SettingsData } from "@/hooks/useSettingsData";
import { HelpTooltip } from "@/components/HelpTooltip";
import { ToggleRow, SettingTile } from "../ToggleRow";
import { NoteTemplateRows } from "../NoteTemplateRows";
import { KbAutoDepositRows } from "../KbAutoDepositRows";
import styles from "../../Settings.module.css";

interface WindowEditorSectionProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<boolean>;
  mdAssoc: SettingsData["mdAssoc"];
  mdAssocBusy: SettingsData["mdAssocBusy"];
  handleMdAssocToggle: SettingsData["handleMdAssocToggle"];
  refreshMdAssoc: SettingsData["refreshMdAssoc"];
}

/** 保留旧组件名与 section key；窗口行已归入外观，本节只管理笔记与编辑。 */
export function WindowEditorSection({
  config, updateAndSave, mdAssoc, mdAssocBusy, handleMdAssocToggle, refreshMdAssoc,
}: WindowEditorSectionProps) {
  return (
    <>
      <div className={styles.sSection}>笔记与编辑</div>
      <div data-settings-parent="笔记与编辑" className={styles.sSection}>编辑器</div>
      <ToggleRow icon="💾" hue="save" label="编辑器自动保存" desc="全屏编辑器中停止输入后自动回写内容" value={config.md_auto_save} onChange={(v) => updateAndSave({ md_auto_save: v })}
        tooltip={`开启后，在全屏 Markdown 编辑器中输入停顿约 1 秒后，内容自动保存（卡片回写数据库 / 文件写回磁盘），无需手动按 ${primaryShortcutLabel("s")}`}
        detailTitle="编辑器自动保存"
        detail={<>
          <p>在全屏 Markdown 编辑器中编辑时，停止输入约 1 秒后自动保存内容。</p>
          <p>📌 <b>来自卡片</b>：自动回写到对应的剪贴板记录</p>
          <p>📌 <b>来自文件</b>：自动写回磁盘（不会重复写入剪贴板历史）</p>
          <p>📌 <b>新建未保存的文档</b>：没有保存目标，不会自动保存，需手动另存为</p>
          <p>💡 默认开启，防止意外丢失编辑内容</p>
        </>}
      />
      <ToggleRow icon="📝" hue="editor" label="编辑器保存写入历史" desc="全屏编辑器中保存 .md 文件时，同时写入剪贴板历史" value={config.md_save_to_history} onChange={(v) => updateAndSave({ md_save_to_history: v })}
        tooltip="开启后，在全屏 Markdown 编辑器中编辑并保存 .md 文件时，内容会同时作为一条剪贴板记录保存"
        detailTitle="编辑器保存写入历史"
        detail={<>
          <p>在全屏 Markdown 编辑器中编辑 .md 文件并保存时，是否同时将内容写入剪贴板历史。</p>
          <p>📌 <b>开启</b>：保存文件后，内容也会出现在剪贴板历史中，方便后续粘贴</p>
          <p>📌 <b>关闭</b>：仅保存文件，不写入历史</p>
          <p>💡 默认开启，适合编辑后需要频繁粘贴的场景</p>
        </>}
      />
      {/* .md 文件关联：状态实时取自注册表，三态显示 */}
      <div className={styles.sRow}>
        <SettingTile hue="editor">📎</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>
            关联 .md 文件
            <HelpTooltip
              tooltip="注册 .md 打开方式并引导设为默认，双击 .md 直接用全屏编辑器打开"
              detailTitle="关联 .md 文件"
              detail={<>
                <p>将 PastePanda 注册为 .md 文件的打开方式，并引导你在系统设置中确认为默认程序。</p>
                <p>📌 <b>生效后</b>：双击任意 .md 文件，直接用 PastePanda 全屏编辑器打开</p>
                <p>📌 Windows 开启后会打开系统「默认应用」设置页并定位到 PastePanda，点击 .md 一行选择 PastePanda 即可</p>
                <p>Mac 开启后设为默认程序，关闭后恢复开启前的默认程序。</p>
                <p>⚠️ Windows 不允许应用静默设为默认，需手动确认一次</p>
              </>}
            />
          </div>
          <div className={`${styles.sRowDesc}`}>
            {mdAssoc === "default" ? "已是 .md 默认打开方式 ✓"
              : mdAssoc === "available" ? "开启后，双击 .md 文件使用 PastePanda 编辑"
              : mdAssoc === "registered" ? "已注册打开方式，尚未设为默认"
              : mdAssoc === "unsupported" ? "此平台暂未提供文件关联，请在应用内打开文件"
              : mdAssoc === "loading" ? "检测中…"
              : mdAssoc === "error" ? "未能读取文件关联状态，请重试检测"
              : "双击 .md 文件直接用 PastePanda 编辑"}
          </div>
        </div>
        {mdAssoc === "registered" && (
          <button className={styles.sAction} disabled={mdAssocBusy} onClick={() => void handleMdAssocToggle(true)}>
            设为默认
          </button>
        )}
        {mdAssoc === "error" && (
          <button className={styles.sAction} onClick={() => void refreshMdAssoc()}>重新检测</button>
        )}
        <button
          className={`${styles.sToggle} ${(mdAssoc === "default" || mdAssoc === "registered") ? styles.on : styles.off}`}
          disabled={mdAssocBusy || mdAssoc === "loading" || mdAssoc === "error" || mdAssoc === "unsupported"}
          aria-label="将 PastePanda 设为 Markdown 文件打开方式"
          role="switch"
          aria-checked={mdAssoc === "default" || mdAssoc === "registered"}
          onClick={() => void handleMdAssocToggle(mdAssoc === "unregistered" || mdAssoc === "available" || mdAssoc === "loading")}>
          <span className={styles.sToggleThumb} />
          <span className={styles.sToggleLabel}>{(mdAssoc === "default" || mdAssoc === "registered") ? "开" : "关"}</span>
        </button>
      </div>
      <NoteTemplateRows config={config} updateAndSave={updateAndSave} />
      <KbAutoDepositRows config={config} updateAndSave={updateAndSave} />
    </>
  );
}
