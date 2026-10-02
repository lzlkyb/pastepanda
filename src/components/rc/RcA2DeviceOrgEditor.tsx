/**
 * RcA2DeviceOrgEditor — 「管理此设备」里的标签与备注编辑（2026-09-26 对齐稿①）。
 *
 * 标签 = 名字 + 6 色板键（RustDesk TagPainter 同款约束，不许自定义 hex）：
 * 先点色、再输名字回车创建；上限 6 个（满了输入框禁用并把原因写在 placeholder）。
 * 备注 = 描述性长文本（「双 4K，走中继较卡」），与 hero 的「重命名」（别名）
 * 刻意分开：别名顶替显示名，这里只补充说明，悬停/详情显示。
 *
 * 挂载方在 `manageOpen` 折叠块内并带 `key={target.node_id}`：换设备重挂载，
 * 草稿与保存状态按设备保留在工作台（useRcDeviceUi），折叠和切页不会丢输入。
 */
import { X } from "lucide-react";
import type { RcDeviceOrgDraft } from "@/hooks/useRcDeviceUi";
import type { RcDeviceTag, RcTargetDevice } from "@/lib/api/rc";
import {
  MAX_TAGS_PER_DEVICE,
  TAG_COLOR_KEYS,
  normalizeDeviceTags,
  tagColorOf,
} from "@/lib/rcDeviceTags";
import type { ToastFn } from "@/components/Toast";
import styles from "./RemoteComputerA2.module.css";

export function RcA2DeviceOrgEditor({
  target,
  busy,
  onSetTags,
  onSetRemark,
  toast,
  draft,
  onDraftChange,
}: {
  target: RcTargetDevice;
  busy: boolean;
  /** 整组覆盖式保存；返回 false = 工作台已 toast 过错误，这里不再重复报。 */
  onSetTags: (id: string, tags: RcDeviceTag[]) => Promise<boolean>;
  onSetRemark: (id: string, remark: string) => Promise<boolean>;
  toast: ToastFn;
  draft: RcDeviceOrgDraft;
  onDraftChange: (patch: Partial<RcDeviceOrgDraft>) => void;
}) {
  const tags = target.tags ?? [];
  const { pickedColor, tagName, remark, saving } = draft;

  const full = tags.length >= MAX_TAGS_PER_DEVICE;
  const remarkDirty = remark.trim() !== (target.remark ?? "").trim();

  const addTag = async () => {
    if (busy || saving || full) return;
    const next = normalizeDeviceTags([...tags, { name: tagName, color: pickedColor }]);
    if (next.length === tags.length) {
      // 清洗后被丢（空名/重名）：就地说明，不静默
      if (tagName.trim()) toast("这个标签已存在", "info");
      return;
    }
    if (await commitTags(next)) onDraftChange({ tagName: "" });
  };

  const commitTags = async (next: RcDeviceTag[]) => {
    onDraftChange({ saving: true });
    try {
      const ok = await onSetTags(target.node_id, next);
      if (ok) toast("标签已保存", "success");
      return ok;
    } finally {
      onDraftChange({ saving: false });
    }
  };

  const saveRemark = async () => {
    if (busy || saving) return;
    onDraftChange({ saving: true });
    try {
      const trimmed = remark.trim();
      if (await onSetRemark(target.node_id, trimmed)) {
        toast(trimmed ? "备注已保存" : "备注已清除", "success");
        onDraftChange({ remark: trimmed });
      }
    } finally {
      onDraftChange({ saving: false });
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
        aria-label="标签名称"
        value={tagName}
        disabled={busy || saving || full}
        placeholder={full ? `最多 ${MAX_TAGS_PER_DEVICE} 个标签，先删再增` : "输入标签名，回车创建"}
        onChange={(e) => onDraftChange({ tagName: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") void addTag();
        }}
      />
      <button type="button" className={styles.orgSave} disabled={busy || saving || full || !tagName.trim()} onClick={() => void addTag()}>
        {saving ? "保存中…" : "添加标签"}
      </button>
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
            disabled={busy || saving}
            onClick={() => onDraftChange({ pickedColor: key })}
          />
        ))}
      </div>
      <div className={styles.orgLabel}>备注（仅自己可见，悬停/详情显示）</div>
      <input
        className={styles.orgInput}
        aria-label="设备备注"
        value={remark}
        disabled={busy || saving}
        placeholder="例如：双 4K，走中继较卡"
        onChange={(e) => onDraftChange({ remark: e.target.value })}
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
