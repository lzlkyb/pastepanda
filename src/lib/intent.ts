/**
 * lib/intent.ts —— 意图识别引擎（V3-A，"有思想"的第一步）。
 *
 * 从「推荐单个动作」升级为「理解你在做什么」：结合当前内容（类型+文本）
 * 与最近复制，推断用户当前的任务意图，给出**任务级建议**
 * （主动作 + 备选动作集），而非孤立动作。
 *
 * 关于场景（时段+来源）：**意图层不使用它**。detectIntent 保留 scene 参数只是为了
 * 和 recommendScored 的调用形态一致（suggest.ts 按这个形态传），函数体一次都没引用。
 * 时段/来源感知确实存在，但在 recommend.ts 的 recommendScored 里，作用于 top-1
 * 单动作建议的排序加成，不在意图层。（此处旧注释曾声称意图层「结合场景」，与实现不符。）
 *
 * 设计取舍：
 * - **纯规则 v1、零 LLM 零出网**：意图判定是确定性规则，毫秒级、可测；
 *   置信度足够高才返回（宁可漏报不可误报，主动建议是打断，做错一次用户就永久
 *   关掉这个功能）——所以每条规则都要求「内容类型 + 文本特征」双重证据，
 *   不靠单个关键字或单个标点定案；
 * - **复用现有资产**：意图的 actionIds 全部指向现有变换，不新增执行路径；
 *   画像角色加成（v2）已作用在 recommendScored 排序上，意图层不重复叠加；
 *
 *   ⚠ **但“指向现有变换”不等于“运行时一定在注册表里”。** 这里写死的 AI 动作名
 *   （ai-explain-code / ai-key-points / ai-json-to-type / ai-summarize / ai-polish /
 *   ai-tabulate / url-summary）定义在后端 `ai/actions.rs`，由 aiTransforms.ts 在
 *   **运行时**注册进前端注册表——AI 未启用/未配 Key 时它们根本不存在，
 *   而那是新用户的默认状态。本文件是纯规则层，不查注册表；
 *   存在性校验在 `suggest.ts` 的 `suggestIntent()` 里做（主动作不在表里 → 整个意图作废）。
 *   旧注释曾声称“全部指向**已注册**变换”，那个假设就是那个 bug 的根源：
 *   建议条会承诺一个不存在的动作，用户点「使用」完全无反应。
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
/**
 * 排错意图的内容类型门槛：只有这三类算「机器内容」，里面出现报错关键字基本一定是真报错。
 * 绝不能把 "text" 放进来——它是分类器认不出时的兜底类型，也就是最常见的类型，
 * 放进来等于这道门槛不存在。
 */
const CODEISH_CT = new Set(["code", "log", "shell"]);
/**
 * 堆栈级证据。内容类型不是机器内容（尤其是 text）时，只有命中这些特征才认定在排错：
 * 中文日常里「活动失败了」「订单异常」「登录失败」实在太多，而排错意图置信度最高、
 * 会压过所有其它建议，误报的代价远大于漏报。
 */
const STACK_RE =
  /(?:^|\n)\s*at\s+[\w$.<>]+\s*\(|Traceback \(most recent call last\)|File "[^"]+", line \d+|(?:^|\n)\s*Caused by:|Exception in thread|[\w./\\-]+\.[a-z]{1,5}:\d+:\d+/i;
/**
 * 财务意图排除的内容类型：这些内容里的 $ 几乎都是位置参数 / 捕获组 / 模板变量，不是钱。
 * finance 原本是唯一没有内容类型门槛的意图，而本工具的用户成天复制 shell 和 SQL。
 */
const MACHINE_CT = new Set(["code", "shell", "sql", "config", "json", "xml", "yaml"]);
/**
 * 金额。¥ / ￥ / 人民币 / 元 / usd / eur 这些前缀本身就是强信号；裸 $ 太廉价
 * （shell 的 $1、sed 的 $2、各种模板变量都长这样），所以对它额外要求：前面不是单词字符
 * 也不是另一个 $，且数字至少两位或带小数——宁可漏掉「$5」，也不要把「$1」当成金额。
 * 需要 g 标记，String#match 才返回全部匹配（match 会把 lastIndex 归零，模块级共享无副作用）。
 */
const MONEY_G_RE =
  /(?:¥|￥|usd|eur|人民币|元)\s*\d+(?:[.,]\d+)?|(?<![\w$])\$\s*(?:\d{2,}(?:[.,]\d+)?|\d+[.,]\d+)/gi;
/** URL 计数：内联 g 正则（同 MONEY_G_RE 理由） */
const URL_G_RE = /https?:\/\/[^\s"'<>]+/gi;
/** URL 判定（无 g，test 用，无 lastIndex 残留） */
const URL_RE = /https?:\/\/[^\s"'<>]+/i;

/**
 * 各意图的置信度 = 显式优先级（排错 > JSON > 批量 > 收集 > 财务 > 提炼）。
 *
 * 以前 json-shape 与 batch 都是 0.85，谁排前面全靠 Array#sort 的稳定性加上 push 顺序
 * 碰巧对上——调换一下判定块的位置就会静默翻转。这里把顺序落到数值上，让它可读且不脆。
 * JSON 压批量是**有意的取舍**而非巧合：ct === "json" 来自后端分类器的真实检测，
 * 比「≥3 个同类值」这种正则计数硬得多。
 */
const CONF = {
  troubleshoot: 0.9,
  jsonShape: 0.86,
  batch: 0.85,
  collectLinks: 0.8,
  finance: 0.75,
  digest: 0.7,
} as const;

/**
 * 从单个内容推断意图（主入口）。
 *
 * @param ctx      当前剪贴板内容（text + contentType）
 * @param scene    场景（时段桶 + 来源类别，可空）。**意图层尚未使用**：参数只接受不消费，
 *                 保留它是为了与 recommendScored 的调用形态一致。时段/来源感知实际发生在
 *                 recommend.ts 的 recommendScored（作用于 top-1 单动作建议的排序加成）。
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

  // 1) 排错意图：机器内容里的报错关键字，或普通文本里的真堆栈
  if (ERR_RE.test(text)) {
    // 原来的 /[;{}<>]/ 兜底同样太弱（一个分号或一对书名号就够），一并去掉：
    // 内容类型认不出时宁可漏报，也不要靠标点猜「这是代码」。
    const hasStack = text.includes("\n") && STACK_RE.test(text);
    if (CODEISH_CT.has(ct) || hasStack) {
      candidates.push({
        id: "troubleshoot",
        label: "看起来你在排错",
        actionsText: "解释代码 → 提取要点",
        actionIds: ["ai-explain-code", "ai-key-points"],
        confidence: CONF.troubleshoot,
      });
    }
  }

  // 2) JSON / 结构化意图
  // ct === "json" 是后端 ContentClassifier 真检测出来的结论，直接信（内容被截断也照样信）；
  // 只看首字符的形状兜底则必须真能 parse——否则 "[INFO] ... request completed" 这种最常见的
  // 日志行、"[1] 参考文献"、markdown 链接 "[文字](url)" 都会被判成「这是一组数据」。
  const braced = text.startsWith("{") || text.startsWith("[");
  if (ct === "json" || (braced && parsesAsJsonContainer(text))) {
    const isArray = text.startsWith("[");
    candidates.push({
      id: "json-shape",
      label: isArray ? "这是一组数据" : "这是 JSON",
      actionsText: isArray ? "格式化 → 转 SQL IN" : "生成类型 → 格式化",
      actionIds: isArray
        ? ["json_format", "query-result-to-sql"]
        : ["ai-json-to-type", "json_format"],
      confidence: CONF.jsonShape,
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
      confidence: CONF.collectLinks,
    });
  }

  // 4) 批量处理意图：单条内容含 ≥3 个同类值（IP / 邮箱 / 手机号）
  const ipCount = (text.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) ?? []).length;
  const emailCount = (text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/g) ?? []).length;
  // 手机号补数字边界：缺 (?<!\d)/(?!\d) 时，一长串纯数字能被切出多个假手机号
  // （同函数里 IP 的正则本来就有 \b，这条漏了）。
  const phoneCount = (text.match(/(?<!\d)1[3-9]\d{9}(?!\d)/g) ?? []).length;
  if (ipCount >= 3 || emailCount >= 3 || phoneCount >= 3) {
    candidates.push({
      id: "batch",
      label: "这是一批同类数据",
      actionsText: "合并成 SQL IN / 列表",
      actionIds: ["sql-in", "delimited-to-sql-in"],
      confidence: CONF.batch,
    });
  }

  // 5) 提炼意图：长文本
  if (text.length >= 500 && ct !== "code") {
    candidates.push({
      id: "digest",
      label: "这是一段长文本",
      actionsText: "总结要点 → 改写",
      actionIds: ["ai-summarize", "ai-key-points", "ai-polish"],
      confidence: CONF.digest,
    });
  }

  // 6) 财务意图：≥2 处金额，且不是机器内容（awk '{print $1, $2}' 曾被判成「这些是金额数据」）
  const moneyCount = MACHINE_CT.has(ct) ? 0 : (text.match(MONEY_G_RE) ?? []).length;
  if (moneyCount >= 2) {
    candidates.push({
      id: "finance",
      label: "这些是金额数据",
      actionsText: "整理成表格",
      actionIds: ["ai-tabulate"],
      confidence: CONF.finance,
    });
  }

  // 取置信度最高的意图：优先级已写进 CONF 的数值，不再依赖 sort 的稳定性与 push 顺序
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates[0] ?? null;
}

/**
 * JSON 形状兜底的强校验。JSON.parse 遇非法输入会抛，所以必须包 try；
 * 标量（数字 / 字符串 / null）也不算「结构化数据」，只认对象和数组。
 */
function parsesAsJsonContainer(s: string): boolean {
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === "object" && v !== null;
  } catch {
    return false;
  }
}
