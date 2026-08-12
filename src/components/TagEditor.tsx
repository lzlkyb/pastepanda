import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAppStore, HistoryItem } from "@/stores/appStore";
import { setItemTags, createTag } from "@/lib/api";
import { TagBadge, AnimatedTagBadge } from "@/components/TagBadge";
import { useToast } from "@/components/Toast";
import { X, Search } from "lucide-react";
import styles from "./TagEditor.module.css";
import { useDialogAnim } from "@/lib/dialogMotion";

const PRESET_COLORS = ["#3B82F6", "#22C55E", "#F97316", "#A855F7", "#EF4444", "#EC4899", "#14B8A6", "#F59E0B", "#6366F1"];

interface TagEditorProps {
  open: boolean;
  item: HistoryItem | null;
  onClose: () => void;
}

export function TagEditor({ open, item, onClose }: TagEditorProps) {
  const allTags = useAppStore((s) => s.tags);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(PRESET_COLORS[0]);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const anim = useDialogAnim();
  const { toast } = useToast();

  // 初始化已选标签
  useEffect(() => {
    if (open && item) {
      setSelectedIds((item.tags || []).map((t) => t.id));
      setSearch("");
      setNewTagName("");
      setNewTagColor(PRESET_COLORS[0]);
    }
  }, [open, item]);

  // 自动聚焦搜索框
  useEffect(() => {
    if (open && searchRef.current) {
      setTimeout(() => searchRef.current?.focus(), 100);
    }
  }, [open]);

  // 过滤后的标签列表
  const filteredTags = useMemo(() => {
    if (!search.trim()) return allTags;
    const kw = search.toLowerCase();
    return allTags.filter((t) => t.name.toLowerCase().includes(kw));
  }, [allTags, search]);

  // 当前已选的标签对象
  const selectedTags = useMemo(() => {
    return allTags.filter((t) => selectedIds.includes(t.id));
  }, [allTags, selectedIds]);

  const toggleTag = useCallback((tagId: string) => {
    setSelectedIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]
    );
  }, []);

  const removeTag = useCallback((tagId: string) => {
    setSelectedIds((prev) => prev.filter((id) => id !== tagId));
  }, []);

  const handleCreateTag = useCallback(async () => {
    const trimmed = newTagName.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      const tag = await createTag(trimmed, newTagColor);
      if (tag) {
        setSelectedIds((prev) => [...prev, tag.id]);
        setNewTagName("");
        setNewTagColor(PRESET_COLORS[0]);
      } else {
        // 修复：createTag 返回 null （如 tags.name 的 UNIQUE 约束冲突）时此前完全静默无操作，
        // 输入框内容还留着，用户不知道发生了什么。get_tags 会返回全部内置自动标签名（代码/链接/Python 等常用词），撞名极易，补上明确提示
        toast(`标签「${trimmed}」已存在`, "error");
      }
    } finally {
      setCreating(false);
    }
  }, [newTagName, newTagColor, creating, toast]);

  const handleSave = useCallback(async () => {
    if (!item || saving) return;
    setSaving(true);
    try {
      await setItemTags(item.id, selectedIds);
      onClose();
    } catch {
      // silently fail
    } finally {
      setSaving(false);
    }
  }, [item, selectedIds, saving, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    }
  }, [onClose]);

  const title = item
    ? item.type === "image"
      ? (item.content?.split(/[/\\]/).pop() || "图片")
      : item.type === "file"
      ? (item.content || "文件")
      : item.text?.replace(/\r?\n/g, " ").trim()?.slice(0, 40) || "(空)"
    : "";

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={styles.overlay}
          {...anim.backdrop}
          onClick={onClose}
          onKeyDown={handleKeyDown}
        >
          <motion.div
            className={styles.dialog}
            {...anim.panel}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 头部 */}
            <div className={styles.header}>
              <span className={styles.title}>🏷️ 编辑标签 — "{title}"</span>
              <button className={styles.closeBtn} onClick={onClose} tabIndex={-1}>
                <X size={14} />
              </button>
            </div>

            <div className={styles.body}>
              {/* 已选标签 */}
              <div className={styles.section}>
                <div className={styles.label}>已选标签</div>
                <div className={styles.selectedTags}>
                  {selectedTags.length === 0 ? (
                    <span className={styles.emptyHint}>暂无标签</span>
                  ) : (
                    /* #10 已选芯片增删动画：从列表勾选时弹入、点 × 时弹出；
                       initial={false}——打开弹框时已选芯片不逐个弹跳（面板自身已有入场） */
                    <AnimatePresence initial={false}>
                      {selectedTags.map((tag) => (
                        <AnimatedTagBadge
                          key={tag.id}
                          tag={tag}
                          variant="chip"
                          onRemove={(t) => removeTag(t.id)}
                        />
                      ))}
                    </AnimatePresence>
                  )}
                </div>
              </div>

              {/* 搜索标签 */}
              <div className={styles.section}>
                <div className={styles.label}>搜索或创建标签</div>
                <div className={styles.searchRow}>
                  <Search size={14} className={styles.searchIcon} />
                  <input
                    ref={searchRef}
                    type="text"
                    className={styles.searchInput}
                    placeholder="输入标签名搜索..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => {
                      // 修复：此前这里检查的是另一个输入框（新建标签）的 newTagName state，
                      // 在新建框填了名字但没提交、切到搜索框按 Enter 时会静默创建一个他并不想建的标签；
                      // 现只处理搜索框自身的逻辑——按 Enter 选中当前搜索结果中的第一个标签
                      if (e.key === "Enter" && search.trim() && filteredTags.length > 0) {
                        toggleTag(filteredTags[0].id);
                      }
                    }}
                  />
                </div>
              </div>

              {/* 已有标签列表 */}
              <div className={styles.section}>
                <div className={styles.label}>已有标签</div>
                <div className={styles.tagList}>
                  {filteredTags.length === 0 ? (
                    <div className={styles.emptyList}>未找到匹配标签</div>
                  ) : (
                    filteredTags.map((tag) => (
                      <TagBadge
                        key={tag.id}
                        tag={tag}
                        variant="picker"
                        active={selectedIds.includes(tag.id)}
                        onClick={(t) => toggleTag(t.id)}
                        tabIndex={-1}
                      />
                    ))
                  )}
                </div>
              </div>

              {/* 创建新标签 */}
              <div className={styles.createRow}>
                <input
                  type="text"
                  className={styles.createInput}
                  placeholder="新标签名..."
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newTagName.trim()) {
                      handleCreateTag();
                    }
                  }}
                />
                <div className={styles.colorRow}>
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      className={`${styles.colorDot} ${newTagColor === c ? styles.colorDotActive : ""}`}
                      style={{ background: c }}
                      onClick={() => setNewTagColor(c)}
                      tabIndex={-1}
                    />
                  ))}
                </div>
                <button
                  className={styles.createBtn}
                  onClick={handleCreateTag}
                  disabled={!newTagName.trim() || creating}
                  tabIndex={-1}
                >
                  {creating ? "..." : "+ 创建"}
                </button>
              </div>
            </div>

            {/* 底部按钮 */}
            <div className={styles.footer}>
              <button className={styles.btnSecondary} onClick={onClose} tabIndex={-1}>
                取消
              </button>
              <button
                className={styles.btnPrimary}
                onClick={handleSave}
                disabled={saving}
                tabIndex={-1}
              >
                {saving ? "保存中..." : "确定"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
