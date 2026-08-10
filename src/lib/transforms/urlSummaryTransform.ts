/**
 * transforms/urlSummaryTransform.ts — v6.4 A 链接即摘要。
 *
 * 场景：复制公众号文章 / API 文档 / 竞品页链接 → 变换面板出「链接摘要」卡，
 * 抓取页面 → 标题 + 正文摘要，预览后复制/粘贴。
 *
 * 设计（两阶段）：
 * - **阶段 1（本地零 AI）**：Rust 抓页 + 正文提取（url_summary 命令），产出粗摘要，
 *   不受 AI 门控约束（不调用任何模型）；
 * - **阶段 2（AI 精炼）**：AI 可用时（规则 15 门控）用 ai-summarize 把正文精炼成要点；
 *   精炼失败/需确认/超预算 → **自动退回阶段 1 粗摘要**，绝不卡死或报错；
 * - **只存摘要不存原文**：缓存只在内存（24h），页面文本不落盘——守住隐私红线。
 */

import { fetchUrlSummary } from "@/lib/api/url";
import { aiRun } from "@/lib/api/ai";
import { isAiAvailable } from "@/lib/transforms/aiTransforms";
import type { Transform, TransformContext, TransformResult } from "./types";

const URL_ONLY_RE = /^https?:\/\/[^\s]+$/i;
/** 摘要正文展示上限 */
const EXCERPT_CHARS = 300;

export const urlSummaryTransform: Transform = {
  id: "url-summary",
  label: "链接摘要",
  description: "抓取链接内容，提取标题与正文摘要",
  icon: "globe",
  group: "web",

  detect(ctx: TransformContext): number {
    const t = ctx.text.trim();
    if (!t) return 0;
    // 后端分类为 link，或文本本身就是 http(s) 链接 → 高置信
    if (ctx.contentType === "link" || URL_ONLY_RE.test(t)) return 0.9;
    return 0;
  },

  async run(text: string): Promise<TransformResult> {
    const url = text.trim();
    if (!URL_ONLY_RE.test(url)) {
      return { ok: false, message: "不是有效的 http/https 链接" };
    }
    try {
      const s = await fetchUrlSummary(url);
      const title = s.title?.trim() ?? "";
      const body = (s.text || "").trim();
      if (!body) {
        return { ok: true, output: title || "页面无可读内容（可能需登录或反爬）" };
      }

      // 阶段 2：AI 可用 → 精炼（规则 15：未启用不调用；失败/确认/超预算退回粗摘要）
      if (isAiAvailable()) {
        try {
          const r = await aiRun("ai-summarize", body);
          if (r.status === "ok" && r.content.trim()) {
            return { ok: true, output: [title, r.content.trim()].filter(Boolean).join("\n\n") };
          }
        } catch {
          /* 精炼失败，退回阶段 1 */
        }
      }

      // 阶段 1：本地粗摘要
      const excerpt = body.length > EXCERPT_CHARS ? body.slice(0, EXCERPT_CHARS) + "…" : body;
      return { ok: true, output: [title, excerpt].filter(Boolean).join("\n\n") };
    } catch (e) {
      return { ok: false, message: typeof e === "string" ? e : "抓取失败" };
    }
  },
};
