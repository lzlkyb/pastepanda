import { appDataDir, join } from "@tauri-apps/api/path";
import { configuredShortcutLabel, primaryShortcutLabel } from "@/lib/utils";
import { useState, useEffect } from "react";
import { ChevronRight } from "lucide-react";
import { AppConfig } from "@/stores/appStore";
import helpStyles from "../Help.module.css";

/* ─── 基础组件 ─── */

function KeyCaps({ value }: { value: string }) {
  const parts = value.split("+").map((p) => {
    return p.trim();
  });
  return (
    <span className={helpStyles.hKey}>
      {/* ❗ 这里不能写字面量 `className="plus"`：Help.module.css 是 CSS Module，
          `.hKey .plus` 两个类名都会被哈希，字面量永远匹配不上，
          结果是快捷键里那个 `+` 号一直没样式（2026-09-05 修）。 */}
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && <span className={helpStyles.plus}>+</span>}
          {p}
        </span>
      ))}
    </span>
  );
}

function StaticKey({ children }: { children: string }) {
  return <span className={helpStyles.hKey}>{children}</span>;
}

function KeyRow({ desc, value, isStatic }: { desc: string; value: string; isStatic?: boolean }) {
  return (
    <div className={helpStyles.h2Row}>
      <span className={helpStyles.h2Desc}>{desc}</span>
      {isStatic ? <StaticKey>{value}</StaticKey> : <KeyCaps value={value} />}
    </div>
  );
}

function SubTitle({ children }: { children: string }) {
  return <div className={helpStyles.h2SubTitle}>{children}</div>;
}

/* ─── 折叠面板 ─── */

function Collapse({ icon, title, defaultOpen, children }: {
  icon: string; title: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className={`${helpStyles.collapse}${open ? ` ${helpStyles.collapseOpen}` : ""}`}>
      <button type="button" className={helpStyles.collapseHeader} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{icon}</span>
        <span>{title}</span>
        <ChevronRight size={11} className={helpStyles.collapseArrow} />
      </button>
      <div className={helpStyles.collapseBody} inert={!open} aria-hidden={!open}>
        <div className={helpStyles.collapseInner}>{children}</div>
      </div>
    </div>
  );
}

/* ─── FAQ 项 ─── */

function FaqItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
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
  { icon: "📋", title: "复制内容", desc: "使用系统复制快捷键，PastePanda 自动记录" },
  { icon: "⌨️", title: "热键唤出", desc: "按已配置的唤出热键，或从托盘打开窗口" },
  { icon: "🚀", title: "粘贴到目标", desc: "选中记录按 Enter，直接粘贴到前台应用" },
];

const FEATURES = [
  { icon: "📋", name: "剪贴板历史", desc: "自动记录文本/图片/文件，拼音搜索 + 类型筛选 + 标签分类", path: "主界面自动展示" },
  { icon: "📚", name: "粘贴栈", desc: "连续收集多条内容，再逐条或全部粘贴到目标窗口", path: "主界面收集模式 → 复制多条 → 粘贴栈" },
  { icon: "🔀", name: "变换枢纽", desc: "41 种变换按内容类型智能推荐：编解码 / SQL / 日志 / 文本 / 配置", path: "右键记录 → 变换" },
  { icon: "🖥️", name: "全屏编辑器", desc: "CodeMirror 多语法高亮 + Markdown 实时预览 + 行号", path: "右键 → 全屏编辑 / 双击记录" },
  { icon: "🔄", name: "配置工具箱", desc: "Properties/YAML/JSON 互转 + 跨格式语义对比 + 批量替换", path: "右键记录 → 变换；工具 → 配置对比" },
  { icon: "🔡", name: "编码转换", desc: "Base64 / URL / Unicode 编解码，结果可直接复制", path: "工具 → 编码转换" },
  { icon: "📤", name: "数据导出", desc: "历史记录导出为 Excel / CSV / JSON，支持筛选后导出", path: "设置 → 数据管理 → 导出" },
  { icon: "🌐", name: "剪贴板同步", desc: "同一局域网内 AES-256-GCM 加密同步文本/图片/文件", path: "设置 → 同步与互联 → 剪贴板同步" },
  { icon: "📝", name: "片段库", desc: "常用文本模板 + 动态变量（日期/剪贴板/UUID）", path: "工具 → 片段库" },
  { icon: "🔤", name: "正则替换", desc: "粘贴时自动应用正则规则（去空行/脱敏/URL解码等）", path: "设置 → 正则规则 → 启用" },
];

const FAQ_ITEMS = [
  { q: "全局热键不生效？", a: "检查热键是否被其他软件（输入法、截图工具等）占用。打开设置 → 快捷键 → 唤出窗口，重新绑定一个不冲突的组合。留空表示禁用该热键。" },
  { q: "数据存储在哪里？", a: "数据库位于应用的实际数据目录，请通过数据管理备份。" },
  { q: "为什么某些复制内容没有出现？", a: "敏感内容防护会自动跳过匹配密钥/凭证模式的剪贴板内容（如 API Key、密码）。可在设置 → 复制与粘贴 → 敏感内容防护中关闭此功能。" },
  { q: "局域网同步连不上？", a: "确认两台设备在同一子网内，两台电脑的防火墙均允许 PastePanda 通信，且两端设置了相同的同步密钥。同步使用 UDP 广播发现 + TCP 传输。" },
  { q: "怎么迁移数据到新电脑？", a: "在旧电脑打开设置 → 数据管理 → 导出（JSON），将文件拷贝到新电脑后导入。图片/文件类记录需要手动迁移对应文件。" },
  { q: "变换枢纽没有推荐任何变换？", a: "变换推荐依赖内容分类引擎的特征识别。过短的文本（少于几个字符）可能无法识别类型，此时可手动通过右键菜单 → 变换 选择需要的操作。" },
];

/* ─── 主组件 ─── */

export function HelpTabContent({ config }: { config: AppConfig; appName: string; appVersion: string }) {
  const [databasePath, setDatabasePath] = useState("正在读取实际数据目录…");
  useEffect(() => {
    let active = true;
    void appDataDir().then(dir => join(dir, "clipboard.db")).then(path => { if (active) setDatabasePath(path); }).catch(() => { if (active) setDatabasePath("无法读取数据目录，请到设置 → 数据管理检查备份"); });
    return () => { active = false; };
  }, []);
  const hotkeyShow = configuredShortcutLabel(config.hotkey, "ctrl+alt+v");
  const hotkeySeq = configuredShortcutLabel(config.sequential_hotkey, "ctrl+alt+q");
  const hotkeyStackToggle = configuredShortcutLabel(config.stack_toggle_hotkey, "ctrl+alt+k");
  const hotkeyStackPaste = configuredShortcutLabel(config.stack_paste_hotkey, "ctrl+alt+p");
  const hotkeyQuickPaste = configuredShortcutLabel(config.quick_paste_hotkey, "alt+v");

  return (
    <div className={helpStyles.helpRoot}>
      <div className={helpStyles.h2Body}>
        {/* ── 快速上手 ── */}
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

        {/* ── 功能全景 ── */}
        <div className={helpStyles.sectionLabel}>功能全景</div>
        <div className={helpStyles.featureGrid}>
          {FEATURES.map((f) => (
            <div key={f.name} className={helpStyles.featCard}>
              <div className={helpStyles.featTop}>
                <span className={helpStyles.featIcon}>{f.icon}</span>
                <span className={helpStyles.featName}>{f.name}</span>
              </div>
              <div className={helpStyles.featDesc}>{f.desc}</div>
              <span className={helpStyles.featPath}>{f.path}</span>
            </div>
          ))}
        </div>

        {/* ── 快捷键速查 ── */}
        <Collapse icon="⌨️" title="快捷键速查" defaultOpen>
          <SubTitle>全局热键</SubTitle>
          <KeyRow desc="唤出 / 隐藏窗口" value={hotkeyShow} />
          <KeyRow desc="依次粘贴（逐条文本）" value={hotkeySeq} />
          <KeyRow desc="索引粘贴第 N 条（栈内走队列）" value={configuredShortcutLabel("ctrl+alt+1~9", "")} isStatic />
          <KeyRow desc="收集模式 开/关" value={hotkeyStackToggle} />
          <KeyRow desc="粘贴收集内容（栈顶）" value={hotkeyStackPaste} />
          <KeyRow desc="快捷粘贴面板" value={hotkeyQuickPaste} />

          <SubTitle>窗口内</SubTitle>
          <KeyRow desc="上下导航" value="↑ / ↓" isStatic />
          <KeyRow desc="跳到顶部 / 底部" value="Home / End" isStatic />
          <KeyRow desc="粘贴选中记录" value="Enter" isStatic />
          <KeyRow desc="快速预览" value="Space" isStatic />
          <KeyRow desc="删除" value="Delete" isStatic />
          <KeyRow desc="转为知识库笔记" value="N" isStatic />
          <KeyRow desc="置顶 / 取消置顶" value={primaryShortcutLabel("d")} />
          <KeyRow desc="撤销删除" value={primaryShortcutLabel("z")} />
          <KeyRow desc="全选" value={primaryShortcutLabel("a")} />
          <KeyRow desc="多选" value={primaryShortcutLabel("Click")} isStatic />
          <KeyRow desc="范围选择" value="Shift+Click" isStatic />
          <KeyRow desc="打开设置" value={primaryShortcutLabel("s")} />
          <KeyRow desc="分层关闭 / 隐藏窗口" value="Escape" isStatic />
        </Collapse>

        {/* ── 常见问题 ── */}
        <Collapse icon="❓" title="常见问题">
          {FAQ_ITEMS.map((f) => (
            <FaqItem key={f.q} question={f.q} answer={f.q === "数据存储在哪里？" ? `数据库为 ${databasePath}（SQLite）。卸载应用不会自动删除数据，请通过数据管理备份。` : f.q === "局域网同步连不上？" ? "确认两台设备在同一局域网，系统防火墙允许 PastePanda 通信，再检查两端同步配置和设备关系。" : f.a} />
          ))}
        </Collapse>
      </div>
    </div>
  );
}
