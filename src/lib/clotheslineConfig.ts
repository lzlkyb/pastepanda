import { listen } from "@tauri-apps/api/event";
import { useAppStore, type AppConfig } from "@/stores/appStore";
import { logger } from "./logger";

// 绳窗口保存的是配置补丁；主窗口同步内存即可，不能再次保存形成广播回环。
export async function startClotheslineConfigSync(report: (message: string) => void) {
  const off = await Promise.all([
    listen<Partial<AppConfig>>("clothesline-config-changed", (event) =>
      useAppStore.getState().updateConfig(event.payload),
    ),
    listen<string>("clothesline-error", (event) => report(event.payload)),
  ]).catch((error) => {
    logger.warn("晾衣绳设置同步未能启动", error);
    return [];
  });
  const stop = () => off.forEach((fn) => fn());
  window.addEventListener("pagehide", stop, { once: true });
  return stop;
}
