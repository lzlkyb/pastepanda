/**
 * 设置·「转笔记模板」小节（B2 #8）：一个 sSection 标题 + 两行标准 sRow。
 *
 * 上一版是自己另开的一个常显卡片（自定圆角/背景/字号、左右零边距、没图标），
 * 在一列 sRow 中间看着就是异物。现在：
 *   • 外层完全用 Settings.module.css 的 sSection / sRow / sRowIcon / sRowLabel / sRowDesc，
 *     与其它设置行像素级一致（规则 #12：先读真实源码再改样式）；
 *   • 编辑器与预览搬进弹窗，行上只留一句当前状态。
 *
 * ❗ 这三个元素必须是设置容器的**直接子元素**（所以返回 Fragment、不包 div）：
 *   GeneralTab 的设置项搜索是遍历 `container.children` 逐个显隐的，
 *   包一层 div 会让搜索把整节当成一行，且认不出小节标题。
 *   两个弹窗 portal 到 body，不占这里的 DOM 子节点。
 *
 * 🔴 红线：纯本地字符串替换，不调 AI、不联网。
 */
import { useState } from "react";
import type { AppConfig } from "@/stores/appStore";
import { CONTENT_TYPE_META } from "@/lib/contentTypes";
import { parseTemplateOverrides } from "@/lib/notes/template";
import { NoteTemplateDialog } from "./NoteTemplateDialog";
import { NoteTemplateTypesDialog } from "./NoteTemplateTypesDialog";
import styles from "../Settings.module.css";

/** 没任何覆盖时存空串而不是 `{}`：空串在 parseTemplateOverrides 里就是「没配」 */
function serializeOverrides(ov: Record<string, string>): string {
  return Object.keys(ov).length === 0 ? "" : JSON.stringify(ov);
}

/** 模板摘要：取第一行非空内容。行上就那么宽，展不开多行 */
function templateSummary(tpl: string): string {
  const line = tpl.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 32 ? `${line.slice(0, 32)}…` : line;
}

interface Props {
  config: AppConfig;
  updateAndSave: (partial: Record<string, unknown>) => Promise<void>;
}

export function NoteTemplateRows({ config, updateAndSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [managing, setManaging] = useState(false);

  const tpl = config.note_template ?? "";
  const ov = parseTemplateOverrides(config.note_template_overrides);
  const ovKeys = Object.keys(ov);

  return (
    <>
      <div className={styles.sSection}>转笔记模板</div>

      <div className={styles.sRow}>
        <span
          className={styles.sRowIcon}
          style={{ background: "linear-gradient(135deg, #6366F1, #4338CA)" }}
        >
          📝
        </span>
        <div className={styles.sRowBody}>
          <div className={styles.sRowLabel}>默认模板</div>
          <div className={styles.sRowDesc}>
            {/* 文案里常带「转笔记」「模板」两个词：设置页搜索是按行的 textContent 匹配的，
                只写模板摘要的话，搜「转笔记」会找不到这一节（小节标题不参与匹配） */}
            {tpl.trim()
              ? `转为笔记时套用：${templateSummary(tpl)}`
              : "未配 · 转笔记保持现在的行为（今日速记不走模板）"}
          </div>
        </div>
        <button className={styles.sAction} onClick={() => setEditing(true)}>
          编辑
        </button>
      </div>

      <div className={styles.sRow}>
        <span
          className={styles.sRowIcon}
          style={{ background: "linear-gradient(135deg, #14B8A6, #0D9488)" }}
        >
          🏷️
        </span>
        <div className={styles.sRowBody}>
          <div className={styles.sRowLabel}>按类型定制</div>
          <div className={styles.sRowDesc}>
            {ovKeys.length > 0
              ? `已定制：${ovKeys
                  .map((k) => CONTENT_TYPE_META[k as keyof typeof CONTENT_TYPE_META]?.label ?? k)
                  .join("、")}（其余用默认模板）`
              : "未配 · 全部类型用默认模板"}
          </div>
        </div>
        <button className={styles.sAction} onClick={() => setManaging(true)}>
          {ovKeys.length > 0 ? `管理 ${ovKeys.length} 个` : "添加"}
        </button>
      </div>

      <NoteTemplateDialog
        open={editing}
        initial={tpl}
        overrides={ov}
        onClose={() => setEditing(false)}
        onSave={(next) => {
          void updateAndSave({ note_template: next });
          setEditing(false);
        }}
      />

      <NoteTemplateTypesDialog
        open={managing}
        initial={ov}
        onClose={() => setManaging(false)}
        onSave={(next) => {
          void updateAndSave({ note_template_overrides: serializeOverrides(next) });
          setManaging(false);
        }}
      />
    </>
  );
}
