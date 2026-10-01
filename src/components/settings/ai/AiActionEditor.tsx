/**
 * 自定义动作的编辑器（只管 JSX；状态与动作在 `useAiActionEditor.ts`）。
 *
 * **带试跑**：写 prompt 本来就要迭代，“保存 → 关掉设置 → 去变换中心找条内容试
 * → 回来改”这个循环长得没人会走完。试跑**会真实计费**，按钮上写明了。
 *
 * 校验全部交给后端（`validate_template` / 重名检查），这里只负责把错误摆出来。
 * 前后端各写一份校验规则，迟早会漂。
 */

import { Loader2, Play } from "lucide-react";
import type { AiContentTypeOption, AiCustomAction } from "@/lib/api";
import { ACTION_TEMPLATES } from "./actionTemplates";
import { PLACEHOLDER, useAiActionEditor } from "./useAiActionEditor";
import settings from "../../Settings.module.css";
import styles from "../AiTab.module.css";

interface Props {
  /** null = 新建 */
  action: AiCustomAction | null;
  contentTypes: AiContentTypeOption[];
  onSaved: () => void;
  onCancel: () => void;
  onDelete: (id: string) => void;
}

export function AiActionEditor({ action, contentTypes, onSaved, onCancel, onDelete }: Props) {
  const {
    isNew, draft, error, saving, sample, testing, output, confirming,
    dirtySinceRun, confirmDelete, setConfirmDelete, templateRef,
    patch, changeSample, applyTemplate, insertPlaceholder, toggleType, save, tryRun, canTest,
  } = useAiActionEditor(action, onSaved);

  return (
    <div className={styles.editor}>
      {isNew && (
        <div className={styles.field}>
          <span className={styles.label}>从示例开始（可选）</span>
          <div className={styles.chips}>
            {ACTION_TEMPLATES.map((t) => (
              <button key={t.name} className={styles.chip} onClick={() => applyTemplate(t)}>
                <span className={styles.chipTitle}>{t.name}</span>
                <span className={styles.chipId}>{t.description}</span>
              </button>
            ))}
          </div>
          <span className={styles.hint}>套用后可任意修改。这几个都是内置动作里没有的。</span>
        </div>
      )}

      <label className={styles.field}>
        <span className={styles.label}>名称</span>
        <input
          className={styles.input}
          value={draft.name}
          placeholder="比如：提取待办"
          onChange={(e) => patch({ name: e.target.value })}
        />
      </label>

      <label className={styles.field}>
        <span className={styles.label}>一句话描述（可选）</span>
        <input
          className={styles.input}
          value={draft.description}
          placeholder="会显示在变换中心的卡片上"
          onChange={(e) => patch({ description: e.target.value })}
        />
      </label>

      <label className={styles.field}>
        <span className={styles.label}>提示词模板</span>
        <textarea
          ref={templateRef}
          className={styles.textarea}
          value={draft.template}
          placeholder={`把下面的内容…\n\n${PLACEHOLDER}\n\n只输出结果本身。`}
          onChange={(e) => patch({ template: e.target.value })}
        />
        <div className={styles.row}>
          <button className={settings.btnSecondary} onClick={insertPlaceholder}>
            插入 <span className={styles.ph}>{"{{内容}}"}</span>
          </button>
          <span className={styles.hint}>
            它会被替换成剪贴板里的内容。把“只输出结果本身”这类要求写在它<strong>后面</strong>效果更好。
          </span>
        </div>
      </label>

      <div className={styles.field}>
        <span className={styles.label}>什么时候出现</span>
        <div className={styles.chips}>
          {contentTypes.map((t) => (
            <button
              key={t.id}
              className={`${styles.chip} ${
                draft.contentTypes.includes(t.id) ? styles.chipActive : ""
              }`}
              onClick={() => toggleType(t.id)}
            >
              <span className={styles.chipTitle}>{t.label}</span>
            </button>
          ))}
        </div>
        <span className={styles.hint}>
          一个都不选 = 任何内容上都出现（但排在内置动作之后）。选了就只在对应类型上出现，并排在最前。
        </span>
      </div>

      <label className={styles.field}>
        <span className={styles.label}>输出上限（token）</span>
        <input
          className={styles.input}
          type="number"
          min={50}
          max={4000}
          value={draft.maxTokens}
          style={{ width: 120 }}
          onChange={(e) => patch({ maxTokens: Number(e.target.value) || 1024 })}
        />
        <span className={styles.hint}>
          给小一点省钱，但太小会把回答截断。短产物 300～800 就够；
          用推理模型时思考也算在这份额度里，要给到 3000 以上。
        </span>
      </label>

      <div className={styles.field}>
        <span className={styles.label}>试跑</span>
        <textarea
          className={`${styles.textarea} ${styles.textareaShort}`}
          value={sample}
          placeholder="粘一段示例内容，用它试一下效果"
          onChange={(e) => changeSample(e.target.value)}
        />
        <div className={styles.row}>
          <button
            className={settings.btnSecondary}
            disabled={!canTest}
            onClick={() => {
              const force = confirming;
              void tryRun(force);
            }}
          >
            {testing ? <Loader2 size={12} className="spin" /> : <Play size={12} />}
            {testing ? "试跑中…" : confirming ? "确认发送（内容将上云）" : "试跑（会真实计费）"}
          </button>
          <span className={styles.hint}>不用先保存，拿当前模板直接发一次。</span>
        </div>
        {output && (
          <>
            <pre className={`${styles.preview} ${output.ok ? styles.previewAi : styles.testFail}`}>
              {output.text}
            </pre>
            {output.truncated && (
              <span className={styles.hint}>
                ⚠ 回答被上面的 token 上限截断了。调大再试一次；如果用的是推理模型，
                思考过程也吃这份额度，往往要 3000 以上。
              </span>
            )}
          </>
        )}
        {output && dirtySinceRun && (
          <span className={styles.hint}>
            ⚠ 模板或样例已改动，上面的结果是修改前的——再点一次试跑才是新效果。
          </span>
        )}
      </div>

      {error && <div className={styles.errMsg}>{error}</div>}

      <div className={styles.row}>
        <button className={settings.btnPrimary} disabled={saving} onClick={() => void save()}>
          {saving ? "保存中…" : "保存"}
        </button>
        <button className={settings.btnSecondary} onClick={onCancel}>
          取消
        </button>
        {!isNew &&
          (confirmDelete ? (
            <>
              <button
                className={settings.btnDanger}
                style={{ marginLeft: "auto" }}
                onClick={() => onDelete(draft.id)}
              >
                确认删除（不可恢复）
              </button>
              <button className={settings.btnSecondary} onClick={() => setConfirmDelete(false)}>
                取消
              </button>
            </>
          ) : (
            <button
              className={settings.btnDanger}
              style={{ marginLeft: "auto" }}
              onClick={() => setConfirmDelete(true)}
            >
              删除
            </button>
          ))}
      </div>
    </div>
  );
}
