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

/** 文章全文（「文章 → 知识库」阶段 2）。图片已由后端落盘为 file:/// 引用。 */
export interface UrlArticle {
  /** 重定向后的最终 URL */
  url: string;
  title: string;
  /** 作者/公众号名（og:article:author，可能为空串） */
  author: string;
  /** 正文根节点 HTML（未截断，清洗在前端 htmlToMarkdown 做） */
  html: string;
}

/** 抓取文章全文。失败 reject 的是后端人话错误（站点反爬/需登录/无正文）。 */
export async function fetchUrlArticle(url: string): Promise<UrlArticle> {
  return invoke("fetch_url_article", { url });
}
