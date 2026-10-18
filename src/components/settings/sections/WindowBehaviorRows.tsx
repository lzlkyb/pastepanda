import { useEffect } from "react";
import type { AppConfig } from "@/stores/appStore";
import { useToast } from "@/components/Toast";
import { HelpTooltip } from "@/components/HelpTooltip";
import { ToggleRow, SettingTile } from "../ToggleRow";
import { resolveAutoStartupDesync } from "@/lib/autoStartup";
import styles from "../../Settings.module.css";

interface WindowBehaviorRowsProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<boolean>;
}

export function WindowBehaviorRows({
  config, updateAndSave,
}: WindowBehaviorRowsProps) {
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
        if (!await updateAndSave({ auto_startup: d.registryEnabled })) return;
        toast(d.message, d.registryEnabled ? "info" : "warning");
      } catch { /* 探测失败不打扰：启动对账是主路径，这里只是兜底 */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div data-settings-parent="外观与窗口" className={styles.sSection}>窗口与启动</div>
      <ToggleRow icon="📌" hue="system" label="窗口置顶" desc="始终显示在其他窗口之上" value={config.always_on_top}
        tooltip="适合频繁粘贴时使用，窗口始终可见"
        onChange={async (v) => {
          if (!await updateAndSave({ always_on_top: v })) return;
          try { const { getCurrentWindow } = await import("@tauri-apps/api/window"); await getCurrentWindow().setAlwaysOnTop(v); }
          catch {
            const restored = await updateAndSave({ always_on_top: config.always_on_top });
            toast(restored ? "窗口置顶设置失败，已恢复原设置" : "窗口置顶设置失败，原设置未能保存，请重试", "error");
          }
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
          if (!await updateAndSave({ auto_startup: v })) return;
          try { const { invoke } = await import("@tauri-apps/api/core"); await invoke("set_startup", { enable: v }); }
          catch {
            const restored = await updateAndSave({ auto_startup: config.auto_startup });
            toast(restored ? "开机自启设置失败，已恢复原设置" : "开机自启设置失败，原设置未能保存，请重试", "error");
          }
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
          className={`${styles.sVal} ${styles.sWideSelect}`}
          value={config.tray_menu_style}
          onChange={(e) => void updateAndSave({ tray_menu_style: e.target.value })}
          title="选择托盘右键菜单样式"
        >
          <option value="native">原生菜单（推荐）</option>
          <option value="popup">自绘弹窗</option>
        </select>
      </div>
    </>
  );
}
