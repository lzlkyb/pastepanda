import { primaryShortcutLabel } from "@/lib/utils";
/**
 * 设置页「系统与编辑」分区（2026-09-29 分区重排 方案A；原名「窗口与编辑器」，6 字会被
 * 左菜单截成省略号，见 `meta.ts` 的宽度约束）。
 *
 * 原先散在「通用」的后半段（WindowSystemRows）里，与窗口无关的时间线/动画/依次粘贴混在一起；
 * 本文件只留「窗口行为 + Markdown 编辑器 + .md 关联」，末尾接「转笔记模板」小节
 * （模板是编辑器下游的事，摆在这里比留在快捷键节里近得多）。
 *
 * 🔴 必须返回片段，原因同 StatsSection；NoteTemplateRows 也返回片段，children 依旧扁平。
 */
import { useEffect } from "react";
import type { AppConfig } from "@/stores/appStore";
import { useToast } from "@/components/Toast";
import { HelpTooltip } from "@/components/HelpTooltip";
import { ToggleRow, SettingTile } from "../ToggleRow";
import { NoteTemplateRows } from "../NoteTemplateRows";
import { KbAutoDepositRows } from "../KbAutoDepositRows";
import type { SettingsData } from "@/hooks/useSettingsData";
import { resolveAutoStartupDesync } from "@/lib/autoStartup";
import styles from "../../Settings.module.css";

interface WindowEditorSectionProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
  mdAssoc: SettingsData["mdAssoc"];
  mdAssocBusy: SettingsData["mdAssocBusy"];
  handleMdAssocToggle: SettingsData["handleMdAssocToggle"];
}

export function WindowEditorSection({
  config, updateAndSave, mdAssoc, mdAssocBusy, handleMdAssocToggle,
}: WindowEditorSectionProps) {
  const { toast } = useToast();

  // 挂载时用注册表实测对账一次：条目被清理工具删值/被任务管理器禁用/路径过期后，
  // 配置和注册表会脱节，开关必须以实测为准（规则 #15：显示"已开启"就必须真的生效）。
  // 后端启动时已对账过一次，这里是设置页打开时的兜底（含启动对账失败的场景）。
  // 依赖留空：只在打开设置页时对账；开关切换由 onChange 同时写两边，无需跟踪 config。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const real = await invoke<boolean>("get_startup");
        if (cancelled) return;
        const d = resolveAutoStartupDesync(config.auto_startup, real);
        if (d.action !== "sync-config") return;
        await updateAndSave({ auto_startup: d.registryEnabled });
        toast(d.message, d.registryEnabled ? "info" : "warning");
      } catch { /* 探测失败不打扰：启动对账是主路径，这里只是兜底 */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className={styles.sSection}>系统与编辑</div>
      <ToggleRow icon="📌" hue="system" label="窗口置顶" desc="始终显示在其他窗口之上" value={config.always_on_top}
        tooltip="适合频繁粘贴时使用，窗口始终可见"
        onChange={async (v) => {
          await updateAndSave({ always_on_top: v });
          try { const { getCurrentWindow } = await import("@tauri-apps/api/window"); await getCurrentWindow().setAlwaysOnTop(v); } catch { toast("窗口置顶设置失败", "error"); }
        }} />
      <ToggleRow icon="👁️" hue="system" label="失焦自动隐藏" desc="窗口失去焦点时隐藏到托盘" value={config.hide_on_focus_out} onChange={(v) => updateAndSave({ hide_on_focus_out: v })}
        recommend
        tooltip="点击其他窗口时自动隐藏，保持桌面整洁"
        detailTitle="失焦自动隐藏"
        detail={<>
          <p>当 PastePanda 窗口失去焦点时自动隐藏到托盘。</p>
          <p>📌 点击其他应用 → 窗口自动收起，不挡视线</p>
          <p>💡 <b>推荐开启</b>，保持桌面整洁</p>
          <p>⚠️ 关闭后需手动点击 X 隐藏窗口</p>
        </>}
      />
      <ToggleRow icon="🚀" hue="system" label="开机自启" desc="登录系统后自动运行" value={config.auto_startup}
        tooltip="开机后自动在后台运行，托盘图标常驻"
        detailTitle="开机自启"
        detail={<>
          <p>登录系统后自动运行 PastePanda。</p>
          <p>📌 启动后自动最小化到托盘，不影响开机速度</p>
          <p>💡 <b>推荐开启</b>，不用担心忘记启动</p>
        </>}
        onChange={async (v) => {
          await updateAndSave({ auto_startup: v });
          try { const { invoke } = await import("@tauri-apps/api/core"); await invoke("set_startup", { enable: v }); } catch { toast("开机自启设置失败", "error"); }
        }} />
      {/* 托盘右键模式（2026-10-03 方案丁）：默认原生菜单，自绘弹窗保留为可选项 */}
      <div className={styles.sRow}>
        <SettingTile hue="system">🖱️</SettingTile>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>
            托盘右键菜单
            <HelpTooltip
              tooltip="原生=系统渲染的菜单，稳定可靠（推荐）；自绘=应用内玻璃弹窗"
              detailTitle="托盘右键菜单"
              detail={<>
                <p>右键点击托盘图标时弹出的菜单样式，切换后立即生效，无需重启。</p>
                <p>📌 <b>原生菜单（推荐）</b>：由系统提供菜单，粘贴成功或失败会闪一下托盘图标角标</p>
                <p>📌 <b>自绘弹窗</b>：应用内的玻璃弹窗样式，最近记录带图片缩略图</p>
                <p>⚠️ 若曾遇到「右键托盘没有反应/菜单显示不出」，切换为原生菜单可彻底避开</p>
              </>}
            />
          </div>
          <div className={`${styles.sRowDesc}`}>右键托盘图标时使用的菜单样式</div>
        </div>
        <select
          className={styles.sVal}
          style={{ width: 132 }}
          value={config.tray_menu_style}
          onChange={(e) => void updateAndSave({ tray_menu_style: e.target.value })}
          title="选择托盘右键菜单样式"
        >
          <option value="native">原生菜单（推荐）</option>
          <option value="popup">自绘弹窗</option>
        </select>
      </div>
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
              : "双击 .md 文件直接用 PastePanda 编辑"}
          </div>
        </div>
        {mdAssoc === "registered" && (
          <button className={styles.sAction} disabled={mdAssocBusy} onClick={() => void handleMdAssocToggle(true)}>
            设为默认
          </button>
        )}
        <button
          className={`${styles.sToggle} ${(mdAssoc === "default" || mdAssoc === "registered") ? styles.on : styles.off}`}
          disabled={mdAssocBusy || mdAssoc === "loading" || mdAssoc === "unsupported"}
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
