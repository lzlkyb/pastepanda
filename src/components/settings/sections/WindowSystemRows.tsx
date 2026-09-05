import type { AppConfig } from "@/stores/appStore";
import { useToast } from "@/components/Toast";
import { HelpTooltip } from "@/components/HelpTooltip";
import { ToggleRow } from "../ToggleRow";
import type { SettingsData } from "@/hooks/useSettingsData";
import styles from "../../Settings.module.css";

interface WindowSystemRowsProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
  mdAssoc: SettingsData["mdAssoc"];
  mdAssocBusy: SettingsData["mdAssocBusy"];
  handleMdAssocToggle: SettingsData["handleMdAssocToggle"];
}

// 「通用」分区的后半段：窗口行为、系统集成、编辑器与 .md 关联。
// 与前半段只是把文件切开（规则 #7），渲染顺序没变：紧跟在「来源图标」那一行后面。
// 🔴 必须返回片段，原因同 StatsSection。
export function WindowSystemRows({ config, updateAndSave, mdAssoc, mdAssocBusy, handleMdAssocToggle }: WindowSystemRowsProps) {
  const { toast } = useToast();
  return (
    <>
      <ToggleRow icon="⏱" gradient="linear-gradient(135deg, #8B5CF6, #6366F1)" label="时间线" desc="主页面左侧显示竖版时间轴导航" value={config.timeline_enabled}
        tooltip="在剪贴板列表左侧显示时间轴，可快速跳转到不同时间段的记录"
        detailTitle="时间线"
        detail={<>
          <p>在主页左侧显示一条竖版时间轴导航条。</p>
          <p>📌 <b>功能</b>：按时间分组（今天/昨天/本周/更早）快速定位剪贴板记录</p>
          <p>🖱️ <b>操作</b>：悬停查看卡片预览，点击跳转到对应位置</p>
          <p>💡 适合记录较多时使用，帮助快速浏览</p>
        </>}
        onChange={(v) => updateAndSave({ timeline_enabled: v })} />
      <ToggleRow icon="✨" gradient="linear-gradient(135deg, #0EA5E9, #8B5CF6)" label="窗口动画" desc="弹框与全屏窗口打开/关闭时的过渡动画" value={config.window_animation}
        tooltip="玻璃浮升效果；关闭后弹框与全屏编辑器即时显隐"
        detailTitle="窗口动画"
        detail={<>
          <p>控制弹框与全屏编辑器打开/关闭时的过渡动画（玻璃浮升效果）。</p>
          <p>📌 <b>开启</b>：弹框浮升进入、背景模糊渐显，关闭时平滑退场</p>
          <p>📌 <b>关闭</b>：即时显示/隐藏，无任何过渡</p>
          <p>💡 默认开启；追求极速响应可关闭</p>
        </>}
        onChange={(v) => updateAndSave({ window_animation: v })} />
      <ToggleRow icon="🔁" gradient="linear-gradient(135deg, #06B6D4, #0078D4)" label="依次粘贴循环" desc="到达末尾后从头开始" value={config.sequential_loop} onChange={(v) => updateAndSave({ sequential_loop: v })}
        tooltip="适合重复粘贴同一组内容时使用"
      />
      <ToggleRow icon="👁" gradient="linear-gradient(135deg, #EF4444, #FF3B30)" label="失焦自动隐藏" desc="窗口失去焦点时隐藏到托盘" value={config.hide_on_focus_out} onChange={(v) => updateAndSave({ hide_on_focus_out: v })}
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
      <ToggleRow icon="📌" gradient="linear-gradient(135deg, #F59E0B, #FF9500)" label="窗口置顶" desc="始终显示在其他窗口之上" value={config.always_on_top}
        tooltip="适合频繁粘贴时使用，窗口始终可见"
        onChange={async (v) => {
          await updateAndSave({ always_on_top: v });
          try { const { getCurrentWindow } = await import("@tauri-apps/api/window"); await getCurrentWindow().setAlwaysOnTop(v); } catch { toast("窗口置顶设置失败", "error"); }
        }} />
      <ToggleRow icon="🚀" gradient="linear-gradient(135deg, #3B82F6, #0078D4)" label="开机自启" desc="Windows 启动时自动运行" value={config.auto_startup}
        tooltip="开机后自动在后台运行，托盘图标常驻"
        detailTitle="开机自启"
        detail={<>
          <p>Windows 启动时自动运行 PastePanda。</p>
          <p>📌 启动后自动最小化到托盘，不影响开机速度</p>
          <p>💡 <b>推荐开启</b>，不用担心忘记启动</p>
        </>}
        onChange={async (v) => {
          await updateAndSave({ auto_startup: v });
          try { const { invoke } = await import("@tauri-apps/api/core"); await invoke("set_startup", { enable: v }); } catch { toast("开机自启设置失败", "error"); }
        }} />
      <ToggleRow icon="📝" gradient="linear-gradient(135deg, #6366F1, #8B5CF6)" label="编辑器保存写入历史" desc="全屏编辑器中保存 .md 文件时，同时写入剪贴板历史" value={config.md_save_to_history} onChange={(v) => updateAndSave({ md_save_to_history: v })}
        tooltip="开启后，在全屏 Markdown 编辑器中编辑并保存 .md 文件时，内容会同时作为一条剪贴板记录保存"
        detailTitle="编辑器保存写入历史"
        detail={<>
          <p>在全屏 Markdown 编辑器中编辑 .md 文件并保存时，是否同时将内容写入剪贴板历史。</p>
          <p>📌 <b>开启</b>：保存文件后，内容也会出现在剪贴板历史中，方便后续粘贴</p>
          <p>📌 <b>关闭</b>：仅保存文件，不写入历史</p>
          <p>💡 默认开启，适合编辑后需要频繁粘贴的场景</p>
        </>}
      />
      <ToggleRow icon="💾" gradient="linear-gradient(135deg, #10B981, #059669)" label="编辑器自动保存" desc="全屏编辑器中停止输入后自动回写内容" value={config.md_auto_save} onChange={(v) => updateAndSave({ md_auto_save: v })}
        tooltip="开启后，在全屏 Markdown 编辑器中输入停顿约 1 秒后，内容自动保存（卡片回写数据库 / 文件写回磁盘），无需手动按 Ctrl+S"
        detailTitle="编辑器自动保存"
        detail={<>
          <p>在全屏 Markdown 编辑器中编辑时，停止输入约 1 秒后自动保存内容。</p>
          <p>📌 <b>来自卡片</b>：自动回写到对应的剪贴板记录</p>
          <p>📌 <b>来自文件</b>：自动写回磁盘（不会重复写入剪贴板历史）</p>
          <p>📌 <b>新建未保存的文档</b>：没有保存目标，不会自动保存，需手动另存为</p>
          <p>💡 默认开启，防止意外丢失编辑内容</p>
        </>}
      />
      {/* .md 文件关联：状态实时取自注册表，三态显示 */}
      <div className={styles.sRow}>
        <span className={`${styles.sRowIcon}`} style={{ background: "linear-gradient(135deg, #0EA5E9, #0284C7)" }}>📎</span>
        <div className={`${styles.sRowBody}`}>
          <div className={`${styles.sRowLabel}`}>
            关联 .md 文件
            <HelpTooltip
              tooltip="注册 .md 打开方式并引导设为默认，双击 .md 直接用全屏编辑器打开"
              detailTitle="关联 .md 文件"
              detail={<>
                <p>将 PastePanda 注册为 .md 文件的打开方式，并引导你在系统设置中确认为默认程序。</p>
                <p>📌 <b>生效后</b>：双击任意 .md 文件，直接用 PastePanda 全屏编辑器打开</p>
                <p>📌 开启后会打开系统「默认应用」设置页并定位到 PastePanda，点击 .md 一行选择 PastePanda 即可</p>
                <p>⚠️ Windows 不允许应用静默设为默认，需手动确认一次</p>
              </>}
            />
          </div>
          <div className={`${styles.sRowDesc}`}>
            {mdAssoc === "default" ? "已是 .md 默认打开方式 ✓"
              : mdAssoc === "registered" ? "已注册打开方式，尚未设为默认"
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
          className={`${styles.sToggle} ${mdAssoc !== "unregistered" && mdAssoc !== "loading" ? styles.on : styles.off}`}
          disabled={mdAssocBusy || mdAssoc === "loading"}
          onClick={() => void handleMdAssocToggle(mdAssoc === "unregistered" || mdAssoc === "loading")}>
          <span className={styles.sToggleThumb} />
          <span className={styles.sToggleLabel}>{mdAssoc !== "unregistered" && mdAssoc !== "loading" ? "开" : "关"}</span>
        </button>
      </div>
    </>
  );
}
