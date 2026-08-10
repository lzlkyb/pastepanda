/**
 * lib/intent.ts —— 意图识别引擎（V3-A，"有思想"的第一步）。
 *
 * 从「推荐单个动作」升级为「理解你在做什么」：结合当前内容（类型+文本）、
 * 场景（时段+来源）与最近复制，推断用户当前的任务意图，给出**任务级建议**
 * （主动作 + 备选动作集），而非孤立动作。
 *
 * 设计取舍：
 * - **纯规则 v1、零 LLM 零出网**：意图判定是确定性规则，毫秒级、可测；
 *   置信度足够高才返回（宁可漏报不可误报，主动建议是打断）；
 * - **复用现有资产**：意图的 actionIds 全部指向已注册变换（枢纽/动作链已有），
 *   不新增执行路径；画像角色加成（v2）已作用在 recommendScored 排序上，
 *   意图层不重复叠加；
 * - **只给一个建议**：detectIntent 永远只返回置信最高的那个意图（与建议条
 *   三条硬约束一致）。
 */
import type { TransformContext } from "@/lib/transforms";
import type { Scene } from "@/lib/recommend";

/** 一个意图建议（任务级：主动作 + 备选动作集）。 */
export interface Intent {
  id: string;
  /** 意图标签（建议条主文案，如「看起来你在排错」） */
  label: string;
  /** 动作集文案（如「解释代码 → 提取要点」） */
  actionsText: string;
  /** 建议动作（按优先级；第一个是主动作） */
  actionIds: string[];
  /** 0~1 置信度 */
  confidence: number;
}

/** 排错关键字 */
const ERR_RE =
  /(error|exception|panic|traceback|failed|failure|crash|报错|异常|崩溃|失败|堆栈|出问题)/i;
/** 金额：内联 g 正则（每次新建，避免 lastIndex 残留；match 需 g 才返回全部） */
const MONEY_G_RE = /(?:¥|￥|\$|usd|eur|人民币|元)\s*\d+(?:[.,]\d+)?/gi;
/** URL 计数：内联 g 正则（同 MONEY_G_RE 理由） */
const URL_G_RE = /https?:\/\/[^\s"'<>]+/gi;
/** URL 判定（无 g，test 用，无 lastIndex 残留） */
const URL_RE = /https?:\/\/[^\s"'<>]+/i;

/**
 * 从单个内容推断意图（主入口）。
 *
 * @param ctx      当前剪贴板内容（text + contentType）
 * @param scene    场景（时段桶 + 来源类别，可空）
 * @param recents  最近复制（按时间倒序，可空；供「连续同类」类意图使用）
 * @returns 置信度最高的意图；不确定时返回 null（走原有单动作建议）
 */
export function detectIntent(
  ctx: TransformContext,
  scene?: Scene,
  recents?: { text: string }[],
): Intent | null {
  const text = (ctx.text || "").trim();
  if (!text) return null;
  const ct = ctx.contentType || "";

  const candidates: Intent[] = [];

  // 1) 排错意图：报错特征 + 代码/日志/终端类内容
  if (ERR_RE.test(text)) {
    const isCodeish = ["code", "log", "shell", "text"].includes(ct) || /[;{}<>]/.test(text);
    if (isCodeish) {
      candidates.push({
        id: "troubleshoot",
        label: "看起来你在排错",
        actionsText: "解释代码 → 提取要点",
        actionIds: ["ai-explain-code", "ai-key-points"],
        confidence: 0.9,
      });
    }
  }

  // 2) JSON / 结构化意图：JSON 内容
  if (ct === "json" || text.trim().startsWith("{") || text.trim().startsWith("[")) {
    const isArray = text.trim().startsWith("[");
    candidates.push({
      id: "json-shape",
      label: isArray ? "这是一组数据" : "这是 JSON",
      actionsText: isArray ? "格式化 → 转 SQL IN" : "生成类型 → 格式化",
      actionIds: isArray
        ? ["json_format", "query-result-to-sql"]
        : ["ai-json-to-type", "json_format"],
      confidence: 0.85,
    });
  }

  // 3) 收集链接意图：单条含 ≥2 URL 或最近连续 ≥2 链接
  const urlCount = (text.match(URL_G_RE) ?? []).length;
  const recentUrls = (recents ?? [])
    .slice(0, 3)
    .filter((r) => URL_RE.test(r.text)).length;
  if (urlCount >= 2 || (recentUrls >= 2 && urlCount >= 1)) {
    candidates.push({
      id: "collect-links",
      label: "你在收集链接",
      actionsText: "链接摘要 → 总结",
      actionIds: ["url-summary", "ai-summarize"],
      confidence: 0.8,
    });
  }

  // 4) 批量处理意图：单条内容含 ≥3 个同类值（IP / 邮箱 / 手机号）
  const ipCount = (text.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) ?? []).length;
  const emailCount = (text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/g) ?? []).length;
  const phoneCount = (text.match(/1[3-9]\d{9}/g) ?? []).length;
  if (ipCount >= 3 || emailCount >= 3 || phoneCount >= 3) {
    candidates.push({
      id: "batch",
      label: "这是一批同类数据",
      actionsText: "合并成 SQL IN / 列表",
      actionIds: ["sql-in", "delimited-to-sql-in"],
      confidence: 0.85,
    });
  }

  // 5) 提炼意图：长文本
  if (text.length >= 500 && ct !== "code") {
    candidates.push({
      id: "digest",
      label: "这是一段长文本",
      actionsText: "总结要点 → 改写",
      actionIds: ["ai-summarize", "ai-key-points", "ai-polish"],
      confidence: 0.7,
    });
  }

  // 6) 财务意图：≥2 处金额
  const moneyCount = (text.match(MONEY_G_RE) ?? []).length;
  if (moneyCount >= 2) {
    candidates.push({
      id: "finance",
      label: "这些是金额数据",
      actionsText: "整理成表格",
      actionIds: ["ai-tabulate"],
      confidence: 0.75,
    });
  }

  // 取置信度最高的意图（排错 > JSON > 批量 > 收集 > 财务 > 提炼的默认顺序靠 confidence 表达）
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates[0] ?? null;
}
