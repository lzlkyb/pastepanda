/**
 * 预览面板头的任务进度（「已勾选 12/31」）。
 *
 * 全文 lexer 只值这个价：每次击键都跑一遍不值得，拖 200ms 更新没人察觉。
 * 不定位、只统计（`countTaskProgress`），所以即使文档结构异常也不会少算项 ——
 * 进度条是给「这份 review 文档还剩几项」用的，不是写回依据。
 */
import { useEffect, useState } from "react";
import { countTaskProgress } from "@/lib/markdown/tasks";

export interface TaskProgress {
  done: number;
  total: number;
}

export function useTaskProgress(text: string, enabled: boolean): TaskProgress | null {
  const [progress, setProgress] = useState<TaskProgress | null>(null);

  useEffect(() => {
    if (!enabled) {
      setProgress(null);
      return;
    }
    const timer = setTimeout(() => {
      const { done, total } = countTaskProgress(text);
      setProgress(total > 0 ? { done, total } : null);
    }, 200);
    return () => clearTimeout(timer);
  }, [text, enabled]);

  return progress;
}
