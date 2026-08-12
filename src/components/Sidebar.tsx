import { useState, useRef, useEffect, useCallback } from "react";
import { useAppStore } from "@/stores/appStore";
import { useSourceIcon } from "@/hooks/useSourceIcon";
import styles from "./Sidebar.module.css";
import melodyUrl from "@/assets/melody.png";

/** 侧边栏分组项 */
export interface SidebarGroup {
  id: string;
  name: string;
  count: number;
  icon?: string;   // emoji 图标（回退用）
  color?: string;  // 颜色值，如 "#3B82F6"
  isBuiltin?: boolean; // 内置分组（全部/未分组/收藏）
  isUserGroup?: boolean; // 用户自定义分组
  section?: "builtin" | "user" | "source" | "auto"; // 所属区域
  /** 来源分组的原始 source 字符串（用于 SourceBadge 获取真实图标） */
  sourceRaw?: string;
  /** 来源分组的 source_icon 文件名（传给 useSourceIcon 当缓存 key） */
  sourceIcon?: string | null;
}

interface SidebarProps {
  open: boolean;
  activeGroupId: string;
  groups: SidebarGroup[];
  onSelectGroup: (id: string) => void;
  onClose: () => void;
  onCreateGroup?: (name: string, color: string, icon: string) => void;
  onRenameGroup?: (id: string, name: string) => void;
  onDeleteGroup?: (id: string) => void;
  onChangeGroupColor?: (id: string, color: string) => void;
}

const PRESET_COLORS = ["#3B82F6", "#22C55E", "#F97316", "#A855F7", "#EF4444", "#EC4899", "#14B8A6", "#F59E0B", "#6366F1"];
const PRESET_ICONS = ["📁", "📂", "🏷️", "📌", "⭐", "❤️", "🔥", "💼", "🎯", "📝", "💡", "🔖"];

/** 来源分组图标：真实应用图标 + emoji 回退（双模式解析走 useSourceIcon）。
    回退用传入的 fallbackEmoji 而不是 hook 里的 emoji：分组自己带图标（用户可改），
    优先级高于 SOURCE_MAP 的预设。 */
function SourceGroupIcon({ source, sourceIcon, fallbackEmoji }: { source: string; sourceIcon?: string | null; fallbackEmoji: string }) {
  const { realIconUrl } = useSourceIcon(source, sourceIcon);

  if (realIconUrl) {
    return <img src={realIconUrl} alt="" className={styles.sourceIcon} />;
  }
  return <span className={styles.icon}>{fallbackEmoji}</span>;
}

export function Sidebar({ open, activeGroupId, groups, onSelectGroup, onClose, onCreateGroup, onRenameGroup, onDeleteGroup, onChangeGroupColor }: SidebarProps) {
  const theme = useAppStore((s) => s.config.theme);
  const isBlossom = theme === "blossom";
  // blossom 主题：预设色板/图标换甜美系（粉+蝴蝶结蓝在前）
  const presetColors = isBlossom
    ? ["#F0568C", "#7EC8E3", "#EC4899", "#A855F7", "#F97316", "#22C55E", "#3B82F6", "#F59E0B", "#14B8A6"]
    : PRESET_COLORS;
  const presetIcons = isBlossom
    ? ["🎀", "💗", "🌸", "💌", "⭐", "📁", "🏷️", "📌", "🔥", "📝", "💡", "🔖"]
    : PRESET_ICONS;
  const defaultIcon = isBlossom ? "🎀" : "📁";
  const [listKey] = useState(() => crypto.randomUUID());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(presetColors[0]);
  const [newIcon, setNewIcon] = useState(defaultIcon);
  const [contextGroup, setContextGroup] = useState<string | null>(null);
  const [contextPos, setContextPos] = useState({ x: 0, y: 0 });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  const builtinGroups = groups.filter(g => g.section === "builtin");
  const userGroups = groups.filter(g => g.section === "user");
  const sourceGroups = groups.filter(g => g.section === "source");
  const autoGroups = groups.filter(g => g.section === "auto");

  // 关闭右键菜单
  const closeContextMenu = useCallback(() => {
    setContextGroup(null);
  }, []);

  useEffect(() => {
    if (!contextGroup) return;
    const handler = (e: MouseEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) {
        closeContextMenu();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [contextGroup, closeContextMenu]);

  // 聚焦输入框
  useEffect(() => {
    if (creating && inputRef.current) {
      inputRef.current.focus();
    }
  }, [creating]);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const handleCreate = () => {
    const trimmed = newName.trim();
    if (trimmed && onCreateGroup) {
      onCreateGroup(trimmed, newColor, newIcon);
    }
    setNewName("");
    setNewColor(presetColors[0]);
    setNewIcon(defaultIcon);
    setCreating(false);
  };

  const handleCreateKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleCreate();
    } else if (e.key === "Escape") {
      setCreating(false);
      setNewName("");
    }
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      if (editName.trim() && editingId && onRenameGroup) {
        onRenameGroup(editingId, editName.trim());
      }
      setEditingId(null);
      setEditName("");
    } else if (e.key === "Escape") {
      setEditingId(null);
      setEditName("");
    }
  };

  const handleContextMenu = (e: React.MouseEvent, groupId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextGroup(groupId);
    // 边界检测：防止右键菜单溢出窗口
    const menuW = 150;
    const menuH = 280;
    const x = Math.min(e.clientX, window.innerWidth - menuW - 10);
    const y = Math.min(e.clientY, window.innerHeight - menuH - 10);
    setContextPos({ x: Math.max(x, 10), y: Math.max(y, 10) });
  };

  const startRename = (groupId: string) => {
    const group = userGroups.find(g => g.id === groupId);
    if (group) {
      setEditName(group.name);
      setEditingId(groupId);
      closeContextMenu();
    }
  };

  const renderGroupItem = (g: SidebarGroup) => {
    const isEditing = editingId === g.id;

    if (isEditing) {
      return (
        <div key={g.id} className={`${styles.item} ${styles.itemEditing}`}>
          <span
            className={styles.dot}
            style={{ background: g.color || "#3B82F6", width: 8, height: 8, borderRadius: "50%", flexShrink: 0 }}
          />
          <input
            ref={editInputRef}
            className={styles.inlineInput}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={handleEditKeyDown}
            onBlur={() => {
              if (editName.trim() && editingId && onRenameGroup) {
                onRenameGroup(editingId, editName.trim());
              }
              setEditingId(null);
              setEditName("");
            }}
            onClick={(e) => e.stopPropagation()}
          />
          <span className={styles.count}>{g.count}</span>
        </div>
      );
    }

    return (
      <button
        key={g.id}
        className={`${styles.item}${activeGroupId === g.id ? ` ${styles.active}` : ""}`}
        onClick={() => onSelectGroup(g.id)}
        onContextMenu={(e) => g.isUserGroup ? handleContextMenu(e, g.id) : undefined}
        tabIndex={open ? 0 : -1}
      >
        {g.section === "source" && g.sourceRaw ? (
          <SourceGroupIcon source={g.sourceRaw} sourceIcon={g.sourceIcon} fallbackEmoji={g.icon || "🔍"} />
        ) : g.icon ? (
          <span className={styles.icon}>{g.icon}</span>
        ) : (
          <span className={styles.dot} style={{ background: g.color || "#3B82F6" }} />
        )}
        <span className={styles.name}>{g.name}</span>
        <span className={styles.count}>{g.count}</span>
        {g.isUserGroup && (
          <span
            className={styles.moreBtn}
            onClick={(e) => {
              e.stopPropagation();
              handleContextMenu(e as unknown as React.MouseEvent, g.id);
            }}
            title="更多操作"
          >
            ⋯
          </span>
        )}
      </button>
    );
  };

  return (
    <aside className={`${styles.sidebar}${open ? ` ${styles.open}` : ""}`}>
      <div className={styles.list} key={listKey}>
        {/* 内置分组 */}
        {builtinGroups.map(renderGroupItem)}

        {/* 用户自定义分组 */}
        {userGroups.length > 0 && (
          <>
            <div className={styles.sep} />
            <div className={styles.sectionLabel}>分组</div>
            {userGroups.map(renderGroupItem)}
          </>
        )}

        {/* 新建分组输入框 */}
        {creating && (
          <div className={styles.createRow}>
            <div className={styles.colorPicker}>
              {presetColors.map((c) => (
                <button
                  key={c}
                  className={`${styles.colorDot}${newColor === c ? ` ${styles.colorDotActive}` : ""}`}
                  style={{ background: c }}
                  onClick={() => setNewColor(c)}
                  tabIndex={open ? 0 : -1}
                />
              ))}
            </div>
            <div className={styles.iconPicker}>
              {presetIcons.map((icon) => (
                <button
                  key={icon}
                  className={`${styles.iconDot}${newIcon === icon ? ` ${styles.iconDotActive}` : ""}`}
                  onClick={() => setNewIcon(icon)}
                  tabIndex={open ? 0 : -1}
                >
                  {icon}
                </button>
              ))}
            </div>
            <div className={styles.createInputRow}>
              <span className={styles.dot} style={{ background: newColor }} />
              <input
                ref={inputRef}
                className={styles.inlineInput}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={handleCreateKeyDown}
                placeholder="分组名称"
                tabIndex={open ? 0 : -1}
              />
              <button className={styles.createConfirm} onClick={handleCreate} tabIndex={open ? 0 : -1}>✓</button>
            </div>
          </div>
        )}

        {/* + 新建分组按钮 */}
        <button
          className={`${styles.item} ${styles.addGroupBtn}`}
          onClick={() => { setCreating(true); setNewName(""); setNewColor(presetColors[0]); setNewIcon(defaultIcon); }}
          tabIndex={open ? 0 : -1}
        >
          <span className={styles.addIcon}>+</span>
          <span className={styles.name}>新建分组</span>
        </button>

        {/* 智能分类（AI 自动标签作为虚拟分组） */}
        {autoGroups.length > 0 && (
          <>
            <div className={styles.sep} />
            <div className={styles.sectionLabel}>智能分类</div>
            {autoGroups.map(renderGroupItem)}
          </>
        )}

        {/* 来源分组 */}
        {sourceGroups.length > 0 && (
          <>
            <div className={styles.sep} />
            <div className={styles.sectionLabel}>来源</div>
            {sourceGroups.map(renderGroupItem)}
          </>
        )}
      </div>

      <div className={styles.footer}>
        {isBlossom && (
          <div className={styles.melodyFoot}>
            <img className={styles.melodyFootImg} src={melodyUrl} alt="" draggable={false} />
            <span className={styles.melodyFootText}>美乐蒂帮你收着 💗</span>
          </div>
        )}
        <button className={styles.collapseBtn} onClick={onClose} tabIndex={open ? 0 : -1}>
          <svg className={styles.collapseIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 3L6 8l5 5" />
          </svg>
          收起侧边栏
        </button>
      </div>

      {/* 右键菜单 Portal */}
      {contextGroup && (
        <div
          ref={ctxMenuRef}
          className={styles.contextMenu}
          style={{ left: contextPos.x, top: contextPos.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className={styles.contextMenuItem} onClick={() => startRename(contextGroup)}>
            重命名
          </button>
          <div className={styles.contextMenuLabel}>颜色</div>
          <div className={styles.contextMenuColors}>
            {presetColors.map((c) => (
              <button
                key={c}
                className={`${styles.contextMenuColorDot}${(userGroups.find(g => g.id === contextGroup)?.color) === c ? ` ${styles.contextMenuColorDotActive}` : ""}`}
                style={{ background: c }}
                onClick={() => {
                  if (onChangeGroupColor) onChangeGroupColor(contextGroup, c);
                  closeContextMenu();
                }}
              />
            ))}
          </div>
          <div className={styles.contextMenuSep} />
          <button
            className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
            onClick={() => {
              if (onDeleteGroup) onDeleteGroup(contextGroup);
              closeContextMenu();
            }}
          >
            删除分组
          </button>
        </div>
      )}
    </aside>
  );
}
