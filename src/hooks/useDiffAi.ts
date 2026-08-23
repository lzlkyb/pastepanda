import { useState, useCallback } from "react";
import { getTransform, isAiAvailable } from "@/lib/transforms";

export type DiffSide = "left" | "right";

export interface DiffAiAction {
  id: string;
  label: string;
  /** 特殊动作：用 ai-summarize 解释两侧差异（输入为左右拼接） */
  explain?: boolean;
}

/**
 * 文本 diff 编辑器的 AI 闭环动作清单。
 * 前三个是通用 AI 变换（ai-translate / ai-rewrite / ai-summarize），
 * 最后一个「解释差异」是 diff 专属：把左右文本拼成对比体喂给 ai-summarize。
 */
export const DIFF_AI_ACTIONS: DiffAiAction[] = [
  { id: "ai-translate", label: "翻译" },
  { id: "ai-rewrite", label: "润色" },
  { id: "ai-summarize", label: "总结" },
  { id: "explain-diff", label: "解释差异", explain: true },
];

/**
 * diff 编辑器的 AI 闭环：对一个目标侧文本调用 AI 变换，把结果写回**对侧**
 * （解释差异则覆盖右侧），随后由调用方切到预览态实时重算 diff。
 *
 * 门控严格遵循 ai_enabled 红线：aiOk 为假时菜单整条不渲染、run 直接 no-op，
 * 保证「未启用 = 零可见零请求零费用」；运行期 getTransform 走后端 aiRun，
 * 后端对未启用/无密钥再拒一次（双重校验）。
 */
export function useDiffAi(opts: {
  leftText: string;
  rightText: string;
  onResult: (side: DiffSide, text: string) => void;
  toast: (msg: string, kind?: "success" | "error") => void;
}) {
  const { leftText, rightText, onResult, toast } = opts;
  const aiOk = isAiAvailable();
  const [runningId, setRunningId] = useState<string | null>(null);

  const run = useCallback(
    async (action: DiffAiAction, targetSide: DiffSide) => {
      if (!aiOk) return;
      const input = action.explain
        ? `旧版本内容：\n${leftText}\n\n新版本内容：\n${rightText}\n\n请解释这两段内容的主要差异点。`
        : targetSide === "left"
          ? leftText
          : rightText;
      const transformId = action.explain ? "ai-summarize" : action.id;
      const t = getTransform(transformId);
      if (!t) {
        toast("该 AI 动作暂不可用（AI 服务未就绪）", "error");
        return;
      }
      setRunningId(action.id);
      try {
        const r = await t.run(input);
        if (r.ok && r.output != null) {
          // 解释差异覆盖右侧；其余写入对侧（左→右 / 右→左）
          const outSide: DiffSide = action.explain ? "right" : targetSide === "left" ? "right" : "left";
          onResult(outSide, r.output);
          toast(`已应用「${action.label}」`, "success");
        } else {
          toast(r.message || "AI 执行失败", "error");
        }
      } catch {
        toast("AI 执行失败，请稍后重试", "error");
      } finally {
        setRunningId(null);
      }
    },
    [aiOk, leftText, rightText, onResult, toast],
  );

  return { aiOk, runningId, run };
}
