#!/usr/bin/env node
/**
 * 生成 design/README.md —— 设计稿导航索引。
 *
 * 为什么要脚本而不是手写：
 *   design/ 根目录有近 300 份 HTML 设计稿，手工维护索引必然腐化。
 *   这里只输出**机械可得、可复现**的事实（入库日期、体量、主题分组），
 *   不给「是否已落地」判定 —— 见 README 头部「关于状态标注」一节。
 *
 * 用法： node scripts/gen-design-index.mjs
 *
 * 分组 == 顺序匹配的规则表（RULES），首个命中者胜。
 * 经验：**窄词放前面，宽词放后面**。「美化 / 视觉 / UI-」这类宽词一旦排前面，
 * 会把截图、AI、知识库的稿子全吸进视觉组（2026-09-14 踩过）。
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const DESIGN = path.join(ROOT, "design");
const OUT = path.join(DESIGN, "README.md");

/** 输出顺序 + 章节说明。key 即 classify() 的返回值。 */
const TOPICS = [
  {
    key: "visual",
    title: "视觉与品牌",
    desc: "主题、色彩、图标、Logo、吉祥物、质感、全局规则审计。改观感前先看这里。",
  },
  { key: "flow", title: "流程图", desc: "流程图的内嵌/全屏编辑、分组缩放、空态引导。" },
  {
    key: "shot",
    title: "截图与标注",
    desc: "截图子系统：选区状态机、工具栏、标注工具、取文字/OCR、贴图、长截图、遮罩。",
  },
  {
    key: "kb",
    title: "知识库与 MCP",
    desc: "知识库视图/交互/回收站/版本锚定，以及 MCP 接入、权限、局域网直连。",
  },
  {
    key: "ai",
    title: "AI 能力",
    desc: "AI 栏、AI 设置、动作链、变换卡、自进化、服务商卡片。",
  },
  { key: "settings", title: "设置与帮助", desc: "设置页、关于页、帮助页的版式与信息架构。" },
  {
    key: "toolbox",
    title: "工具箱与模式",
    desc: "工具箱、工具模式、粘贴栈、二维码/SVG 编辑器、签到等独立能力。",
  },
  {
    key: "editor",
    title: "编辑器与预览",
    desc: "文件/文本编辑器、Markdown 预览与全屏编辑、diff、正则、编解码、PDF。",
  },
  {
    key: "sync",
    title: "同步与更新",
    desc: "设备同步/配对/冲突，以及自动更新、发版说明弹框、版本徽标。",
  },
  {
    key: "shell",
    title: "主窗口与导航",
    desc: "主界面骨架：侧栏、顶栏、标签/分组、搜索、时间线、卡片、悬浮卡、托盘、详情弹窗。",
  },
];

/**
 * 规则表：顺序 = 优先级。窄词在前，宽词在后。
 * 每条规则在「文件名去掉 .html」上做正则 test。
 */
const RULES = [
  // —— 视觉：先摘掉「图标 / 色彩规范 / 全局 UI 规则」这类一眼可辨的 ——
  {
    topic: "visual",
    re: /设置图标|all-icons|icon-redesign|^logo|og-image|色彩|对比度|contrast|melody|吉祥物|immersive|皮肤|skin|浮层风格|项目质感|ui-audit|UI规则|UI升级|UI趋势|theme-preview/,
  },
  { topic: "flow", re: /流程图/ },
  {
    topic: "shot",
    re: /截图|标注|取文字|贴图|长截图|遮罩|打码|选区|OCR|ocr|screenshot|dewatermark|(^|-)image-|图片卡片|固定区域|pin-/,
  },
  {
    topic: "kb",
    re: /知识库|kb-|MCP|mcp|反链|联系人|事件聚合|转笔记|写入者筛选|库体检|每日整理|速记|目标应用感知|记忆/,
  },
  {
    topic: "ai",
    re: /^ai-|^AI|AI|自进化|服务商|画像|学习日志|learning|动作链|动作置顶|变换|推荐理由|自动触发/,
  },
  { topic: "settings", re: /设置|settings|about|help|开关/ },
  {
    topic: "toolbox",
    re: /工具箱|工具模式|二维码|粘性|栈|-stack|表格拆分|签到/,
  },
  {
    topic: "editor",
    re: /编辑器|editor|markdown|diff|正则|regex|编解码|调色板|配置结构化|媒体预览|MD导出|html-strip|PDF阅读|代码高亮/,
  },
  {
    topic: "sync",
    re: /同步|sync|更新|update|版本|version|whatsnew|远程电脑|局域网|配对|设备|冲突|徽标|badge/,
  },
  {
    topic: "shell",
    re: /p0-|main-page|主窗口|主页面|TopBar|topbar|顶栏|侧栏|sidebar|标签|tag|分组|搜索|search|timeline|时间线|卡片|card|hover|悬浮|查找|详情|宽屏|wide-screen|popup|tray|托盘|tab-|today|back-to-top|stats|统计|sponsor|来源|padding|对齐|沉浸|交互|视图切换|UX|ux|体验|提案|proposal|prototype|redesign|draft|restoration|clipboard|剪贴板|chart|separator|toast|面板|反馈|icons/,
  },
  // —— 视觉（宽）：兜底，只有排到最后才不误伤 ——
  {
    topic: "visual",
    re: /美化|视觉|界面|UI[_ -]|ui-|色彩|色板|color|主题|theme|图标|icon|logo|渐变|质感|audit|审计/,
  },
];

function classify(name) {
  const stem = name.replace(/\.html$/, "");
  for (const r of RULES) if (r.re.test(stem)) return r.topic;
  return "misc";
}

/**
 * ❗ `-c core.quotepath=false` 不能省：git 默认把非 ASCII 路径转义成
 * `"design/\346\210\252..."` 的八进制形式，中文文件名会全部匹配不上，
 * 结果就是「明明提交过却显示未提交」。
 */
const GIT = `git -c core.quotepath=false`;

/** 一次 git log 拿到全部文件的「最早入库日期」，避免逐文件调用。 */
function collectAddDates() {
  const map = new Map();
  let out = "";
  try {
    out = execSync(
      `${GIT} log --diff-filter=A --name-only --format="__C__%ad" --date=short -- design/`,
      { cwd: ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return map;
  }
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith("__C__")) {
      cur = line.slice(5).trim();
      continue;
    }
    if (!cur) continue;
    // git log 倒序输出：同路径多次出现时，越晚看到的越早 → 取最早日期
    if (!map.has(line) || map.get(line) > cur) map.set(line, cur);
  }
  return map;
}

function trackedSet() {
  try {
    return new Set(
      execSync(`${GIT} ls-files design`, { cwd: ROOT, encoding: "utf-8" })
        .split(/\r?\n/)
        .filter(Boolean)
        .map((p) => p.replace(/\\/g, "/")),
    );
  } catch {
    return new Set();
  }
}

const fmtSize = (bytes) => {
  const kb = bytes / 1024;
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
};

function subdirSummary() {
  const notes = {
    promo: "推广素材与视频工程（含 hyperframes 视频工具；仓外依赖多，多数文件未纳入 git）",
    "logo-options": "Logo 备选方案（有 index.html 汇总页）",
    "icon-options": "应用图标备选方案",
    installer: "NSIS 安装器品牌位图",
  };
  const rows = [];
  for (const d of fs.readdirSync(DESIGN, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    let files = 0;
    let bytes = 0;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) walk(fp);
        else {
          files++;
          bytes += fs.statSync(fp).size;
        }
      }
    };
    walk(path.join(DESIGN, d.name));
    rows.push({ name: d.name, files, size: fmtSize(bytes), note: notes[d.name] || "" });
  }
  return rows.sort((a, b) => b.files - a.files);
}

// ---------- main ----------
const addDates = collectAddDates();
const tracked = trackedSet();

const entries = fs
  .readdirSync(DESIGN)
  .filter((f) => f.endsWith(".html"))
  .map((f) => {
    const rel = `design/${f}`;
    const st = fs.statSync(path.join(DESIGN, f));
    return {
      file: f,
      topic: classify(f),
      date: addDates.get(rel) || "—",
      committed: tracked.has(rel),
      size: st.size,
    };
  });

const byTopic = new Map();
for (const e of entries) {
  if (!byTopic.has(e.topic)) byTopic.set(e.topic, []);
  byTopic.get(e.topic).push(e);
}

const today = new Date().toISOString().slice(0, 10);
const isRecent = (d) =>
  /^\d{4}-\d{2}-\d{2}$/.test(d) && (Date.now() - new Date(d).getTime()) / 86400000 <= 45;
const byDateDesc = (a, b) => (a.date < b.date ? 1 : -1);

const L = [];
L.push("# 设计稿索引（design/）");
L.push("");
L.push(
  `> 本文件由 \`scripts/gen-design-index.mjs\` 自动生成（最近生成：${today}）。**不要手改**——下次生成会覆盖。要调分组规则，改脚本里的 \`RULES\`。`,
);
L.push("");
L.push("## 这份目录是什么");
L.push("");
L.push("PastePanda 所有 UI 改动都走「**先出设计稿 → 用户确认 → 再写代码**」（`claude.md:12` 硬性规则）。");
L.push(
  "`design/` 就是这条流程的沉淀地：每份 HTML 都能直接在浏览器打开，基于真实组件而来，不是通用模板。",
);
L.push("");
L.push("**规范类文档不在这个目录**，在 `docs/`：");
L.push("");
L.push("| 文档 | 作用 |");
L.push("|---|---|");
L.push("| [`docs/PastePanda-UI规则.md`](../docs/PastePanda-UI%E8%A7%84%E5%88%99.md) | U1–U8 视觉与反馈规则，改 UI 前必读 |");
L.push("| [`docs/PastePanda-色彩规范.md`](../docs/PastePanda-%E8%89%B2%E5%BD%A9%E8%A7%84%E8%8C%83.md) | 色彩令牌与主题定义 |");
L.push("| [`docs/UI视觉升级-Token改动表.md`](../docs/UI%E8%A7%86%E8%A7%89%E5%8D%87%E7%BA%A7-Token%E6%94%B9%E5%8A%A8%E8%A1%A8.md) | Token 级改动清单 |");
L.push("| [`docs/结构设计规范.md`](../docs/%E7%BB%93%E6%9E%84%E8%AE%BE%E8%AE%A1%E8%A7%84%E8%8C%83.md) | 文件规模/职责红线、重构路径 |");
L.push("");
L.push("## 怎么用");
L.push("");
L.push("1. **动 UI 前**：先读上面的规范文档，再按主题在本目录找同区域的历史稿——避免推翻已经定过的方案。");
L.push("2. **出新稿**：放在 `design/` 根目录，文件名带主题关键词（如 `截图-遮罩工具重做-设计稿.html`），脚本会自动归类。");
L.push("3. **改完稿**：跑一次 `npm run gen:design-index` 刷新本索引。");
L.push("");
L.push("## 关于「状态标注」（为什么这里没有）");
L.push("");
L.push("本索引**不标「已落地 / 待实施 / 已废弃」**。试过用 CHANGELOG 反推，结论是推不出来：");
L.push("");
L.push(
  "把每份设计稿的标题关键词拿去 `CHANGELOG.md` 全文匹配，**293 份只命中 5 份**。CHANGELOG 写的是用户语言（「截图后可以继续标注」），",
);
L.push("设计稿写的是工程语言（「标注工具栏排序-方案A」），两者天然对不上。拿它当落地判据会大面积误判——宁可不标。");
L.push("");
L.push("所以这里只给两列**可机械验证**的事实：");
L.push("");
L.push("- **入库**：该文件在 git 中最早出现的日期（`--diff-filter=A`）。`—` 表示尚未提交（大概率是正在讨论的新稿）。");
L.push("- **体量**：文件大小，粗略指示详略程度。");
L.push("");
L.push(
  "「哪份是现行基线」目前只能靠人判断。**让这个索引变可靠的最省事办法**：维护者在定稿的稿子顶部加一行注释（如 `<!-- status: shipped v7.1.6 -->`），",
);
L.push("脚本就能自动收集——比事后猜可靠得多。");
L.push("");
L.push("## 目录结构");
L.push("");
L.push("| 子目录 | 文件数 | 体量 | 说明 |");
L.push("|---|---:|---:|---|");
for (const s of subdirSummary()) L.push(`| \`${s.name}/\` | ${s.files} | ${s.size} | ${s.note} |`);
L.push(`| \`*.html\`（根目录） | ${entries.length} | — | 设计稿正文，见下方按主题分组 |`);
L.push("");
L.push(`## 设计稿清单（${entries.length} 份，按主题分组）`);
L.push("");

for (const t of TOPICS) {
  const rows = byTopic.get(t.key) || [];
  if (!rows.length) continue;
  L.push(`### ${t.title}（${rows.length}）`);
  L.push("");
  L.push(`*${t.desc}*`);
  L.push("");
  L.push("| 设计稿 | 入库 | 体量 |");
  L.push("|---|---|---|");
  for (const e of rows.sort(byDateDesc)) {
    const name = e.file.replace(/\.html$/, "");
    L.push(`| [\`${name}\`](./${encodeURI(e.file)}) | ${e.date}${isRecent(e.date) ? " 近期" : ""} | ${fmtSize(e.size)} |`);
  }
  L.push("");
}

const misc = byTopic.get("misc") || [];
if (misc.length) {
  L.push(`### 未分类（${misc.length}）`);
  L.push("");
  L.push("*文件名没命中任何规则。给个更贴主题的文件名，或去脚本 `RULES` 里补一条。*");
  L.push("");
  L.push("| 设计稿 | 入库 | 体量 |");
  L.push("|---|---|---|");
  for (const e of misc.sort(byDateDesc)) {
    const name = e.file.replace(/\.html$/, "");
    L.push(`| [\`${name}\`](./${encodeURI(e.file)}) | ${e.date} | ${fmtSize(e.size)} |`);
  }
  L.push("");
}

L.push(`> 「近期」= 近 45 天内入库。其中尚未提交 git 的稿子共 ${entries.filter((e) => !e.committed).length} 份。`);
L.push("");
L.push("---");
L.push("");
L.push(`_共 ${entries.length} 份设计稿。重新生成：\`npm run gen:design-index\`_`);
L.push("");

fs.writeFileSync(OUT, L.join("\n"), "utf-8");

console.log(`已生成 ${path.relative(ROOT, OUT)}`);
console.log(`设计稿 ${entries.length} 份，其中未提交 ${entries.filter((e) => !e.committed).length} 份`);
for (const t of TOPICS) console.log(`  ${t.title}: ${(byTopic.get(t.key) || []).length}`);
console.log(`  未分类: ${misc.length}`);
