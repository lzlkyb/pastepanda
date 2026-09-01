/**
 * NoteAiActions.tsx —— 笔记编辑器底部的两个 AI 按钮（B1 ＋轻量 AI）。
 *
 * 🔴 **规则 #16：受 `ai_enabled` 门控**。关着时整个组件不渲染——
 * 不是置灰、不是点了提示去开，而是**零可见、零请求、零费用**（同 useDiffAi 的口径）。
 *
 * 模型调用走变换枢纽 `getTransform(id).run()`，不自己发 IPC：
 * 出网闸、预算、缓存、用量日志都在那条路上，绕开它等于把这四样重写一遍。
 *
 * 「需要确认」（内容像密钥/个人信息）不是错误，是正常分支：弹确认框，用户同意后带 force 重跑。
 */
import { useCallback, useState } from "react";
import { Sparkles, Tags } from "lucide-react";
import { isAiAvailable } from "@/lib/transforms";
import { getTransform } from "@/lib/transforms/registry";
import { useToast } from "@/components/Toast";
import { confirmDialog } from "@/lib/confirm";
import { noteSetSummary, noteAddAiTags } from "@/lib/api";

/** 跑一个 AI 动作，处理「需要确认」分支。返回模型输出，失败/取消返回 null。 */
async function runAi(
  actionId: string,
  text: string,
  toast: (m: string, k?: "success" | "error") => void,
): Promise<string | null> {
  const t = getTransform(actionId);
  if (!t) {
    toast("AI 服务未就绪", "error");
    return null;
  }
  let r = await t.run(text);

  // 出网闸：内容像密钥或个人信息时后端不发，等用户明确同意。
  // 这里必须真的问一句，不能直接带 force 重跑——那就把这道门废了。
  if (!r.ok && r.meta?.needsConfirm) {
    const ok = await confirmDialog({
      title: "内容含敏感信息",
      message: r.message || "这段内容含敏感信息，发送到云端意味着它会离开这台电脑。确认继续吗？",
      confirmText: "仍然发送",
    });
    if (!ok) return null;
    r = await t.run(text, { force: true });
  }

  if (!r.ok || r.output == null) {
    toast(r.message || "AI 执行失败", "error");
    return null;
  }
  return r.output;
}

export function NoteAiActions({
  noteId,
  title,
  content,
  onSummary,
  onTags,
  btnClass,
}: {
  /** 未保存的新笔记为 null：没有 id 就无处可写，按钮不渲染 */
  noteId: string | null;
  /** 按钮样式类。两个宿主（弹窗 / 第三栏）的底部样式不同，由宿主传自己的 ghostBtn */
  btnClass: string;
  title: string;
  content: string;
  /** 摘要已写入库，宿主刷新展示 */
  onSummary: (summary: string) => void;
  /** 新增了哪几个标签，宿主刷列表 */
  onTags: (added: string[]) => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<"summary" | "tags" | null>(null);

  // 门控：关着就什么都不渲染（规则 #16）
  const aiOk = isAiAvailable();

  const handleSummary = useCallback(async () => {
    if (!noteId) return;
    setBusy("summary");
    // 标题一并发：一篇只有“详见上文”的笔记，标题往往是唯一的主题信息
    const out = await runAi("ai-summarize", `${title}\n\n${content}`, toast);
    if (out !== null) {
      const one = out.trim().split("\n")[0].trim();
      if (await noteSetSummary(noteId, one)) {
        onSummary(one);
        toast("已生成摘要", "success");
      }
    }
    setBusy(null);
  }, [noteId, title, content, toast, onSummary]);

  const handleTags = useCallback(async () => {
    if (!noteId) return;
    setBusy("tags");
    const out = await runAi("ai-note-tags", `${title}\n\n${content}`, toast);
    if (out !== null) {
      const added = await noteAddAiTags(noteId, out);
      if (added !== null) {
        onTags(added);
        // 一个都没新增也要说清楚，否则看上去像没反应（规则 #15.3）
        toast(
          added.length > 0 ? `已添加标签：${added.join("、")}` : "没有新标签（建议的都已存在）",
          "success",
        );
      }
    }
    setBusy(null);
  }, [noteId, title, content, toast, onTags]);

  if (!aiOk || !noteId) return null;

  return (
    <>
      <button
        type="button"
        className={btnClass}
        onClick={() => void handleSummary()}
        disabled={busy !== null}
        title="用 AI 生成一行摘要（内容会发到云端）"
      >
        <Sparkles size={12} /> {busy === "summary" ? "生成中…" : "摘要"}
      </button>
      <button
        type="button"
        className={btnClass}
        onClick={() => void handleTags()}
        disabled={busy !== null}
        title="用 AI 建议几个标签（内容会发到云端）"
      >
        <Tags size={12} /> {busy === "tags" ? "建议中…" : "标签"}
      </button>
    </>
  );
}
