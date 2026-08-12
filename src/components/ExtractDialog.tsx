import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Link2, AtSign, Phone, Code2, Hash, Copy, CheckSquare, Save, LucideIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type HistoryItem } from "@/stores/appStore";
import { useToast } from "@/components/Toast";
import { useDialogAnim } from "@/lib/dialogMotion";
import { logger } from "@/lib/logger";
import { FocusTrap } from "@/components/FocusTrap";
import styles from "./Extract.module.css";

// v5.0.39 方案A渐进式优化：结果项存为片段+底部批量操作栏+active实色填充
type ExtractType = "url" | "email" | "phone" | "ip" | "code";

const EXTRACT_CONFIGS: { key: ExtractType; label: string; Icon: LucideIcon; regex: RegExp }[] = [
  { key: "url",   label: "链接",  Icon: Link2,  regex: /https?:\/\/[^\s<>"{}|\\^`[\]]+/g },
  { key: "email", label: "邮箱",  Icon: AtSign, regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { key: "phone", label: "电话",  Icon: Phone,  regex: /(?<!\d)(?:\+?86)?1[3-9]\d{9}(?!\d)/g },
  { key: "ip",    label: "IP",    Icon: Hash,   regex: /(?<![\d.])\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?::\d{1,5})?\b(?!\.\d)/g },
  { key: "code",  label: "代码块", Icon: Code2, regex: /```[\s\S]*?```/g },
];

// 各类型数量统计（memo：避免每次渲染对全量历史跑 5 个正则 — M23）
const useTypeCounts = (history: HistoryItem[], ws: string) =>
  useMemo(() => {
    const allText = history
      .filter((h) => h.workspace === ws && h.type === "text")
      .map((h) => h.text)
      .join("\n");
    return EXTRACT_CONFIGS.map((cfg) => ({
      ...cfg,
      count: new Set((allText.match(cfg.regex) || []).map((m) => m.trim()).filter(Boolean)).size,
    }));
  }, [history, ws]);

export function ExtractDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const history = useAppStore((s) => s.history);
  const ws = useAppStore((s) => s.config.current_workspace);
  const [type, setType] = useState<ExtractType>("url");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [savingSingle, setSavingSingle] = useState(false); // 审查：单条保存防双击
  const { toast } = useToast();
  const anim = useDialogAnim();

  const typeCounts = useTypeCounts(history, ws);

  const results = useMemo(() => {
    const cfg = EXTRACT_CONFIGS.find((c) => c.key === type)!;
    const allText = history
      .filter((h) => h.workspace === ws && h.type === "text")
      .map((h) => h.text)
      .join("\n");
    const matches = allText.match(cfg.regex) || [];
    return [...new Set(matches)].map((m) => m.trim()).filter(Boolean);
  }, [history, ws, type]);

  const toggleSelect = (item: string) => {
    const next = new Set(selected);
    if (next.has(item)) next.delete(item); else next.add(item);
    setSelected(next);
  };

  const selectAll = () => {
    if (selected.size === results.length) setSelected(new Set());
    else setSelected(new Set(results));
  };

  const copySelected = async () => {
    const text = [...selected].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制 ${selected.size} 项`, "success");
    } catch {
      logger.warn("复制选中内容失败");
      toast("复制失败", "error");
    }
  };

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(results.join("\n"));
      toast(`已复制全部 ${results.length} 项`, "success");
    } catch {
      logger.warn("复制全部内容失败");
      toast("复制失败", "error");
    }
  };

  // 保存选中项为片段：逐条保存并单独捕获每条的失败，而不是整体 try/catch，
  // 避免部分失败时已成功的条目仍留在 selected 里，重试会把已保存过的条目重复再存一遍
  const saveSelectedAsSnippets = async () => {
    if (selected.size === 0 || saving) return;
    setSaving(true);
    const items = [...selected];
    const failed: string[] = [];
    for (const item of items) {
      try {
        const name = item.length > 50 ? item.slice(0, 47) + "..." : item;
        await invoke("add_snippet", { name, content: item });
      } catch (e) {
        logger.warn("保存片段失败", e);
        failed.push(item);
      }
    }
    setSaving(false);
    if (failed.length === 0) {
      toast(`已保存 ${items.length} 条片段`, "success");
      setSelected(new Set());
    } else if (failed.length === items.length) {
      toast("保存片段失败", "error"); // 全部失败，保留原选中以便重试
    } else {
      toast(`已保存 ${items.length - failed.length} 条，${failed.length} 条失败`, "error");
      setSelected(new Set(failed)); // 只保留失败项，成功项从选中移除，避免重试时重复保存
    }
  };

  // 保存单条为片段
  const saveSingleAsSnippet = async (item: string) => {
    if (savingSingle) return; // 审查：防双击重复保存
    setSavingSingle(true);
    try {
      const name = item.length > 50 ? item.slice(0, 47) + "..." : item;
      await invoke("add_snippet", { name, content: item });
      toast("已保存为片段", "success");
    } catch (e) {
      logger.warn("保存片段失败", e);
      toast("保存片段失败", "error");
    } finally {
      setSavingSingle(false);
    }
  };

  // 注意：不能在此处 if (!open) return null —— 组件需常挂载，
  // open 变 false 时由下方 AnimatePresence 驱动退场动画后再卸载
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          {...anim.backdrop}
          className="dialog-backdrop"
          onClick={onClose}
        >
          <FocusTrap>
          <motion.div
            {...anim.panel}
            className="dialog-box w380"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="dialog-header">
              <h2 className="dialog-title">内容提取</h2>
              <button onClick={onClose} className="dialog-close"
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "")}>
                <X size={16} />
              </button>
            </div>

            {/* Type selector */}
            <div className={styles.extractTypes}>
              {typeCounts.map((cfg) => {
                const active = type === cfg.key;
                const Icon = cfg.Icon;
                return (
                  <button key={cfg.key} onClick={() => { setType(cfg.key); setSelected(new Set()); }}
                    className={`${styles.extractTypeBtn}${active ? ` ${styles.active}` : ""}`}>
                    <Icon size={13} /> {cfg.label}
                    <span className={styles.tabCount}>{cfg.count}</span>
                  </button>
                );
              })}
            </div>

            {/* Results list */}
            <div className="dialog-body" style={{ "--dialog-body-padding": "8px 16px", "--dialog-body-gap": "4px" } as React.CSSProperties}>
              {results.length === 0 ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "48px 0", gap: "8px" }}>
                  <p className={styles.snippetItemSub}>未找到匹配的内容</p>
                </div>
              ) : (
                results.map((item, i) => {
                  const isSel = selected.has(item);
                  return (
                    <div key={i}
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleSelect(item)}
                      onKeyDown={(e) => {
                        // 审查：键盘可达（此前 div onClick 纯键盘无法选择）
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleSelect(item);
                        }
                      }}
                      className={`${styles.extractResult}${isSel ? ` ${styles.selected}` : ""}`}>
                      <div className={`${styles.extractCheckbox}${isSel ? ` ${styles.checked}` : ""}`}>
                        {isSel && <CheckSquare size={10} color="#fff" />}
                      </div>
                      <span className={styles.extractResultText}>{item}</span>
                      <div className={styles.extractItemActions}>
                        <button className={`${styles.extractItemActionBtn} ${styles.copy}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            navigator.clipboard
                              .writeText(item)
                              .then(() => toast("已复制", "success"))
                              .catch(() => toast("复制失败", "error"));
                          }}
                          title="复制">
                          <Copy size={12} />
                        </button>
                        <button className={`${styles.extractItemActionBtn} ${styles.save}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            saveSingleAsSnippet(item);
                          }}
                          title="存为片段">
                          <Save size={12} />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* 底部操作栏 */}
            {results.length > 0 && (
              <div className={styles.extractFooterBar}>
                <div className={styles.extractFooterLeft}>
                  <span>已选 <strong>{selected.size}</strong> / {results.length} 项</span>
                  <button className={`${styles.btnSmV2} ${styles.ghost}`} onClick={selectAll}>
                    {selected.size === results.length ? "取消全选" : "全选"}
                  </button>
                </div>
                <div className={styles.extractFooterRight}>
                  {/* 未选任何项时降级为「复制全部」：原来这里是个灰掉的死按钮，
                      而 copyAll 已经写好却没接到任何地方 */}
                  <button className={`${styles.btnSmV2} ${styles.outline}`}
                    onClick={selected.size === 0 ? copyAll : copySelected}>
                    <Copy size={12} /> {selected.size === 0 ? "复制全部" : "复制选中"}
                  </button>
                  <button className={`${styles.btnSmV2} ${styles.primary}`} onClick={saveSelectedAsSnippets}
                    disabled={selected.size === 0 || saving}>
                    <Save size={12} /> {saving ? "保存中..." : "存为片段（已选）"}
                  </button>
                </div>
              </div>
            )}
          </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
