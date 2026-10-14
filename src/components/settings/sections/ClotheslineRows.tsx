import type { AppConfig } from "@/stores/appStore";
import { invoke } from '@tauri-apps/api/core';
import { useToast } from '@/components/Toast';
import { ToggleRow, SettingTile } from "../ToggleRow";
import styles from "../../Settings.module.css";

export function ClotheslineRows({
  config,
  updateAndSave,
}: {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
}) {
  const { toast } = useToast();
  return (
    <>
      <ToggleRow
        icon="🖼️"
        hue="capture"
        label="截图晾衣绳"
        desc="新图片只在桌面晾衣绳显示；取下贴图可跨应用。拖入是否接收由目标应用决定，关闭不影响历史"
        value={config.clothesline}
        onChange={(v) => updateAndSave({ clothesline: v })}
      />
      {config.clothesline && <button type="button" className={styles.sAction} onClick={() => {
        void invoke('clothesline_retry').then(() => toast('已重试显示，请回到桌面查看晾衣绳', 'success')).catch(error => toast('重试未完成 · ' + String(error), 'error'));
      }}>重试显示晾衣绳</button>}
      <ToggleRow
        icon="🍃"
        hue="capture"
        label="晾衣绳微风"
        desc="偶尔轻轻吹动，鼠标靠近时暂停；挂取照片的回弹仍保留"
        value={config.clothesline_wind}
        onChange={(v) => updateAndSave({ clothesline_wind: v })}
      />
      <ToggleRow
        icon="📍"
        hue="capture"
        label="锁定绳位置"
        desc="锁定两端与整体移动，照片仍可取挂"
        value={config.clothesline_locked}
        onChange={(v) => updateAndSave({ clothesline_locked: v })}
      />
      <div className={styles.sRow}>
        <SettingTile hue="capture">🧷</SettingTile>
        <div className={styles.sRowBody}>
          <div className={styles.sRowLabel}>绳子默认位置</div>
          <div className={styles.sRowDesc}>回到工作区顶部，右端避让灵动岛</div>
        </div>
        <button
          type="button"
          className={styles.sAction}
          disabled={config.clothesline_locked}
          onClick={() => void updateAndSave({ clothesline_anchors: null })}
        >
          恢复默认
        </button>
      </div>
    </>
  );
}
