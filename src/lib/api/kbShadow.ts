/**
 * 自动收录影子运行 API — 知识库 A 阶段（规划 §8.1 5️⃣）
 *
 * 它**不收录任何东西**，只记「如果开着会收哪几条」，一周后算准确率。
 * 准确率 ≥ 60% 才在 B2 真开自动收录。
 *
 * ❗ **全部失败都不弹 toast**：影子运行对用户不可见，它失败也不影响任何功能。
 *   弹一个用户无法理解、也无需处理的错误是噪音。唯一例外是手动点的「清空」。
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/stores/appStore";
import { logger } from "@/lib/logger";
import { toastActionFailed } from "@/lib/utils";

/** 影子运行统计。字段名与 Rust 结构体一致。 */
export interface ShadowStats {
  rule_ver: string;
  /** 规则命中过多少条 */
  hits: number;
  /** 命中且用户后来真的手动转了的 = 真正例 */
  hits_converted: number;
  /** 用户手动转的总数 */
  manual_total: number;
  /** 用户转了但规则没命中的 = 漏报 */
  missed: number;
  /** 首次命中时间（算「一周后」的基准） */
  since: string | null;
  /** 准确率。**null = 没数据**，不是 0%——两者对 B2 的结论相反 */
  precision: number | null;
}

/**
 * 跑一轮影子评估。启动时 fire-and-forget 调一次就够。
 *
 * 返回本轮命中数（失败返回 null）。调用方不需要处理返回值。
 */
export async function kbShadowRun(): Promise<number | null> {
  try {
    return await invoke<number>("kb_shadow_run", {
      workspace: useAppStore.getState().config.current_workspace,
    });
  } catch (e) {
    // 不弹 toast：用户不知道影子运行的存在，弹错只会让他困惑
    logger.warn("影子运行失败（不影响任何功能）", e);
    return null;
  }
}

/** 读出准确率统计（红线②：使用日志可见）。 */
export async function kbShadowStats(): Promise<ShadowStats | null> {
  try {
    return await invoke<ShadowStats>("kb_shadow_stats");
  } catch (e) {
    logger.warn("读取影子运行统计失败", e);
    return null;
  }
}

/** 清空影子运行记录（红线②：可删）。用户主动动作，失败要告知。 */
export async function kbShadowClear(): Promise<boolean> {
  try {
    await invoke<number>("kb_shadow_clear");
    return true;
  } catch (e) {
    logger.error("清空影子运行记录失败", e);
    toastActionFailed("清空影子运行记录", e);
    return false;
  }
}
