import { useState, useRef, useEffect } from "react";
import { X, Search, ChevronRight } from "lucide-react";
import { AppConfig } from "@/stores/appStore";
import helpStyles from "../Help.module.css";

function KeyCaps({ value }: { value: string }) {
  const parts = value.split("+").map((p) => {
    const t = p.trim();
    if (t.length === 1) return t.toUpperCase();
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  });
  return (
    <span className={helpStyles.hKey}>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && <span className="plus">+</span>}
          {p}
        </span>
      ))}
    </span>
  );
}

function StaticKey({ children }: { children: string }) {
  return <span className={helpStyles.hKey}>{children}</span>;
}

function KeyRow({ desc, value, isStatic, hidden }: { desc: string; value: string; isStatic?: boolean; hidden?: boolean }) {
  return (
    <div className={`${helpStyles.h2Row}${hidden ? ` ${helpStyles.h2Hidden}` : ""}`}>
      <span className={helpStyles.h2Desc}>{desc}</span>
      {isStatic ? <StaticKey>{value}</StaticKey> : <KeyCaps value={value} />}
    </div>
  );
}

function SubTitle({ children, hidden }: { children: string; hidden?: boolean }) {
  return <div className={`${helpStyles.h2SubTitle}${hidden ? ` ${helpStyles.h2Hidden}` : ""}`}>{children}</div>;
}

function TipItem({ children, hidden }: { children: React.ReactNode; hidden?: boolean }) {
  return <div className={`${helpStyles.h2Tip}${hidden ? ` ${helpStyles.h2Hidden}` : ""}`}>{children}</div>;
}

function matches(q: string, ...texts: (string | undefined)[]) {
  if (!q) return false;
  const lower = q.toLowerCase();
  return texts.some(t => t?.toLowerCase().includes(lower));
}

function Section({
  icon, iconBg, title, defaultExpanded, forceExpand, hasMatch, children
}: {
  icon: React.ReactNode; iconBg: string; title: string; defaultExpanded?: boolean; forceExpand: boolean; hasMatch: boolean; children: React.ReactNode;
}) {
  const [manualExpanded, setManualExpanded] = useState(defaultExpanded ?? false);
  const expanded = forceExpand ? true : manualExpanded;
  if (forceExpand && !hasMatch) return null;
  return (
    <div className={`${helpStyles.h2Section}${expanded ? ` ${helpStyles.expanded}` : ""}`}>
      <div className={helpStyles.h2SectionHeader} onClick={() => !forceExpand && setManualExpanded(!manualExpanded)}>
        <span className={helpStyles.h2SectionIcon} style={{ background: iconBg }}>{icon}</span>
        <span className={helpStyles.h2SectionTitle}>{title}</span>
        <ChevronRight size={12} className={helpStyles.h2Arrow} />
      </div>
      <div className={helpStyles.h2SectionContent}>
        <div className={helpStyles.h2SectionInner}>{children}</div>
      </div>
    </div>
  );
}

export function HelpTabContent({ config, appName, appVersion }: { config: AppConfig; appName: string; appVersion: string }) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQuery("");
    setTimeout(() => searchRef.current?.focus(), 100);
  }, []);

  const hotkeyShow = (config.hotkey as string) || "ctrl+alt+v";
  const hotkeySeq = (config.sequential_hotkey as string) || "ctrl+alt+q";
  const hotkeySelectAll = (config.select_all_hotkey as string) || "ctrl+a";

  const q = query.trim();
  const searching = q.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className={helpStyles.h2SearchBar}>
        <div className={helpStyles.h2SearchWrap}>
          <Search size={13} className={helpStyles.h2SearchIcon} />
          <input
            ref={searchRef}
            type="text"
            className={helpStyles.h2SearchInput}
            placeholder="搜索快捷键、功能…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }}
          />
          {searching && (
            <button className={helpStyles.h2SearchClear} onClick={() => { setQuery(""); searchRef.current?.focus(); }}>
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      <div className={`dialog-body ${helpStyles.h2Body}`}>
        <Section icon={<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h8M6 12h.01M18 12h.01M6 16h12"/></svg>} iconBg="linear-gradient(135deg, #3B82F6, #0078D4)" title="快捷键速查" defaultExpanded
          forceExpand={searching} hasMatch={!searching || matches(q, "唤出 隐藏 窗口", "隐藏 Esc", "设置 ctrl+s", "帮助 ctrl+h", "片段库 ctrl+b", "内容提取 ctrl+e", "导航 上下 ↑ ↓", "顶部 底部 Home End", "粘贴 Enter", "预览 Space", "删除 Delete", "右键 Shift F10", "全选 ctrl+a", "置顶 ctrl+d", "撤销 ctrl+z", "多选 ctrl click", "范围 shift click", "依次粘贴 ctrl+q", "粘贴第N ctrl alt 1 9")}>
          <SubTitle hidden={searching && !matches(q, "唤出 隐藏 窗口", "隐藏 Esc", "设置 ctrl+s", "帮助 ctrl+h", "片段库 ctrl+b", "内容提取 ctrl+e")}>全局操作</SubTitle>
          <KeyRow desc="唤出 / 隐藏窗口" value={hotkeyShow} hidden={searching && !matches(q, "唤出 隐藏 窗口", hotkeyShow)} />
          <KeyRow desc="隐藏窗口" value="Esc" isStatic hidden={searching && !matches(q, "隐藏 Esc", "窗口")} />
          <KeyRow desc="打开设置" value="ctrl+s" hidden={searching && !matches(q, "设置 ctrl+s")} />
          <KeyRow desc="打开帮助" value="ctrl+h" hidden={searching && !matches(q, "帮助 ctrl+h")} />
          <KeyRow desc="打开片段库" value="ctrl+b" hidden={searching && !matches(q, "片段库 ctrl+b")} />
          <KeyRow desc="打开内容提取" value="ctrl+e" hidden={searching && !matches(q, "内容提取 ctrl+e")} />

          <SubTitle hidden={searching && !matches(q, "导航 上下 ↑ ↓", "顶部 底部 Home End", "粘贴 Enter", "预览 Space", "删除 Delete", "右键 Shift F10", "全选 ctrl+a", "置顶 ctrl+d", "撤销 ctrl+z")}>列表操作</SubTitle>
          <KeyRow desc="上下导航记录" value="↑ / ↓" isStatic hidden={searching && !matches(q, "导航 上下 ↑ ↓")} />
          <KeyRow desc="跳到顶部 / 底部" value="Home / End" isStatic hidden={searching && !matches(q, "顶部 底部 Home End")} />
          <KeyRow desc="粘贴选中记录" value="Enter" isStatic hidden={searching && !matches(q, "粘贴 Enter 选中")} />
          <KeyRow desc="快速预览内容" value="Space" isStatic hidden={searching && !matches(q, "预览 Space 内容")} />
          <KeyRow desc="删除选中记录" value="Delete" isStatic hidden={searching && !matches(q, "删除 Delete")} />
          <KeyRow desc="打开右键菜单" value="Shift + F10" isStatic hidden={searching && !matches(q, "右键 Shift F10 菜单")} />
          <KeyRow desc="全选" value={hotkeySelectAll} hidden={searching && !matches(q, "全选 ctrl+a", hotkeySelectAll)} />
          <KeyRow desc="置顶 / 取消置顶" value="ctrl+d" hidden={searching && !matches(q, "置顶 ctrl+d")} />
          <KeyRow desc="撤销删除" value="ctrl+z" hidden={searching && !matches(q, "撤销 ctrl+z")} />

          <SubTitle hidden={searching && !matches(q, "多选 ctrl click", "范围 shift click")}>多选操作</SubTitle>
          <KeyRow desc="逐个多选" value="ctrl+click" hidden={searching && !matches(q, "多选 ctrl click")} />
          <KeyRow desc="范围选择" value="shift+click" hidden={searching && !matches(q, "范围 shift click")} />

          <SubTitle hidden={searching && !matches(q, "依次粘贴 ctrl+q", "粘贴第N ctrl alt 1 9")}>高级功能</SubTitle>
          <KeyRow desc="依次粘贴模式" value={hotkeySeq} hidden={searching && !matches(q, "依次粘贴", hotkeySeq)} />
          <KeyRow desc="粘贴第 N 条" value="ctrl+alt+1~9" hidden={searching && !matches(q, "粘贴第N ctrl alt 1 9")} />
        </Section>

        <Section icon="🧩" iconBg="linear-gradient(135deg, #8B5CF6, #5856D6)" title="功能说明与设置"
          forceExpand={searching} hasMatch={!searching || matches(q, "功能 指南 设置 说明", "主题 清理 同步 粘贴", "图片 OCR 片段 库", "空间 数据 管理 托盘")}>
          <div style={{ padding: "4px 0", fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.7 }}>
            <p style={{ margin: "0 0 8px" }}>
              各功能的详细说明和设置项说明已移至 <strong>设置页面</strong>。
            </p>
            <p style={{ margin: "0 0 4px" }}>
              📌 打开设置（Ctrl+S），点击各选项旁的 <span style={{ color: "var(--accent)", fontWeight: 600 }}>?</span> 图标查看详情。
            </p>
            <p style={{ margin: 0 }}>
              💡 也可以在此搜索框搜索功能关键词快速定位。
            </p>
          </div>
        </Section>

        <Section icon="💡" iconBg="linear-gradient(135deg, #10B981, #34C759)" title="技巧提示"
          forceExpand={searching} hasMatch={!searching || matches(q, "Ctrl Click 多选", "Shift Click 范围", "Space 预览", "双击 卡片 配置", "Ctrl Z 撤销", "Ctrl Alt 1 9", "置顶 固定", "搜索 过滤")}>
          <TipItem hidden={searching && !matches(q, "Ctrl Click 多选", "批量 删除")}>
            <span className={helpStyles.h2TipBulb}>💡</span>
            <span className={helpStyles.h2TipText}><strong>Ctrl + Click</strong> 可逐个多选记录，然后批量删除或操作</span>
          </TipItem>
          <TipItem hidden={searching && !matches(q, "Shift Click 范围", "选择")}>
            <span className={helpStyles.h2TipBulb}>💡</span>
            <span className={helpStyles.h2TipText}><strong>Shift + Click</strong> 可范围选择，从当前到点击位置全部选中</span>
          </TipItem>
          <TipItem hidden={searching && !matches(q, "Space 预览", "内容")}>
            <span className={helpStyles.h2TipBulb}>💡</span>
            <span className={helpStyles.h2TipText}>按 <strong>Space</strong> 快速预览选中内容，无需打开详情</span>
          </TipItem>
          <TipItem hidden={searching && !matches(q, "双击 卡片", "配置")}>
            <span className={helpStyles.h2TipBulb}>💡</span>
            <span className={helpStyles.h2TipText}>双击卡片行为可在设置中配置（粘贴/预览/复制）</span>
          </TipItem>
          <TipItem hidden={searching && !matches(q, "Ctrl Z 撤销", "误删 恢复")}>
            <span className={helpStyles.h2TipBulb}>💡</span>
            <span className={helpStyles.h2TipText}>误删记录可按 <strong>Ctrl + Z</strong> 立即撤销恢复</span>
          </TipItem>
          <TipItem hidden={searching && !matches(q, "Ctrl Alt 1 9", "序号 粘贴")}>
            <span className={helpStyles.h2TipBulb}>💡</span>
            <span className={helpStyles.h2TipText}><strong>Ctrl + Alt + 1~9</strong> 直接粘贴对应序号的记录，无需打开窗口</span>
          </TipItem>
          <TipItem hidden={searching && !matches(q, "置顶 固定", "常用")}>
            <span className={helpStyles.h2TipBulb}>💡</span>
            <span className={helpStyles.h2TipText}>置顶记录会始终显示在列表顶部，适合固定常用内容</span>
          </TipItem>
          <TipItem hidden={searching && !matches(q, "搜索 过滤", "关键词 类型")}>
            <span className={helpStyles.h2TipBulb}>💡</span>
            <span className={helpStyles.h2TipText}>搜索框支持关键词过滤，输入即搜，支持类型筛选</span>
          </TipItem>
        </Section>

        {searching && (
          <div className={helpStyles.h2NoResults}>未找到匹配内容</div>
        )}
      </div>
    </div>
  );
}
