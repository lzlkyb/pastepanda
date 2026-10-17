import { maskSensitiveText } from "@/lib/mask";
import type { ChainStepCondition } from "./types";

/**
 * 步骤执行条件判定（v6.3，纯本地规则零 LLM）：
 * - `always`（缺省）：无条件，恒执行；
 * - `is-json`：内容可被 JSON.parse（对象或数组）；
 * - `contains-secret`：内容里识别出密钥/手机号/邮箱/身份证/IP；
 * - `is-code`：内容像代码（函数/类/关键字/分号等结构化特征）。
 */
export function matchesCondition(
  cond: ChainStepCondition | undefined,
  text: string,
): boolean {
  if (!cond || cond.type === "always") return true;
  const t = (text || "").trim();
  switch (cond.type) {
    case "is-json": {
      try {
        JSON.parse(t);
        return true;
      } catch {
        return false;
      }
    }
    case "contains-secret":
      return maskSensitiveText(t).count > 0;
    case "is-code":
      return (
        t.length > 20 &&
        /(function\s|class\s|import\s|const\s|let\s|=>|\{[\s\S]*\}|;)/.test(t)
      );
    default:
      return true;
  }
}

