/**
 * 应用信息 API — 版本号、应用名
 */
import { invoke } from "@tauri-apps/api/core";

/** 版本号运行期不变 → 模块级缓存，避免多处（App/TopBar/设置/胶囊）重复 invoke */
let cachedVersion: string | null = null;

/** 获取应用版本号 */
export async function getAppVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  try {
    cachedVersion = await invoke<string>("get_app_version");
    return cachedVersion;
  } catch {
    return "?.?.?";
  }
}

/** 获取应用名称 */
export async function getAppName(): Promise<string> {
  try {
    return await invoke<string>("get_app_name");
  } catch {
    return "PastePanda";
  }
}
