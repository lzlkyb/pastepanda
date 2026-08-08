/**
 * 自定义动作的列表。
 *
 * 默认展开：它不是旋钮，是用户会反复回来的地方。
 *
 * 编辑时**就地替换掉列表**而不是开弹窗：设置面板本身已经是一层对话框，
 * 再叠一层会把空间压得没法写模板。
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import {
  aiDeleteCustomAction,
  aiListContentTypes,
  aiListCustomActions,
  aiSaveCustomAction,
  type AiContentTypeOption,
  type AiCustomAction,
} from "@/lib/api";
import { reloadAiCustomActions } from "@/lib/transforms";
import { logger } from "@/lib/logger";
import { useToast } from "@/components/Toast";
import { AiActionEditor } from "./AiActionEditor";
import settings from "../../Settings.module.css";
import styles from "../AiTab.module.css";

/** 编辑中：null 不在编辑，"new" 新建，否则是被编辑的动作 */
type Editing = null | "new" | AiCustomAction;

export function AiCustomActions() {
  const { toast } = useToast();
  const [open, setOpen] = useState(true);
  const [list, setList] = useState<AiCustomAction[]>([]);
  const [types, setTypes] = useState<AiContentTypeOption[]>([]);
  const [editing, setEditing] = useState<Editing>(null);

  const reload = useCallback(async () => {
    try {
      const [acts, cts] = await Promise.all([aiListCustomActions(), aiListContentTypes()]);
      setList(acts);
      setTypes(cts);
    } catch (e) {
      logger.warn("加载自定义 AI 动作失败", e);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 改完要同时刷新变换注册表，否则变换中心里看到的还是旧的 */
  const syncAll = useCallback(async () => {
    await reload();
    await reloadAiCustomActions();
  }, [reload]);

  const toggleEnabled = async (a: AiCustomAction) => {
    try {
      await aiSaveCustomAction({ ...a, enabled: !a.enabled });
      await syncAll();
    } catch (e) {
      toast(`保存失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };

  const remove = async (id: string) => {
    try {
      await aiDeleteCustomAction(id);
      setEditing(null);
      await syncAll();
      toast("动作已删除", "success");
    } catch (e) {
      toast(`删除失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };

  const typeLabel = (a: AiCustomAction): string => {
    if (a.contentTypes.length === 0) return "全部类型";
    return a.contentTypes
      .map((id) => types.find((t) => t.id === id)?.label ?? id)
      .join(" · ");
  };

  return (
    <div className={styles.advanced}>
      <button className={styles.advancedToggle} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        自定义动作
        <span className={styles.advancedHint}>
          {list.length > 0 ? `已有 ${list.length} 个` : "写一段提示词，就多一个变换"}
        </span>
      </button>

      {!open ? null : editing !== null ? (
        <AiActionEditor
          action={editing === "new" ? null : editing}
          contentTypes={types}
          onSaved={() => {
            setEditing(null);
            void syncAll();
          }}
          onCancel={() => setEditing(null)}
          onDelete={(id) => void remove(id)}
        />
      ) : (
        <div className={styles.advancedBody}>
          {list.length === 0 ? (
            <span className={styles.hint}>
              还没有自定义动作。它们会与内置动作同处一个列表、同一套排序。
            </span>
          ) : (
            <div className={styles.logList}>
              {list.map((a) => (
                <div key={a.id} className={styles.actionRow}>
                  <button className={styles.actionMain} onClick={() => setEditing(a)}>
                    <span className={styles.actionName}>{a.name}</span>
                    <span className={styles.actionDesc}>
                      {a.description || a.template.slice(0, 40)}
                    </span>
                  </button>
                  <span className={a.contentTypes.length ? styles.tagOn : styles.logMeta}>
                    {typeLabel(a)}
                  </span>
                  <input
                    type="checkbox"
                    checked={a.enabled}
                    title={a.enabled ? "已启用" : "已停用"}
                    onChange={() => void toggleEnabled(a)}
                  />
                </div>
              ))}
            </div>
          )}

          <div className={styles.row}>
            <button className={settings.btnSecondary} onClick={() => setEditing("new")}>
              <Plus size={12} />
              新建动作
            </button>
            <span className={styles.hint}>停用的不会出现在变换中心，但模板保留。</span>
          </div>
        </div>
      )}
    </div>
  );
}
