/**
 * api/url.ts —— 链接摘要后端接口（v6.4 六大王牌 A，阶段 1 本地抓页）。
 */

import { invoke } from "@tauri-apps/api/core";

export interface UrlSummary {
  url: string;
  title: string;
  /** 正文粗文本（截断，前端展示/后续 AI 精炼用） */
  text: string;
}

/** 抓取 URL 并返回粗摘要（本地抓页 + 正文提取，零 AI 成本） */
export async function fetchUrlSummary(url: string): Promise<UrlSummary> {
  return invoke("fetch_url_summary", { url });
}
