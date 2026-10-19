import { useState, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useAppStore } from "@/stores/appStore";
import { CONTENT_TRANSITION } from "@/lib/motion";
import { useClickOutside } from "@/hooks/useClickOutside";
import { TagBadge, AnimatedTagBadge } from "@/components/TagBadge";
import { LanSyncCap } from "@/components/LanSyncCap";
import { Tag, X } from "lucide-react";
import { SegmentedTabs, CircleTabs } from "./HistoryTypeTabs";
import { HistoryFilterStatus } from "./HistoryFilterStatus";
import styles from "../TopBar.module.css";

export function HistoryFilterBar({ tabStyle, counts, countsError, refreshCounts }: {
  tabStyle: "segmented" | "circle";
  counts: Record<string, number> | null;
  countsError: boolean;
  refreshCounts: () => void;
}) {
  const filterType = useAppStore(s => s.filterType);
  const setFilterType = useAppStore(s => s.setFilterType);
  const selectedTagIds = useAppStore(s => s.selectedTagIds);
  const toggleTagFilter = useAppStore(s => s.toggleTagFilter);
  const clearTagFilters = useAppStore(s => s.clearTagFilters);
  const allTags = useAppStore(s => s.tags);
  const lanSyncEnabled = useAppStore(s => s.config.lan_sync_enabled);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  return <>
        {/* Tab 区域 */}
        <div className={styles.tabsArea} data-tauri-drag-region="false">
          {/* 改成按钮而不是一段死文字：计数失败常常只是一次性超时，
              只报错不给重试入口的话用户只能重启窗口。 */}
          {countsError && (
            <button
              type="button"
              className={styles.countsErrorHint}
              onClick={refreshCounts}
              title="统计数据加载失败，点击重试"
            >
              ⚠ 计数获取失败，点击重试
            </button>
          )}
          <AnimatePresence mode="wait">
            {tabStyle === "segmented" ? (
              <motion.div key="seg" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.15 }}>
                <SegmentedTabs filterType={filterType} setFilterType={setFilterType} counts={counts} />
              </motion.div>
            ) : (
              <motion.div key="circle" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.15 }}>
                <CircleTabs filterType={filterType} setFilterType={setFilterType} counts={counts} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* 标签与当前筛选反馈在同一行；没有标签时仍能看到分类及查询状态。 */}
        {(
          <div className={styles.tagFilterBar} data-tauri-drag-region="false">
            {allTags.length > 0 && (
              <>
                {/* #10 筛选芯片增删动画：勾选标签时芯片弹入，点 × 时弹出，兄弟芯片 layout 让位 */}
                <AnimatePresence initial={false}>
                {selectedTagIds.map((tid) => {
                  const tag = allTags.find((t) => t.id === tid);
                  if (!tag) return null;
                  return (
                    <AnimatedTagBadge
                      key={tid}
                      tag={tag}
                      variant="chip"
                      onRemove={(t) => toggleTagFilter(t.id)}
                    />
                  );
                })}
                </AnimatePresence>
                {selectedTagIds.length > 0 && (
                  <button className={styles.tagFilterClear} onClick={clearTagFilters} title="清除所有标签筛选">
                    清除
                  </button>
                )}
                <button
                  className={styles.tagFilterAdd}
                  onClick={() => setTagPickerOpen(!tagPickerOpen)}
                >
                  <Tag size={12} /> 标签筛选
                </button>
                <AnimatePresence>
                  {tagPickerOpen && (
                    <TagPickerPopover
                      tags={allTags}
                      selectedTagIds={selectedTagIds}
                      onToggle={toggleTagFilter}
                      onClose={() => setTagPickerOpen(false)}
                    />
                  )}
                </AnimatePresence>
              </>
            )}
            <HistoryFilterStatus />
            {/* 剪贴板同步：记录模式语境入口；未开启时整块不渲染 */}
            {lanSyncEnabled && (
              <div className={styles.tagRowEnd}>
                <LanSyncCap />
              </div>
            )}
          </div>
        )}
  </>;
}

/* ===== 标签选择 Popover ===== */
function TagPickerPopover({ tags, selectedTagIds, onToggle, onClose }: {
  tags: import("@/stores/appStore").Tag[];
  selectedTagIds: string[];
  onToggle: (tagId: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, onClose);

  // 分组：自动标签 vs 手动标签
  const { autoTags, manualTags } = useMemo(() => {
    const auto = tags.filter(t => t.source === "auto").sort((a, b) => a.name.localeCompare(b.name, "zh"));
    const manual = tags.filter(t => t.source === "manual").sort((a, b) => a.name.localeCompare(b.name, "zh"));
    return { autoTags: auto, manualTags: manual };
  }, [tags]);

  const renderTag = (tag: import("@/stores/appStore").Tag) => (
    <TagBadge
      key={tag.id}
      tag={tag}
      variant="picker"
      active={selectedTagIds.includes(tag.id)}
      onClick={(t) => onToggle(t.id)}
    />
  );

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: -4, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.96 }}
      transition={CONTENT_TRANSITION}
      className={styles.tagPickerPopover}
    >
      <div className={styles.tagPickerHeader}>
        <span>选择标签筛选</span>
        <button className={styles.tagPickerClose} onClick={onClose}><X size={12} /></button>
      </div>
      <div className={styles.tagPickerBody}>
        {tags.length === 0 ? (
          <div className={styles.tagPickerEmpty}>
            暂无标签，右键卡片 → 编辑标签 来创建
          </div>
        ) : (
          <>
            {autoTags.length > 0 && (
              <>
                <div className={styles.tagPickerSection}>🤖 智能标签</div>
                {autoTags.map(renderTag)}
                {manualTags.length > 0 && <div className={styles.tagPickerDivider} />}
              </>
            )}
            {manualTags.length > 0 && (
              <>
                <div className={styles.tagPickerSection}>🏷️ 我的标签</div>
                {manualTags.map(renderTag)}
              </>
            )}
          </>
        )}
      </div>
    </motion.div>
  );
}
