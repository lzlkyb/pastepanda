/**
 * lib/pasteItem.ts —— 「按历史条目类型分派粘贴」的唯一入口。
 *
 * ## 为什么要收口
 *
 * 这段分派此前在 **5 处各写一份**：卡片右键（`Card.tsx`）、主窗 Enter（`App.tsx`）、
 * 栈粘贴（`api/stack.ts`）、托盘弹窗（`TrayPopup.tsx`）、快捷面板（`QuickPastePanel.tsx`）。
 * 五份已经互相漂移，而漂移直接产出过两类 bug：
 *
 * - v6.15：「image / rich / file 三个分支全漏了粘贴信号」——每个分支各写一遍回写，
 *   漏一个就少一类信号；
 * - 至今：**卡片右键没有 image / file 分支**，图片条目粘出 `[图片] 1860x915` 占位文本、
 *   文件条目粘出裸文件名而不是完整路径。托盘弹窗当年的 U33 修过同一个问题，
 *   但那次只修了自己那一份。
 *
 * 所以这不是"顺手抽个函数"，而是消掉一个反复产 bug 的结构。
 *
 * ## 语义取的是五份里最完整的那份（`Card.tsx`）
 *
 * 其余四处此前都**忽略 `paste_format_default`**（用户设了"一律粘纯文本"，
 * 托盘/快捷面板/热键/Enter 照旧粘富文本），且 `doc` 类型的处理各不相同：
 * 只有 Card 与快捷面板当富文本，其余落到纯文本分支；而 `sanitizeDocHtml`
 * 只有 Card 调了，快捷面板把带 mso 噪声的原始 CF_HTML 直接粘出去。
 * 统一按 Card 的语义走，等于把这些差异都对齐到"最正确的那个"。
 */
import { pasteImage, pasteRichGuarded, pasteTextGuarded } from "@/lib/api/paste";
import { sanitizeDocHtml } from "@/lib/docPipeline/sanitizeDoc";
import { useAppStore } from "@/stores/appStore";
import { logItemPasted } from "@/lib/api/actionEvents";

/** 分派到了哪一类——调用方据此选自己的 toast 文案（各窗口措辞本来就不同） */
export type PasteKind = "image" | "rich" | "file" | "text";

export interface PasteItemResult {
  /** 是否真的粘出去了（用户取消 / 失败都是 false） */
  ok: boolean;
  kind: PasteKind;
}

/** 分派所需的最小条目形状（`HistoryItem` 与托盘的 `RecentItem` 都能喂进来） */
export interface PastableItem {
  id: string;
  type: string;
  text: string;
  content?: string;
  content_type?: string | null;
  source?: string;
}

/**
 * 按类型粘贴一条历史记录，成功后回写粘贴信号。
 *
 * @param listIndex 粘的是当前列表第几条（0-based）；无列表位置（栈序、托盘、
 *   独立窗口、编辑器内）传 `-1`，这是既有约定。省略等同于不带。
 */
export async function pasteHistoryItem(
  item: PastableItem,
  listIndex?: number,
): Promise<PasteItemResult> {
  const plainOnly = useAppStore.getState().config.paste_format_default === "plain";
  const content = item.content || "";

  let ok: boolean;
  let kind: PasteKind;

  if (item.type === "image" && content) {
    // 图片必须走 pasteImage：走纯文本分支就会把 "[图片] WxH" 占位文本打进用户文档
    kind = "image";
    ok = await pasteImage(content);
  } else if (!plainOnly && (item.type === "doc" || item.type === "rich") && content) {
    // doc 的 content 是原始 CF_HTML（可能含 mso 噪声），粘贴前先清洗；rich 已是干净片段
    kind = "rich";
    const html = item.type === "doc" ? sanitizeDocHtml(content) : content;
    ok = await pasteRichGuarded(html, item.text);
  } else if (item.type === "file" && content) {
    // 文件粘完整路径（content），不是裸文件名（text）
    kind = "file";
    ok = await pasteTextGuarded(content);
  } else {
    kind = "text";
    ok = await pasteTextGuarded(item.text);
  }

  if (ok) {
    // 唯一的回写点。五份拷贝时代是每个分支各写一遍，漏一个就少一类价值信号。
    logItemPasted(
      {
        id: item.id,
        type: item.type,
        content_type: item.content_type,
        source: item.source ?? "",
      },
      listIndex,
    );
  }

  return { ok, kind };
}
