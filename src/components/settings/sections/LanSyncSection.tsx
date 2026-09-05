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
      {/* ── 局域网同步 ── */}
      <div className={styles.sSection}>局域网同步</div>
      <ToggleRow icon="🌐" gradient="linear-gradient(135deg, #06B6D4, #3B82F6)" label="局域网同步" desc="同一局域网内自动同步剪贴板内容" value={config.lan_sync_enabled}
        detailTitle="局域网同步"
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
            toast(v ? "局域网同步已开启" : "局域网同步已关闭", "success");
          } catch (e) {
            logger.warn("切换LAN同步失败", e);
            toast("局域网同步切换失败，请检查网络", "error");
          }
        }} />
      {config.lan_sync_enabled && (
        <LanSyncPanel toast={toast} />
      )}
    </>
  );
}
