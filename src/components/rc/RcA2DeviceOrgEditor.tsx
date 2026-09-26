/**
 * RcA2DeviceOrgEditor — 「管理此设备」里的标签与备注编辑（2026-09-26 对齐稿①）。
 *
 * 标签 = 名字 + 6 色板键（RustDesk TagPainter 同款约束，不许自定义 hex）：
 * 先点色、再输名字回车创建；上限 6 个（满了输入框禁用并把原因写在 placeholder）。
 * 备注 = 描述性长文本（「双 4K，走中继较卡」），与 hero 的「重命名」（别名）
 * 刻意分开：别名顶替显示名，这里只补充说明，悬停/详情显示。
 *
 * 挂载方在 `manageOpen` 折叠块内并带 `key={target.node_id}`：换设备重挂载，
 * 本地草稿自然重置（规则 15.2——展开态本就随设备切换收起，见 useRcDeviceUi）。
 */
import { useState } from "react";
import { X } from "lucide-react";
import type { RcDeviceTag, RcTargetDevice } from "@/lib/api/rc";
import {
  MAX_TAGS_PER_DEVICE,
  TAG_COLOR_KEYS,
  normalizeDeviceTags,
  tagColorOf,
  type TagColorKey,
} from "@/lib/rcDeviceTags";
import type { ToastFn } from "@/components/Toast";
import styles from "./RemoteComputerA2.module.css";

export function RcA2DeviceOrgEditor({
  target,
  busy,
  onSetTags,
  onSetRemark,
  toast,
}: {
  target: RcTargetDevice;
  busy: boolean;
  /** 整组覆盖式保存；返回 false = 工作台已 toast 过错误，这里不再重复报。 */
  onSetTags: (id: string, tags: RcDeviceTag[]) => Promise<boolean>;
  onSetRemark: (id: string, remark: string) => Promise<boolean>;
  toast: ToastFn;
}) {
  const tags = target.tags ?? [];
  const [pickedColor, setPickedColor] = useState<TagColorKey>("blue");
  const [tagName, setTagName] = useState("");
  const [remark, setRemark] = useState(target.remark ?? "");
  const [saving, setSaving] = useState(false);

  const full = tags.length >= MAX_TAGS_PER_DEVICE;
  const remarkDirty = remark.trim() !== (target.remark ?? "").trim();

  const addTag = async () => {
    const next = normalizeDeviceTags([...tags, { name: tagName, color: pickedColor }]);
    if (next.length === tags.length) {
      // 清洗后被丢（空名/重名）：就地说明，不静默
      if (tagName.trim()) toast("这个标签已存在", "info");
      return;
    }
    setTagName("");
    await commitTags(next);
  };

  const commitTags = async (next: RcDeviceTag[]) => {
    setSaving(true);
    try {
      if (await onSetTags(target.node_id, next)) toast("标签已保存", "success");
    } finally {
      setSaving(false);
    }
  };

  const saveRemark = async () => {
    setSaving(true);
    try {
      const trimmed = remark.trim();
      if (await onSetRemark(target.node_id, trimmed)) {
        toast(trimmed ? "备注已保存" : "备注已清除", "success");
        setRemark(trimmed);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.orgEditor}>
      <div className={styles.orgLabel}>编辑标签</div>
      {tags.length > 0 && (
        <div className={styles.orgTagList}>
          {tags.map((tag) => (
            <span key={tag.name} className={styles.orgTagItem}>
              <i data-color={tagColorOf(tag)} aria-hidden="true" />
              {tag.name}
              <button
                type="button"
                aria-label={`删除标签 ${tag.name}`}
                disabled={busy || saving}
                onClick={() => void commitTags(tags.filter((t) => t.name !== tag.name))}
              >
                <X size={10} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        className={styles.orgInput}
        value={tagName}
        disabled={busy || saving || full}
        placeholder={full ? `最多 ${MAX_TAGS_PER_DEVICE} 个标签，先删再增` : "输入标签名，回车创建"}
        onChange={(e) => setTagName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void addTag();
        }}
      />
      <div className={styles.orgSwatches} role="radiogroup" aria-label="标签颜色">
        {TAG_COLOR_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={pickedColor === key}
            aria-label={`颜色 ${key}`}
            className={pickedColor === key ? styles.orgSwatchOn : styles.orgSwatch}
            data-color={key}
            onClick={() => setPickedColor(key)}
          />
        ))}
      </div>
      <div className={styles.orgLabel}>备注（仅自己可见，悬停/详情显示）</div>
      <input
        className={styles.orgInput}
        value={remark}
        disabled={busy || saving}
        placeholder="例如：双 4K，走中继较卡"
        onChange={(e) => setRemark(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void saveRemark();
        }}
      />
      {remarkDirty && (
        <button type="button" className={styles.orgSave} disabled={busy || saving} onClick={() => void saveRemark()}>
          {remark.trim() ? "保存备注" : "清除备注"}
        </button>
      )}
    </div>
  );
}
