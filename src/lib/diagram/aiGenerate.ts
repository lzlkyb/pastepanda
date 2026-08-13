/**
 * 流程图 AI 能力（红线 #16：入口仅在 AI 可用时渲染，由 UI 门控，
 * 本文件不自行判断，只负责「调 AI → 解析 mermaid → 文档」）。
 *
 * 三个函数各走**专用的后端动作**（ai-diagram / ai-diagram-expand / ai-diagram-label），
 * 提示词写在后端的 prompt 模板里，这里只传用户内容。
 *
 * **不要退回 ai-rewrite 并把指令拼进 text**：ai-rewrite 的模板是
 * 「用 X 的语气改写下面的内容，保持原意不变：{内容}」。指令落进内容槽之后，
 * 模型执行的是「把这段指令换个语气重写」，返回一段散文，解析必然 0 节点；
 * 而且「保持原意不变」与「生成流程图」本身就是两条相互冲突的指令。
 */
import { aiRun, type AiRunResponse } from "@/lib/api/ai";
import { parseMermaid, type DiagramDoc } from "./types";

// 注：extractMermaid / parseMermaid 已迁至 ./types（纯逻辑归属地，与 toMermaid
// 形成 mermaid 双向互操作闭环），本文件仅负责 AI 调用与解析编排。

/** 报错时回显的模型原文长度 */
const SNIPPET_CHARS = 120;

/**
 * 三态返回收敛成「内容或抛错」。
 * needsConfirm / budgetExceeded 不是异常，但对画布没有分支可走，统一转成错误文案。
 */
function takeContent(res: AiRunResponse): { content: string; truncated: boolean } {
  if (res.status === "needsConfirm") throw new Error(res.reason || "内容含敏感信息，需要确认后才能发送");
  if (res.status === "budgetExceeded") throw new Error("AI 额度已用尽");
  return { content: res.content, truncated: res.truncated };
}

/** 把模型原文压成一行短摘要 */
function echoBack(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "（模型返回了空内容）";
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat;
}

/**
 * 解析模型返回的 mermaid。
 *
 * 失败时把原文片段带进错误：旧文案只说「请换个说法重试」，把人往错误方向引——
 * 真正的失败原因几乎总是「模型没按格式返回」，得看到它到底吐了什么才能判断。
 */
function parseOrThrow(content: string, truncated: boolean): DiagramDoc {
  const doc = parseMermaid(content);
  if (doc.nodes.length > 0) return doc;
  if (truncated) {
    throw new Error("结果被 token 上限截断，没拿到完整的流程图，请把需求说得更短一些");
  }
  throw new Error(`模型没有返回可识别的 Mermaid 流程图。它实际返回的是：${echoBack(content)}`);
}

/** 一句话需求 → 流程图文档 */
export async function generateDiagramFromPrompt(prompt: string): Promise<DiagramDoc> {
  const { content, truncated } = takeContent(await aiRun("ai-diagram", prompt));
  return parseOrThrow(content, truncated);
}

/** 润色节点文字：只改文字，不改结构 */
export async function polishNodeLabel(label: string): Promise<string> {
  const { content } = takeContent(await aiRun("ai-diagram-label", label));
  // 后端模板已要求「不要引号、不要 Markdown」，这里只做兜底清理。
  // 只剥围栏标记而不是整块删除：旧写法 /^```[\s\S]*?```$/ 会把整段内容一起干掉，
  // 模型一旦带了围栏就返回空字符串，表现成「润色后标签没了」。
  return content
    .trim()
    .replace(/^```[^\n]*\n?|\n?```$/g, "")
    .replace(/^["'`]|["'`]$/g, "")
    .trim();
}

/** 把一个节点展开成子流程（节点 id 由调用方重映射避免冲突） */
export async function expandSubflow(label: string): Promise<DiagramDoc> {
  const { content, truncated } = takeContent(await aiRun("ai-diagram-expand", label));
  return parseOrThrow(content, truncated);
}
