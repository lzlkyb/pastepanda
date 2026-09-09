/**
 * hooks/useFirstSight.ts —— L4：一个区块**第一次真的出现内容**时，多说一句。
 *
 * # 为什么不是空态教学（L3）
 *
 * L3 的前提是空态能给出**可执行的下一步**（新建 / 清筛选）。
 * 而「可存为笔记」「可合成笔记」这类区块的内容是**系统在合适时机产出**的，
 * 空的时候用户没有任何「点了就不空」的动作——露空态只会在顶部常年挂空壳。
 * 所以发现性靠这个：等它**真的有东西**那一次，再解释它是什么。
 *
 * # 两个容易写错的地方
 *
 * 1. **判定只在挂载时取一次**（`useState` 初始化函数）。
 *    每次渲染都读一遍的话，标记一写提示就当场消失了，用户根本来不及读。
 * 2. **标记在真的有内容时才写**（`seen` 参数）。
 *    挂载就写的话，一个从来没见过内容的用户会被算成「看过了」，
 *    等他真有内容那天反而什么提示都没有。
 */
import { useEffect, useState } from "react";
import { logger } from "@/lib/logger";

function storageKey(id: string): string {
  return `pp.firstSight.${id}`;
}

/**
 * @param id   区块标识，进 `localStorage` 的 key
 * @param seen 本次是否**真的有内容**。只有它为 true 时才记「已见过」
 * @returns 本次会话要不要显示首次说明
 */
export function useFirstSight(id: string, seen: boolean): boolean {
  // 只在挂载时取一次：下面的 effect 一写标记，它也不会跟着变 false，
  // 提示因此能在本次会话里完整地给用户读完。
  const [firstSight] = useState(() => {
    try {
      return localStorage.getItem(storageKey(id)) === null;
    } catch {
      // 读不到就当作不是首次：宁可少说一句，也不要每次启动都弹同一句
      return false;
    }
  });

  useEffect(() => {
    if (!seen) return;
    try {
      localStorage.setItem(storageKey(id), "1");
    } catch (e) {
      logger.warn("首次说明标记写入失败", e);
    }
  }, [id, seen]);

  return firstSight && seen;
}
