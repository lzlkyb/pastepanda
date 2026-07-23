/**
 * 应用信息 API — 版本号、应用名
 */
import { invoke } from "@tauri-apps/api/core";

/** 获取应用版本号 */
export async function getAppVersion(): Promise<string> {
  try {
    return await invoke<string>("get_app_version");
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
