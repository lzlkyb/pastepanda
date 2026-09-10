import type { AppConfig } from "@/stores/appStore";
import { useToast } from "@/components/Toast";
import { logger } from "@/lib/logger";
import { ToggleRow } from "../ToggleRow";
import { LanSyncPanel } from "../LanSyncPanel";
import styles from "../../Settings.module.css";

interface LanSyncSectionProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
}

// 🔴 必须返回片段，原因同 StatsSection。
export function LanSyncSection({ config, updateAndSave }: LanSyncSectionProps) {
  const { toast } = useToast();
  return (
    <>
      {/* ── 剪贴板同步 ──
          ❗ 标题按**内容**命名，不是按传输方式。旧名叫「局域网同步」，
          而下面那个「知识库同步」**也走局域网** ⇒ 旧名看着像个总开关。
          两个标题当时在不同的轴上（一个按传输、一个按内容），
          以致下面那个不得不写一句「与上面那个无关」来消歧——那句话已删。
          🔴 只改文案：配置键 `lan_sync_enabled` 与命令 `toggle_lan_sync` 不动，
          改了会把用户已经开着的开关静默变回默认。 */}
      <div className={styles.sSection}>剪贴板同步</div>
      <ToggleRow icon="🌐" gradient="linear-gradient(135deg, #06B6D4, #3B82F6)" label="剪贴板同步" desc="多台电脑自动共享剪贴板。仅限同一局域网，跳网用不了" value={config.lan_sync_enabled}
        detailTitle="剪贴板同步"
        detail={<>
          <p>同一 WiFi 下的多台电脑自动共享剪贴板。</p>
          <p>📌 <b>场景</b>：台式机复制 → 笔记本粘贴</p>
          <p>⚠️ <b>注意</b>：两台设备都需安装 PastePanda 并开启此功能</p>
          <p>💡 <b>适合</b>：多设备办公用户</p>
        </>}
        onChange={async (v) => {
          await updateAndSave({ lan_sync_enabled: v });
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("toggle_lan_sync", { enable: v });
            toast(v ? "剪贴板同步已开启" : "剪贴板同步已关闭", "success");
          } catch (e) {
            logger.warn("切换LAN同步失败", e);
            toast("剪贴板同步切换失败，请检查网络", "error");
          }
        }} />
      {config.lan_sync_enabled && (
        <LanSyncPanel toast={toast} />
      )}
    </>
  );
}
