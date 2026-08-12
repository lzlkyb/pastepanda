/**
 * useSourceIcon —— 来源图标双模式解析的**唯一逻辑源**（规则 #11）。
 *
 * 为什么抄出来：「读 config.source_icon_mode → 查 realIconCache[cacheKey]
 * → useEffect 里 fetchRealSourceIcon」这三件套曾经在 SourceBadge / Sidebar /
 * TopBar / GeneralTab 里各写了一份，而 AI 快捷栏的目标摘要行**抄漏了**
 * —— 只调 resolveSource() 拿 emoji。source_icon_mode 默认值是 "app"，
 * 所以默认配置下卡片显示真实 exe 图标、AI 栏独自显示 emoji。
 * 图标模式以后再加一档，改这里一处就行。
 *
 * 样式不包进来：各调用方的尺寸差很远（卡片是 18px 胶囊、AI 栏是 10.5px
 * 素行），所以只返回数据，由调用方自己决定用 <img> 还是写 emoji。
 */
import { useEffect } from "react";
import { resolveSource, fetchRealSourceIcon } from "@/lib/source-mappings";
import { useAppStore } from "@/stores/appStore";

export interface SourceIconInfo {
  /** 清洗后的展示名（与 resolveSource 同一口径，已截断） */
  displayName: string;
  /** 预设 emoji：emoji 档直接用它，app 档在真实图标到位前当占位 */
  emoji: string;
  /**
   * 真实应用图标的 asset:// URL。
   * **仅 app 档且已提取完成时有值**；emoji 档永远是 undefined，
   * 这样调用方只需 `realIconUrl ? <img> : emoji` 一个三元，不用再判一次模式。
   */
  realIconUrl?: string;
}

/**
 * @param source     原始来源（窗口标题）
 * @param sourceIcon 数据库里存的图标文件名；**优先作为缓存 key**（同应用共享，
 *                   而窗口标题每条都不一样，拿它做 key 会每条都重新提取一次）
 */
export function useSourceIcon(source: string | undefined | null, sourceIcon?: string | null): SourceIconInfo {
  const mode = useAppStore((s) => s.config.source_icon_mode);
  const cacheKey = sourceIcon || source || "";
  const cached = useAppStore((s) => s.realIconCache[cacheKey]);

  // 提取本身带全局去重与缓存（fetchRealSourceIcon 内部 pendingExtractions），
  // 所以多个组件同时要同一个图标不会重复发请求，这里无需再守一道。
  useEffect(() => {
    if (source && mode === "app") {
      void fetchRealSourceIcon(source, sourceIcon);
    }
  }, [source, sourceIcon, mode]);

  const { displayName, icon } = resolveSource(source || "");
  return {
    displayName,
    emoji: icon,
    // cached 可能是 null（提取过但该应用没图标，已缓存这个「没有」的结论），
    // 得归一成 undefined，否则 <img src={null}> 会发一个指向当前页的空请求
    realIconUrl: mode === "app" ? (cached ?? undefined) : undefined,
  };
}
