/**
 * hooks/useActionEventLog.ts —— 动作使用日志埋点（v6.0 action_events）。
 *
 * 变换枢纽、卡片动作条（v6.0 后续）、托盘弹窗都会埋「这个动作被复制/粘贴过」，
 * 抽成 Hook 避免每个组件各自拼一遍字段，也方便统一口径。
 *
 * **只记元信息**：动作 id + 内容类型 + 来源应用 + 时段 + 结果，
 * 不含任何内容文本（后端表里根本没有那些字段）。
 * fire-and-forget：写不进去也只是少一条统计，绝不能拖慢复制/粘贴本身。
 */
import { useCallback } from "react";
import { logActionEvent, type ActionOutcome } from "@/lib/api/actionEvents";
import { cleanSourceName } from "@/lib/utils";
import type { Transform } from "@/lib/transforms";

/**
 * 返回埋点函数 `log(t, outcome)`。
 *
 * `t` 接受 `Transform` 或**裸 actionId 字符串**：卡片右键的粘贴变换里有一批
 * 不走注册表的分支（`md_image` / `img_base64` / `file_name`，它们依赖 item.content）。
 * 强求 Transform 对象会让这几个真实被使用的动作永远记不上账。
 *
 * @param contentType 当前内容的类型（与变换上下文一致，如 json / code / text）
 * @param sourceApp   原始来源应用名；内部会用 SOURCE_MAP 规范化，未知传空串
 */
export function useActionEventLog(contentType: string, sourceApp?: string) {
  return useCallback(
    (t: Transform | string, outcome: ActionOutcome) => {
      logActionEvent({
        actionId: typeof t === "string" ? t : t.id,
        contentType,
        sourceApp: cleanSourceName(sourceApp ?? ""),
        hour: new Date().getHours(),
        outcome,
      });
    },
    [contentType, sourceApp],
  );
}
