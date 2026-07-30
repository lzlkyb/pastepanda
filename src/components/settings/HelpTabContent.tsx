import { useState, useRef, useEffect } from "react";
import { X, Search, ChevronRight } from "lucide-react";
import { AppConfig } from "@/stores/appStore";
import helpStyles from "../Help.module.css";

/* ─── 基础组件 ─── */

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
  if (hidden) return null;
  return (
    <div className={helpStyles.h2Row}>
      <span className={helpStyles.h2Desc}>{desc}</span>
      {isStatic ? <StaticKey>{value}</StaticKey> : <KeyCaps value={value} />}
    </div>
  );
}

function SubTitle({ children, hidden }: { children: string; hidden?: boolean }) {
  if (hidden) return null;
  return <div className={helpStyles.h2SubTitle}>{children}</div>;
}

function matches(q: string, ...texts: (string | undefined)[]) {
  if (!q) return false;
  const lower = q.toLowerCase();
  return texts.some(t => t?.toLowerCase().includes(lower));
}

/* ─── 折叠面板 ─── */

function Collapse({ icon, title, defaultOpen, children, hidden }: {
  icon: string; title: string; defaultOpen?: boolean; children: React.ReactNode; hidden?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  if (hidden) return null;
  return (
    <div className={`${helpStyles.collapse}${open ? ` ${helpStyles.collapseOpen}` : ""}`}>
      <div className={helpStyles.collapseHeader} onClick={() => setOpen(!open)}>
        <span>{icon}</span>
        <span>{title}</span>
        <ChevronRight size={11} className={helpStyles.collapseArrow} />
      </div>
      <div className={helpStyles.collapseBody}>
        <div className={helpStyles.collapseInner}>{children}</div>
      </div>
    </div>
  );
}

/* ─── FAQ 项 ─── */

function FaqItem({ question, answer, hidden }: { question: string; answer: string; hidden?: boolean }) {
  const [open, setOpen] = useState(false);
  if (hidden) return null;
  return (
    <div className={`${helpStyles.faqItem}${open ? ` ${helpStyles.faqItemOpen}` : ""}`}>
      <button className={helpStyles.faqQuestion} onClick={() => setOpen(!open)}>
        <span>{question}</span>
        <span className={helpStyles.faqArrow}>▼</span>
      </button>
      {open && <div className={helpStyles.faqAnswer}>{answer}</div>}
    </div>
  );
}

/* ─── 静态数据 ─── */

const QUICK_STEPS = [
  { icon: "📋", title: "复制内容", desc: "在任意应用中 Ctrl+C，PastePanda 自动记录" },
  { icon: "⌨️", title: "热键唤出", desc: "Ctrl+Alt+V 打开窗口，搜索或浏览历史" },
  { icon: "🚀", title: "粘贴到目标", desc: "选中记录按 Enter，直接粘贴到前台应用" },
];

const FEATURES = [
  { icon: "📋", bg: "linear-gradient(135deg,#3B82F6,#0078D4)", name: "剪贴板历史", desc: "自动记录文本/图片/文件，拼音搜索 + 类型筛选 + 标签分类", path: "主界面自动展示" },
  { icon: "📚", bg: "linear-gradient(135deg,#8B5CF6,#5856D6)", name: "粘贴栈", desc: "连续收集多条内容，再逐条或全部粘贴到目标窗口", path: "Ctrl+Alt+K 开启 → 复制多条 → Ctrl+Alt+P 粘贴" },
  { icon: "🔀", bg: "linear-gradient(135deg,#F59E0B,#D97706)", name: "变换枢纽", desc: "41 种变换按内容类型智能推荐：编解码 / SQL / 日志 / 文本 / 配置", path: "右键记录 → 变换" },
  { icon: "🖥️", bg: "linear-gradient(135deg,#10B981,#059669)", name: "全屏编辑器", desc: "CodeMirror 多语法高亮 + Markdown 实时预览 + 行号", path: "右键 → 全屏编辑 / 双击记录" },
  { icon: "🔄", bg: "linear-gradient(135deg,#EC4899,#BE185D)", name: "配置工具箱", desc: "Properties/YAML/JSON 互转 + 跨格式语义对比 + 批量替换", path: "顶栏工具箱 → 配置转换 / 配置对比" },
  { icon: "🔡", bg: "linear-gradient(135deg,#06B6D4,#0891B2)", name: "编码转换", desc: "自动检测 GBK/Big5/Shift_JIS 等编码，一键转 UTF-8", path: "顶栏工具箱 → 编码转换" },
  { icon: "📤", bg: "linear-gradient(135deg,#84CC16,#65A30D)", name: "数据导出", desc: "历史记录导出为 Excel / CSV / JSON，支持筛选后导出", path: "顶栏工具箱 → 导出" },
  { icon: "🌐", bg: "linear-gradient(135deg,#6366F1,#4F46E5)", name: "局域网同步", desc: "多设备间 AES-256-GCM 加密同步文本/图片/文件", path: "设置 → 局域网同步 → 开启" },
  { icon: "📝", bg: "linear-gradient(135deg,#F97316,#EA580C)", name: "片段库", desc: "常用文本模板 + 动态变量（日期/剪贴板/UUID）", path: "顶栏工具箱 → 片段库" },
  { icon: "🔤", bg: "linear-gradient(135deg,#EF4444,#DC2626)", name: "正则替换", desc: "粘贴时自动应用正则规则（去空行/脱敏/URL解码等）", path: "设置 → 正则规则 → 启用" },
];

const FAQ_ITEMS = [
  { q: "全局热键不生效？", a: "检查热键是否被其他软件（输入法、截图工具等）占用。打开设置 → 通用 → 全局热键，重新绑定一个不冲突的组合。留空表示禁用该热键。" },
  { q: "数据存储在哪里？", a: "所有数据保存在 %APPDATA%/PastePanda/pastepanda.db（SQLite 数据库）。卸载时不会自动删除，可手动备份或清理。" },
  { q: "为什么某些复制内容没有出现？", a: "敏感内容防护会自动跳过匹配密钥/凭证模式的剪贴板内容（如 API Key、密码）。可在设置 → 通用 → 敏感内容防护中关闭此功能。" },
  { q: "局域网同步连不上？", a: "确认两台设备在同一子网内，Windows 防火墙已放行 PastePanda，且两端设置了相同的同步密钥。同步使用 UDP 广播发现 + TCP 传输。" },
  { q: "怎么迁移数据到新电脑？", a: "在旧电脑打开设置 → 数据管理 → 导出（JSON），将文件拷贝到新电脑后导入。图片/文件类记录需要手动迁移对应文件。" },
  { q: "变换枢纽没有推荐任何变换？", a: "变换推荐依赖内容分类引擎的特征识别。过短的文本（少于几个字符）可能无法识别类型，此时可手动通过右键菜单 → 变换 选择需要的操作。" },
];

/* ─── 主组件 ─── */

export function HelpTabContent({ config }: { config: AppConfig; appName: string; appVersion: string }) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQuery("");
    setTimeout(() => searchRef.current?.focus(), 100);
  }, []);

  const hotkeyShow = (config.hotkey as string) || "ctrl+alt+v";
  const hotkeySeq = (config.sequential_hotkey as string) || "ctrl+alt+q";
  const hotkeyStackToggle = (config.stack_toggle_hotkey as string) || "ctrl+alt+k";
  const hotkeyStackPaste = (config.stack_paste_hotkey as string) || "ctrl+alt+p";
  const hotkeyQuickPaste = (config.quick_paste_hotkey as string) || "alt+v";

  const q = query.trim();
  const searching = q.length > 0;

  // 搜索时过滤功能卡片
  const visibleFeatures = searching
    ? FEATURES.filter((f) => matches(q, f.name, f.desc, f.path))
    : FEATURES;

  const hotkeyMatch = !searching || matches(q, "唤出 隐藏 窗口 热键 全局 粘贴 栈 索引 导航 删除 置顶 撤销 全选 预览 Escape Enter Space Delete", hotkeyShow, hotkeySeq, hotkeyStackToggle, hotkeyStackPaste, hotkeyQuickPaste);
  const faqMatch = !searching || matches(q, ...FAQ_ITEMS.map((f) => `${f.q} ${f.a}`));

  // 搜索时无任何结果
  const noResults = searching && visibleFeatures.length === 0 && !hotkeyMatch && !faqMatch;

  return (
    <div className={helpStyles.helpRoot}>
      {/* 搜索栏 */}
      <div className={helpStyles.h2SearchBar}>
        <div className={helpStyles.h2SearchWrap}>
          <Search size={13} className={helpStyles.h2SearchIcon} />
          <input
            ref={searchRef}
            type="text"
            className={helpStyles.h2SearchInput}
            placeholder="搜索功能、快捷键、问题…"
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

      <div className={helpStyles.h2Body}>
        {/* ── 快速上手 ── */}
        {!searching && (
          <div className={helpStyles.quickstart}>
            {QUICK_STEPS.map((s, i) => (
              <div key={i} className={helpStyles.qsCard}>
                <div className={helpStyles.qsNum}>{i + 1}</div>
                <div className={helpStyles.qsIcon}>{s.icon}</div>
                <div className={helpStyles.qsTitle}>{s.title}</div>
                <div className={helpStyles.qsDesc}>{s.desc}</div>
                {i < QUICK_STEPS.length - 1 && <span className={helpStyles.qsArrow}>→</span>}
              </div>
            ))}
          </div>
        )}

        {/* ── 功能全景 ── */}
        {visibleFeatures.length > 0 && (
          <>
            <div className={helpStyles.sectionLabel}>功能全景</div>
            <div className={helpStyles.featureGrid}>
              {visibleFeatures.map((f) => (
                <div key={f.name} className={helpStyles.featCard}>
                  <div className={helpStyles.featTop}>
                    <span className={helpStyles.featIcon} style={{ background: f.bg }}>{f.icon}</span>
                    <span className={helpStyles.featName}>{f.name}</span>
                  </div>
                  <div className={helpStyles.featDesc}>{f.desc}</div>
                  <span className={helpStyles.featPath}>{f.path}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── 快捷键速查 ── */}
        <Collapse icon="⌨️" title="快捷键速查" defaultOpen hidden={!hotkeyMatch}>
          <SubTitle hidden={searching && !matches(q, "唤出 隐藏 窗口 热键 全局 依次 索引 栈 收集 快捷", hotkeyShow, hotkeySeq, hotkeyStackToggle, hotkeyStackPaste, hotkeyQuickPaste)}>全局热键</SubTitle>
          <KeyRow desc="唤出 / 隐藏窗口" value={hotkeyShow} hidden={searching && !matches(q, "唤出 隐藏 窗口", hotkeyShow)} />
          <KeyRow desc="依次粘贴（逐条文本）" value={hotkeySeq} hidden={searching && !matches(q, "依次粘贴 逐条", hotkeySeq)} />
          <KeyRow desc="索引粘贴第 N 条" value="Ctrl+Alt+1~9" isStatic hidden={searching && !matches(q, "索引粘贴 第N 1~9 ctrl alt")} />
          <KeyRow desc="收集模式 开/关" value={hotkeyStackToggle} hidden={searching && !matches(q, "收集 栈模式 开关", hotkeyStackToggle)} />
          <KeyRow desc="粘贴收集内容（栈顶）" value={hotkeyStackPaste} hidden={searching && !matches(q, "栈顶粘贴 收集 粘贴", hotkeyStackPaste)} />
          <KeyRow desc="快捷粘贴面板（类 Win+V）" value={hotkeyQuickPaste} hidden={searching && !matches(q, "快捷粘贴 面板 winv", hotkeyQuickPaste)} />

          <SubTitle hidden={searching && !matches(q, "导航 上下 顶部 底部 粘贴 预览 删除 置顶 撤销 全选", "Enter Space Delete Home End")}>窗口内</SubTitle>
          <KeyRow desc="上下导航" value="↑ / ↓" isStatic hidden={searching && !matches(q, "导航 上下 ↑ ↓")} />
          <KeyRow desc="跳到顶部 / 底部" value="Home / End" isStatic hidden={searching && !matches(q, "顶部 底部 Home End")} />
          <KeyRow desc="粘贴选中记录" value="Enter" isStatic hidden={searching && !matches(q, "粘贴 Enter")} />
          <KeyRow desc="快速预览" value="Space" isStatic hidden={searching && !matches(q, "预览 Space")} />
          <KeyRow desc="删除" value="Delete" isStatic hidden={searching && !matches(q, "删除 Delete")} />
          <KeyRow desc="置顶 / 取消置顶" value="Ctrl+D" hidden={searching && !matches(q, "置顶 Ctrl+D")} />
          <KeyRow desc="撤销删除" value="Ctrl+Z" hidden={searching && !matches(q, "撤销 Ctrl+Z")} />
          <KeyRow desc="全选" value="Ctrl+A" hidden={searching && !matches(q, "全选 Ctrl+A")} />
          <KeyRow desc="多选" value="Ctrl+Click" isStatic hidden={searching && !matches(q, "多选 Ctrl Click")} />
          <KeyRow desc="范围选择" value="Shift+Click" isStatic hidden={searching && !matches(q, "范围 Shift Click")} />
          <KeyRow desc="打开设置" value="Ctrl+S" hidden={searching && !matches(q, "设置 Ctrl+S")} />
          <KeyRow desc="分层关闭 / 隐藏窗口" value="Escape" isStatic hidden={searching && !matches(q, "Escape 关闭 隐藏")} />
        </Collapse>

        {/* ── 常见问题 ── */}
        <Collapse icon="❓" title="常见问题" hidden={!faqMatch}>
          {FAQ_ITEMS.map((f) => (
            <FaqItem
              key={f.q}
              question={f.q}
              answer={f.a}
              hidden={searching && !matches(q, `${f.q} ${f.a}`)}
            />
          ))}
        </Collapse>

        {noResults && (
          <div className={helpStyles.h2NoResults}>未找到匹配内容</div>
        )}
      </div>
    </div>
  );
}
