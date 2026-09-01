/**
 * 「按类型定制」弹窗（B2 #8）。
 *
 * 为什么不直接把全部类型摆出来：`CONTENT_TYPE_META` 里有 19 个类型，
 * 19 个多行输入框连弹窗也装不下，而其中大多数人一辈子不会去配。
 * 所以：**只列已配的 + 一个「＋ 添加类型」**。
 * 但下拉里**列全部 19 个不筛选**——不去猜「哪些类型值得定制」，
 * 一猜就又多一个「我以为不能其实能」的限制。
 *
 * 变量这里只给文字清单、不做点击插入：屏上同时有 N 个输入框，
 * 「插到光标处」得先回答「哪个框」，而那个问题不值得为它加一层焦点跟踪。
 *
 * 🔴 红线：纯本地字符串，无 AI、不联网。
 */
import { useEffect, useState } from "react";
import { CONTENT_TYPE_META } from "@/lib/contentTypes";
import { TEMPLATE_VAR_NAMES } from "@/lib/notes/template";
import { NoteTemplateDialogShell } from "./NoteTemplateDialogShell";
import settings from "../Settings.module.css";
import styles from "./NoteTemplate.module.css";

/** 类型下拉的选项，顺序照 CONTENT_TYPE_META（卡片上的类型徽用的同一份，规则 #11） */
const TYPE_OPTIONS = Object.entries(CONTENT_TYPE_META).map(([key, meta]) => ({
  key,
  label: meta.label,
}));

/** key → 中文标签。不用 getContentTypeMeta：它对未知 key 会退回「文本」，
 *  而这里宁可把陈旧的 key 原样显出来（能看出来才能删掉）。 */
const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  TYPE_OPTIONS.map((t) => [t.key, t.label]),
);

/** 比两张覆盖表是不是一样。排序后比：新增键的插入顺序不应计作「改动」 */
function sameOv(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => kb[i] === k && a[k] === b[k]);
}

interface Props {
  open: boolean;
  initial: Record<string, string>;
  onClose: () => void;
  onSave: (next: Record<string, string>) => void;
}

export function NoteTemplateTypesDialog({ open, initial, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<Record<string, string>>(initial);

  // 每次打开重新从配置取：上次取消掉的草稿不能留到下一次
  useEffect(() => {
    if (open) setDraft(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const keys = Object.keys(draft);
  const dirty = !sameOv(draft, initial);

  const remove = (key: string) => {
    const next = { ...draft };
    delete next[key];
    setDraft(next);
  };

  const add = (key: string) => {
    if (!key || key in draft) return;
    // 新增的是空模板：先把行摆出来让人敲，而不是预填一份我猜的内容。
    // 空值在 pickTemplate 里等于「没配」，所以加了不填也不会把正文清空。
    setDraft({ ...draft, [key]: "" });
  };

  return (
    <NoteTemplateDialogShell
      open={open}
      title="按类型定制模板"
      dirty={dirty}
      onClose={onClose}
      onSave={() => onSave(draft)}
    >
      <div className={styles.desc}>
        没配的类型用默认模板。<b>按卡片类型自动匹配，不会弹选择器</b>。
        <br />
        可用变量：{TEMPLATE_VAR_NAMES.map((n) => `{{${n}}}`).join(" ")}
      </div>

      {keys.length === 0 && (
        <div className={styles.empty}>还没配任何类型——全部类型都走默认模板</div>
      )}

      {keys.map((key) => (
        <div key={key} className={styles.ovRow}>
          <div className={styles.ovType}>{TYPE_LABEL[key] ?? key}</div>
          <div className={styles.ovBody}>
            <textarea
              className={`${styles.ta} ${styles.taShort}`}
              value={draft[key]}
              placeholder="留空 = 不特殊对待这个类型（退回默认模板）"
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            />
          </div>
          <button
            className={styles.ovDel}
            title="删掉这个类型的定制"
            onClick={() => remove(key)}
          >
            ✕
          </button>
        </div>
      ))}

      <div className={styles.row}>
        {/* 用 select 而不是自己画下拉：19 项的选择原生控件完全够用，也自带键盘搜字 */}
        <select
          className={settings.settingsSelect}
          value=""
          onChange={(e) => add(e.target.value)}
        >
          <option value="">＋ 添加类型</option>
          {TYPE_OPTIONS.filter((t) => !(t.key in draft)).map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
        <span className={styles.hint}>选一个类型后出现输入框</span>
      </div>
    </NoteTemplateDialogShell>
  );
}
