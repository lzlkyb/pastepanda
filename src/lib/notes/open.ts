/**
 * 「打开某张卡片的笔记」的唯一入口（规则 #11 收口）。
 *
 * 三个地方要用它：右键菜单「转为/编辑笔记」、卡片右上角 📝 角标、（后续）待沉淀区。
 * 幂等判断只能写一份——写两份就会有一份忘了回问后端，结果是同一张卡片多出一条重复笔记。
 */
import type { HistoryItem } from "@/stores/appStore";
import type { ImageOcrState } from "@/lib/utils";
import { useDialogStore } from "@/stores/dialogStore";
import { useAppStore } from "@/stores/appStore";
import { noteByHistory } from "@/lib/api";
import { extractNoteDraft } from "./extract";
import { applyTemplateToDraft, parseTemplateOverrides } from "./template";

/**
 * 打开这张卡片的笔记弹窗。
 *
 * - 已转过 → 编辑已有那条（幂等，不存第二份）
 * - 未转过 → 用按类型抽出的初稿新建
 *
 * **无条件先回问后端**，不信 store 里的 `noteHistoryIds` 缓存：它可能陈旧
 * （另一处刚删了笔记），而写入路径上猜错的代价是一条重复笔记。
 * 缓存只用于决定角标与菜单文案（看错了无代价）。
 */
export async function openNoteForCard(item: HistoryItem, ocrState?: ImageOcrState): Promise<void> {
  const existing = await noteByHistory(item.id);
  if (existing) {
    useDialogStore.getState().openNote({
      noteId: existing.id,
      historyId: item.id,
      title: existing.title,
      content: existing.content,
    });
    return;
  }

  const draft = extractNoteDraft(item, ocrState);
  // 抽不出初稿（file 卡片、无 OCR 的图片、空文本）。正常情况下走不到这里——
  // 入口本就不会显示。真走到了就静默返回，而不是弹一个用户无法处理的错。
  if (!draft) return;

  /**
   * 套转笔记模板（B2 #8）。**只在这一处套**——两个转笔记入口（右键菜单/角标、
   * 待沉淀区）都走本函数，而 `extractNoteDraft` 在别处只用来判「能不能转」。
   *
   * 今日速记**不走模板**：D11 写死了「不做模板引擎」，而且它的
   * `## HH:MM · 来自 X` 是固定格式，套模板会打乱那个流水账结构。
   *
   * 配置现读而不缓存：用户在设置里刚改完模板，下一次转笔记就应该生效。
   */
  const cfg = useAppStore.getState().config;
  const final = applyTemplateToDraft(
    draft,
    item,
    cfg.note_template ?? "",
    parseTemplateOverrides(cfg.note_template_overrides),
  );

  useDialogStore.getState().openNote({
    historyId: item.id,
    title: final.title,
    content: final.content,
  });
}
