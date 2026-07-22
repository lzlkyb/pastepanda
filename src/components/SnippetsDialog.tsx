import { useState, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Plus, Trash2, Copy, Edit3, ClipboardList, Check, Download, CheckSquare } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import styles from "./Snippets.module.css";

// v5.0.39 方案A渐进式优化：卡片布局+分类标签+常驻操作栏+快速预览弹窗
const TAG_OPTIONS = ["API", "SQL", "配置", "模板", "命令"] as const;
type TagType = (typeof TAG_OPTIONS)[number] | "";
const FILTER_TAGS = ["全部", ...TAG_OPTIONS];

interface Snippet {
  id: string;
  name: string;
  content: string;
  tag: string;
}

const TAG_COLORS: Record<string, string> = {
  API: "api",
  SQL: "sql",
  "配置": "config",
  "模板": "template",
  "命令": "cmd",
};

const TAG_DOT_COLORS: Record<string, string> = {
  API: "var(--accent)",
  SQL: "var(--green)",
  "配置": "var(--orange)",
  "模板": "#a855f7",
  "命令": "var(--danger)",
};

export function SnippetsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Snippet | null>(null);
  const [activeTag, setActiveTag] = useState<string>("全部");
  const [previewSnippet, setPreviewSnippet] = useState<Snippet | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // 从后端加载片段
  const loadSnippets = useCallback(async () => {
    setLoading(true);
    try {
      const items = await invoke<Snippet[]>("get_snippets");
      setSnippets(items);
    } catch (e) {
      logger.warn("加载片段失败", e);
    } finally {
      setLoading(false);
    }
  }, []);

  // 打开时从后端加载，同时也迁移 localStorage 旧数据
  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const legacy = localStorage.getItem("snippets");
        if (legacy) {
          const oldSnippets: Snippet[] = JSON.parse(legacy);
          for (const s of oldSnippets) {
            await invoke("add_snippet", { name: s.name, content: s.content }).catch(() => {});
          }
          localStorage.removeItem("snippets");
        }
      } catch { logger.warn("迁移旧片段数据失败"); }
      await loadSnippets();
    })();
  }, [open, loadSnippets]);

  // 关闭时重置状态
  useEffect(() => {
    if (!open) {
      setBatchMode(false);
      setSelectedIds(new Set());
      setPreviewSnippet(null);
    }
  }, [open]);

  // 统计各标签数量
  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const s of snippets) {
      const t = s.tag || "";
      if (t) map[t] = (map[t] || 0) + 1;
    }
    return map;
  }, [snippets]);

  const filtered = snippets.filter((s) => {
    const kw = search.toLowerCase();
    const matchSearch = s.name.toLowerCase().includes(kw) ||
      s.content.toLowerCase().includes(kw);
    const matchTag = activeTag === "全部" || (s.tag || "") === activeTag;
    return matchSearch && matchTag;
  });

  const handleAdd = () => {
    setEditing({ id: "", name: "", content: "", tag: "" });
  };

  const handleSaveEdit = async () => {
    if (!editing || !editing.name.trim()) return;
    try {
      if (editing.id) {
        await invoke("update_snippet", {
          id: editing.id,
          name: editing.name,
          content: editing.content,
          tag: editing.tag || "",
        });
      } else {
        await invoke("add_snippet", { name: editing.name, content: editing.content });
      }
      await loadSnippets();
    } catch (e) {
      logger.warn("保存片段失败", e);
    }
    setEditing(null);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await invoke("delete_snippet", { id: deleteTarget.id });
      await loadSnippets();
    } catch (e) {
      logger.warn("删除片段失败", e);
    }
    setDeleteTarget(null);
  };

  const handleCopy = async (content: string) => {
    try { await navigator.clipboard.writeText(content); } catch { logger.warn("复制片段失败"); }
  };

  const toggleBatchSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
  };

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    // 逐条删除，单条失败不中断；无论成败都刷新列表，仅保留失败项的选中态（Low 修复）
    const failed = new Set<string>();
    for (const id of selectedIds) {
      try {
        await invoke("delete_snippet", { id });
      } catch (e) {
        logger.warn("批量删除片段失败", e);
        failed.add(id);
      }
    }
    await loadSnippets();
    setSelectedIds(failed);
  };

  const handleExportSnippets = async () => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({ filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!path) return;
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(path, JSON.stringify(snippets, null, 2));
    } catch (e) {
      logger.warn("导出片段失败", e);
    }
  };

  if (!open) return null;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="dialog-backdrop"
            onClick={onClose}
          >
            <motion.div
              initial={{ scale: 0.96, opacity: 0, y: 10 }} animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.96, opacity: 0, y: 10 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className="dialog-box w480"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className={`dialog-header ${styles.snippetsHeader}`}>
                <div className={styles.snippetsHeaderLeft}>
                  <ClipboardList size={16} style={{ color: "var(--accent)" }} />
                  <h2 className="dialog-title">片段库</h2>
                  <span className={styles.panelCount}>{snippets.length}</span>
                </div>
                <div className={styles.snippetsHeaderRight}>
                  <button
                    onClick={() => { setBatchMode(!batchMode); setSelectedIds(new Set()); }}
                    className={`${styles.btnSmV2} ${styles.outline} ${styles.compact}${batchMode ? ` ${styles.active}` : ""}`}
                    title={batchMode ? "退出管理" : "批量管理"}>
                    <CheckSquare size={13} />
                    <span>批量</span>
                  </button>
                  <button onClick={handleExportSnippets} className={`${styles.btnSmV2} ${styles.outline} ${styles.compact}`} title="导出">
                    <Download size={13} />
                    <span>导出</span>
                  </button>
                  <button onClick={handleAdd} className={`${styles.btnSmV2} ${styles.primary} ${styles.compact}`}>
                    <Plus size={13} />
                    <span>新建</span>
                  </button>
                  <button onClick={onClose} className="dialog-close"
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "")}>
                    <X size={16} />
                  </button>
                </div>
              </div>

              {/* Search */}
              <div style={{ padding: "8px 16px" }}>
                <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索片段..."
                  className={styles.snippetSearch} />
              </div>

              {/* Tag Filter */}
              <div className={styles.snippetFilterBar}>
                {FILTER_TAGS.map((tag) => {
                  const count = tag === "全部" ? snippets.length : (counts[tag] || 0);
                  const dotColor = TAG_DOT_COLORS[tag];
                  return (
                    <button
                      key={tag}
                      onClick={() => setActiveTag(tag)}
                      className={`${styles.snippetFilterChip}${activeTag === tag ? ` ${styles.active}` : ""}`}>
                      {dotColor && (
                        <span className={styles.chipDot} style={{ backgroundColor: dotColor }} />
                      )}
                      {tag}
                      <span className={styles.chipCount}>{count}</span>
                    </button>
                  );
                })}
              </div>

              {/* List */}
              <div className="dialog-body" style={{ "--dialog-body-padding": "0 16px 16px" } as React.CSSProperties}>
                {loading ? (
                  <div style={{ display: "flex", justifyContent: "center", padding: "48px 0" }}>
                    <p className={styles.snippetItemSub}>加载中...</p>
                  </div>
                ) : editing ? (
                  <div className={styles.snippetEditForm}>
                    <input type="text" value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      placeholder="片段名称"
                      className={styles.snippetEditInput} />
                    <textarea value={editing.content}
                      onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                      placeholder="片段内容..."
                      rows={4}
                      className={styles.snippetEditTextarea} />
                    <div className={styles.snippetEditTagRow}>
                      <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>标签：</span>
                      <select
                        value={editing.tag || ""}
                        onChange={(e) => setEditing({ ...editing, tag: e.target.value })}
                        className={styles.snippetEditTagSelect}>
                        <option value="">无标签</option>
                        {TAG_OPTIONS.map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </div>
                    <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                      <button onClick={() => setEditing(null)}
                        className={`${styles.extractBtnSm} ${styles.ghost}`}>取消</button>
                      <button onClick={handleSaveEdit}
                        className={`${styles.extractBtnSm} ${styles.primary}`}>保存</button>
                    </div>
                  </div>
                ) : filtered.length === 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "48px 0", gap: "8px" }}>
                    <ClipboardList size={20} style={{ color: "var(--text-muted)" }} />
                    <p className={styles.snippetItemSub}>{search ? "没有匹配的片段" : "暂无片段，点击 + 添加"}</p>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {filtered.map((s) => {
                      const tagClass = TAG_COLORS[s.tag || ""] || "";
                      return (
                        <div key={s.id} className={styles.snippetCardV2}
                          onClick={() => {
                            if (batchMode) {
                              toggleBatchSelect(s.id);
                            } else {
                              setPreviewSnippet(s);
                            }
                          }}>
                          <div className={styles.snippetCardV2Header}>
                            <div className={styles.snippetCardV2Title}>
                              {batchMode && (
                                <div
                                  className={`${styles.snippetBatchCheckbox}${selectedIds.has(s.id) ? ` ${styles.checked}` : ""}`}
                                  onClick={(e) => { e.stopPropagation(); toggleBatchSelect(s.id); }}>
                                  {selectedIds.has(s.id) ? <Check size={12} /> : ""}
                                </div>
                              )}
                              <span className={styles.snippetCardV2TitleText}>{s.name}</span>
                              {s.tag && (
                                <span className={`${styles.snippetTag} ${styles[tagClass] || ""}`}>{s.tag}</span>
                              )}
                            </div>
                          </div>
                          <div className={styles.snippetCardV2Body}>{s.content}</div>
                          <div className={styles.snippetCardV2Footer}>
                            <span className={styles.snippetCardV2Meta}>
                              <span>🕐 片段</span>
                              <span>📋 已复制 0 次</span>
                            </span>
                            <div className={styles.snippetCardV2Actions}>
                              <button className={`${styles.snippetActionBtnV2} ${styles.copy}`}
                                onClick={(e) => { e.stopPropagation(); handleCopy(s.content); }}
                                title="复制">
                                <Copy size={13} />
                              </button>
                              <button className={styles.snippetActionBtnV2}
                                onClick={(e) => { e.stopPropagation(); setEditing(s); }}
                                title="编辑">
                                <Edit3 size={13} />
                              </button>
                              <button className={`${styles.snippetActionBtnV2} ${styles.danger}`}
                                onClick={(e) => { e.stopPropagation(); setDeleteTarget(s); }}
                                title="删除">
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* 最近使用 */}
                {snippets.length > 0 && !editing && (
                  <>
                    <div className={styles.recentSectionLabel}>最近使用</div>
                    <div className={styles.recentTags}>
                      {snippets.slice(0, 5).map((s) => (
                        <span key={s.id} className={styles.recentTag}
                          onClick={() => setPreviewSnippet(s)}>
                          {s.name}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </motion.div>
          </motion.div>

          {/* 快速预览弹窗 */}
          {previewSnippet && (
            <div className={styles.snippetPreviewOverlay} onClick={() => setPreviewSnippet(null)}>
              <div className={styles.snippetPreviewModal} onClick={(e) => e.stopPropagation()}>
                <div className={styles.snippetPreviewHeader}>
                  <div className={styles.snippetPreviewTitle}>
                    {previewSnippet.name}
                    {previewSnippet.tag && (
                      <span className={`${styles.snippetTag} ${styles[TAG_COLORS[previewSnippet.tag]] || ""}`}>
                        {previewSnippet.tag}
                      </span>
                    )}
                  </div>
                  <button className="dialog-close" onClick={() => setPreviewSnippet(null)}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "")}>
                    <X size={16} />
                  </button>
                </div>
                <div className={styles.snippetPreviewBody}>{previewSnippet.content}</div>
                <div className={styles.snippetPreviewFooter}>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>🕐 片段 · 📋 已复制 0 次</span>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button className={`${styles.btnSmV2} ${styles.outline}`}
                      onClick={() => { handleCopy(previewSnippet.content); }}>
                      <Copy size={12} /> 复制
                    </button>
                    <button className={`${styles.btnSmV2} ${styles.outline}`}
                      onClick={() => { setEditing(previewSnippet); setPreviewSnippet(null); }}>
                      <Edit3 size={12} /> 编辑
                    </button>
                    <button className={`${styles.btnSmV2} ${styles.ghost}`}
                      style={{ color: "var(--danger)" }}
                      onClick={() => {
                        setDeleteTarget(previewSnippet);
                        setPreviewSnippet(null);
                      }}>
                      <Trash2 size={12} /> 删除
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 删除确认弹窗 */}
          <ConfirmDialog
            open={!!deleteTarget}
            title="确认删除片段"
            message={`确定删除片段"${deleteTarget?.name}"？此操作不可撤销。`}
            confirmText="删除"
            variant="danger"
            onConfirm={handleDelete}
            onCancel={() => setDeleteTarget(null)}
          />
        </>
      )}
    </AnimatePresence>
  );
}
