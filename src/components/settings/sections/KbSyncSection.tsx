import type { AppConfig } from "@/stores/appStore";
import { useToast } from "@/components/Toast";
import { logger } from "@/lib/logger";
import { ToggleRow } from "../ToggleRow";
import { KbSyncPanel } from "../KbSyncPanel";
import styles from "../../Settings.module.css";

interface KbSyncSectionProps {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
}

// 🔴 必须返回片段，原因同 StatsSection。
export function KbSyncSection({ config, updateAndSave }: KbSyncSectionProps) {
  const { toast } = useToast();
  return (
    <>
      {/* ── 知识库同步（M6）──
          ❗ 与上面那个**完全独立**：那个同步剪贴板，这个同步笔记。
          开关分开是因为绑在一起会逼用户做一个他不想做的选择：
          「我只想同步笔记，不想让剪贴板到处飞」。 */}
      <div className={styles.sSection}>知识库同步</div>
      <ToggleRow icon="📚" gradient="linear-gradient(135deg, #8B5CF6, #6366F1)"
        label="知识库同步" desc="在你自己的设备之间同步笔记，局域网与跨网走同一条通道"
        value={config.kb_sync_enabled ?? false}
        detailTitle="知识库同步"
        detail={<>
          <p>把知识库里的笔记在你的多台设备之间保持一致。</p>
          <p>🔒 <b>点到点直连</b>，笔记不经过任何服务器</p>
          <p>📌 <b>与上面的「局域网同步」无关</b>：那个同步剪贴板，这个同步笔记，两个开关互不影响</p>
          <p>⚠️ <b>首次要配对</b>：两台机器互相核对一串指纹，核对不上就不要确认</p>
        </>}
        onChange={async (v) => {
          await updateAndSave({ kb_sync_enabled: v });
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("toggle_kb_sync", { enable: v });
            toast(v ? "知识库同步已开启" : "知识库同步已关闭", "success");
          } catch (e) {
            // 不静默（规则 #15.3）：开关拨了却没真的启起来，
            // 用户会看着一个「已开启」的开关等一辈子
            logger.warn("切换知识库同步失败", e);
            await updateAndSave({ kb_sync_enabled: !v });
            toast(`知识库同步切换失败：${e instanceof Error ? e.message : String(e)}`, "error");
          }
        }} />
      {config.kb_sync_enabled && <KbSyncPanel toast={toast} />}

      {/* ❗ 知识库 MCP 服务已搬到**独立的 MCP tab**（A-61 ③，见 `McpTab.tsx`）。
          两个理由：它原先就接在本节后面（用知识库的人要一直往下翻）；
          而且 tab 是条件渲染的——放在这里等于一打开设置页就开始 5s 轮询。 */}
    </>
  );
}
