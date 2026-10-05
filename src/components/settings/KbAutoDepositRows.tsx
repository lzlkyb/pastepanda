/**
 * 设置·「星标自动沉淀」小节（「文章 → 知识库」阶段 3）。
 *
 * 外层完全用 Settings.module.css 的 sSection / sRow，与其它设置行一致；
 * **必须返回片段**（不包 div）：GeneralTab 的设置搜索遍历 container.children
 * 逐行显隐，包一层就会把整节当成一行（同 NoteTemplateRows 的头注释）。
 *
 * 开关默认**关**：自动化必须老用户自己打开才算授权；开了也只对点亮星标的
 * 卡片生效，不是复制即入库。
 */
import type { AppConfig } from "@/stores/appStore";
import { ToggleRow } from "./ToggleRow";
import styles from "../Settings.module.css";

interface Props {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
}

export function KbAutoDepositRows({ config, updateAndSave }: Props) {
  const on = config.kb_auto_deposit ?? false;
  return (
    <>
      <div className={styles.sSection}>星标自动沉淀</div>
      <ToggleRow
        icon="⭐"
        hue="editor"
        label="点亮星标自动存入知识库"
        desc={
          on
            ? "开 · 点亮星标即自动转成草稿，知识库顶部等你确认"
            : "关 · 星标只做收藏，不写入知识库"
        }
        value={on}
        onChange={(v) => void updateAndSave({ kb_auto_deposit: v })}
        tooltip="把「看到好内容点亮星标」变成「知识库里多一篇草稿」，省掉手动转笔记那一步"
        detailTitle="星标自动沉淀"
        detail={
          <>
            <p>
              开启后，<b>点亮星标（置顶）</b>的卡片会自动转成知识库<b>草稿</b>——
              正文用与手动「转为笔记」完全相同的管线抽取，模板同样生效。
            </p>
            <p>📌 产物是<b>草稿不是正式文章</b>：知识库顶部会列出来等你「转正」或「丢弃」，丢弃进回收站可恢复</p>
            <p>📌 文件卡片、没有识别文字的图片<b>不会</b>被自动转（转了也只是空笔记）</p>
            <p>📌 同一张卡片只会存一次，重复点亮不会生成重复笔记</p>
            <p>📌 纯本地处理，不联网、不调用 AI</p>
          </>
        }
      />
    </>
  );
}
