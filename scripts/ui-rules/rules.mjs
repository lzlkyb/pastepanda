/**
 * UI 规则校验的判据表。
 *
 * 🔴 单一数据源是 `docs/PastePanda-UI规则.md`——本文件只是它的「机器可判定子集」。
 * 改判据**先改那份文档**，再回来改这里；两份对不上时以文档为准。
 *
 * 每条都对应文档里一个写死的「判定：…→ 违反」句。写不出判定条件的不进本表
 * （U1 反馈时序、U3 四状态齐全、U4 撤销语义、L1/L4/L5、V4/V5 这些靠人看，
 * 由 check-ui-rules.mjs 末尾的「需人工确认」清单兜住）。
 */

// ── U2 · 四档时长（ms）。2026-09-09 修订：快档 100 → 150 ──────────────
export const DURATIONS = [150, 200, 300, 400];

/** U2 的曲线只两条（M3 官方值） */
export const EASINGS = ["cubic-bezier(0.2, 0, 0, 1)", "cubic-bezier(0.05, 0.7, 0.1, 1)"];

// ── U5 · 三张表，只许用表里的值 ────────────────────────────────────
export const RADII = [0, 4, 8, 12];
export const FONT_SIZES = [11, 12, 13, 15, 20];
export const SPACINGS = [4, 8, 12, 16, 24];

/** 胶囊/圆形是几何需要，不是尺度取值，单独放行 */
export const RADIUS_GEOMETRY = ["50%", "100%", "999px", "9999px", "999em"];

/**
 * U6 · 色名变量黑名单。
 *
 * theme.css 里两套并行：`--green` 与 `--success`、`--orange` 与 `--warning`、
 * `--red-bg` 与 `--danger-bg`。色名描述「是什么颜色」，语义名描述「表示什么」——
 * 只有后者能跟着主题走、也才能在换主题时不把「警告」变成「装饰」。
 *
 * 2026-09-22 实测使用频次：`--green` 171、`--orange` 139、`--red-bg` 48、
 * `--green-bg` 42、`--orange-border` 38、`--orange-bg` 38、`--green-border` 32、
 * `--red-border` 18——存量不改（文档 §10 不搞大扫除），只拦新写的。
 */
export const COLOR_NAME_VARS =
  /^--(red|green|blue|orange|yellow|purple|pink|cyan|teal|indigo|violet|amber|lime)(-[\w-]+)?$/;

/** 灰阶文字变量：彩底上用它们做次要文字 = V6 违反 */
export const GRAY_TEXT_TOKENS = [
  "--text-muted",
  "--text-secondary",
  "--text-tertiary",
  "--text-quaternary",
];

/**
 * V3 的整文件豁免：这些文件里的颜色**是内容，不是样式决策**。
 * 逐条给理由，不写「历史遗留」——说不清理由的就不该在这里。
 */
export const RAW_COLOR_FILES = [
  ["src/lib/source-mappings.ts", "来源元数据表：每个来源应用一个色点是数据，走 token 反而要建 400 个一次性变量"],
  ["src/styles/code-theme.css", "代码高亮主题：token 配色需与上游 hljs/Shiki 主题逐色对齐，是移植结果不是自选色"],
];

/** 视为「彩色底」的变量前缀（V6 用） */
export const COLORED_BG_PREFIXES = [
  "--accent",
  "--danger",
  "--success",
  "--warning",
  "--card-selected",
  "--brand",
  "--hero",
  "--version-badge",
  "--distill",
  "--ic-",
  "--kb-",
  "--shot-",
  "--seg-active",
  "--toggle-on",
];

/**
 * V8.2 · 字体黑名单。
 *
 * 来源：baoyu-design「overused font families (Inter, Roboto, Arial, Fraunces)」——
 * 这四个是生成式设计在缺约束时的默认字体，也就是「生成味」的探针之一。
 *
 * 2026-09-25 实测全库 **0 处**。本项目走系统字体栈（`inherit` + `SF Mono`/`Consolas`），
 * 这是桌面对齐原生观感的前提，所以本条是**防回归的预防性判据**，成本为零。
 * ⚠️ `\b` 保证了 `font-family: inherit` 不会被 `Inter` 误匹配（实测无假警报）。
 */
export const FONT_BLACKLIST = /\b(Inter|Roboto|Arial|Fraunces)\b/i;

/**
 * V8.1 · 左侧色条的最小宽度（px）。
 * 1px 是普通分隔线（V1 管的那类），≥2px 才是 baoyu 点名的「accent bar」。
 */
export const LEFT_BAR_MIN_PX = 2;

/**
 * V8.1 的语义豁免：这些选择器上的「圆角 + 左侧色条」是约定俗成的表达，不是装饰。
 * 逐条给理由——说不清理由的不该在这里（同 RAW_COLOR_FILES 的纪律）。
 *
 * 🔴 判据必须贴着 baoyu 原文「containers with **rounded corners** and left-border
 * accent color」：左侧一旦是直角（`border-radius: 0 8px 8px 0`），色条就从
 * 「AI 味装饰」变成「引用/警示的正确写法」——那一类由下面的「左直角」条件放行，
 * 不靠这张表。
 */
export const LEFT_BAR_SEMANTIC = [
  [/blockquote/i, "Markdown 引用块的通用表达（GitHub 与各渲染器一致）"],
  [
    /\b(note|warn|warning|alert|callout|tip|danger)/i,
    "警示/提示条：左侧色条是这类组件的行业惯例",
  ],
];

/**
 * 豁免注释。写法必须带理由，理由太短不算数——
 * 文档的判定句是「说不出理由 → 违反」，所以「说不出理由」这件事本身必须被机器拦下，
 * 否则一条 `/* ui-rule-ok *​/` 就能把整个文件洗白。
 *
 *   border-radius: 6px; /* ui-rule-ok: 内层圆角 = 外层 12 − padding 6，见 V4 *​/
 */
export const ALLOW_MARK = "ui-rule-ok";
const ALLOW_RE = new RegExp(`${ALLOW_MARK}\\s*[:：]\\s*(\\S.{3,})`);
const ALLOW_BARE_RE = new RegExp(ALLOW_MARK);

/**
 * 取某一行（1-based）的豁免状态。看本行 + 上一行（行尾注释与上一行块注释两种写法）。
 * @returns {{state:"none"|"ok"|"bare", reason?:string}}
 */
export function allowAt(lines, line) {
  for (const n of [line, line - 1]) {
    const text = lines[n - 1];
    if (typeof text !== "string" || !ALLOW_BARE_RE.test(text)) continue;
    const m = ALLOW_RE.exec(text);
    if (m) return { state: "ok", reason: m[1].trim() };
    return { state: "bare" };
  }
  return { state: "none" };
}

/**
 * 规则元数据。
 *  tier: "block" → 计入退出码；"warn" → 只提示（存量重、或判定含启发式的）
 */
export const RULES = {
  U2: {
    tier: "block",
    title: "动效时长不在四档里",
    why: "150/200/300/400ms 之外的时长每多一种，界面节奏就多一种。实测改前有 18 种 transition 时长。",
    fix: "归到四档之一；要更快的纯颜色反馈也写 150ms（没人看得出来，但库少一种）。",
  },
  U2ease: {
    tier: "warn",
    title: "缓动曲线不在两条里",
    why: "曲线只两条：常规 cubic-bezier(0.2,0,0,1)、进入视野（减速）cubic-bezier(0.05,0.7,0.1,1)。",
    fix: "换成两条之一；无把握就用常规那条。",
  },
  U2spring: {
    tier: "warn",
    title: "CSS 裸写 linear() 弹簧曲线（2026-09-25 U2 修订新增）",
    why: "弹簧只许一组定参（k=130/c=16，文档 U2 §弹簧）——CSS 侧必须经单一令牌 --ease-spring，裸写 linear(...) 的自定义弹簧会让曲线数失控。",
    fix: "用 var(--ease-spring)（首次需要时在 globals.css 按文档参数定义），且只用在位移/尺寸属性上——opacity/color 禁弹簧。",
  },
  U2token: {
    tier: "warn",
    title: "动效 token 的值不在四档里",
    why: "token 是扩散源——它错一次，所有引用它的地方一起错。",
    fix: "改 token 定义本身（如 --dur-fast: 100ms → 150ms）。",
  },
  U5radius: {
    tier: "block",
    title: "圆角不在 4/8/12",
    why: "改前有 39 种 border-radius 取值（8px 240、6px 171、10px 120…）。",
    fix: "归到 4/8/12；胶囊用 999px、圆形用 50%。",
  },
  U5font: {
    tier: "block",
    title: "字号不在 11/12/13/15/20",
    why: "字号每多一档，一屏里就多一层本不存在的层级暗示。",
    fix: "归到五档之一。11px 只给 meta（计数、时间戳），说明文字用 12/13。",
  },
  U5space: {
    tier: "warn",
    title: "间距不在 4/8/12/16/24",
    why: "间距是节拍；不是倍数的值会让相邻区块的呼吸对不齐。",
    fix: "归到五档，或写清为什么这里必须是这个值。",
  },
  U6: {
    tier: "block",
    title: "用了色名变量",
    why: "两套并行（--green/--success、--orange/--warning、--red-bg/--danger-bg）会让换主题时语义漂移。",
    fix: "换语义名：--danger / --warning / --success / --accent / --text-muted。",
  },
  V2: {
    tier: "block",
    title: "阴影不是 token",
    why: "改前 283 个 box-shadow 声明写成了 191 种不同取值——等于没有高度尺度。",
    fix: "用 var(--shadow-*) / var(--float-card-shadow) / var(--glass-*-shadow) 等已有 token。",
  },
  V3: {
    tier: "block",
    title: "硬编码颜色",
    why: "改前 1953 处 hex、395 种颜色。这一项已经不是「不够高级」，是没有设计系统。",
    fix: "颜色只来自变量（token 定义处除外，即 `--x: #fff` 这类自定义属性声明）。",
  },
  V3rgb: {
    tier: "warn",
    title: "硬编码 rgb()/hsl() 颜色",
    why: "与硬编码 hex 同类，只是写法不同；透明度常被当成「不用建 token」的理由。",
    fix: "需要透明度就建一个带 alpha 的 token，或改用 color-mix(var(--x) …)。",
  },
  V6: {
    tier: "block",
    title: "彩色底上用灰色次要文字",
    why: "在彩色背景上把文字调灰，结果是「脏」而不是「次要」——业余感最常见的单一来源。",
    fix: "取同一色相、降饱和或改亮度（如 var(--accent-strong) 而不是 var(--text-muted)）。",
  },
  V8leftbar: {
    tier: "warn",
    title: "四角圆角 + 左侧色条（生成味特征）",
    why:
      "「圆角容器 + 左边一条彩线」是生成式设计在无约束时的默认产出，是这个味道最好认的探针。" +
      "2026-09-25 全库基线：8 处全部是引用块/警示条（已豁免），真反模式 0 处——本条拦的是以后新加的。",
    fix:
      "要么四角改直角（色条贴直边，如 border-radius: 0 8px 8px 0），要么去掉左侧色条（回到 V1 的 ①间距 → ②背景色）；" +
      "语义上确实是引用块/警示条，就让选择器体现出来（blockquote / note / warn / alert…）。",
  },
  V8font: {
    tier: "block",
    title: "字体黑名单（Inter / Roboto / Arial / Fraunces）",
    why:
      "这四个是生成式设计的默认字体。本项目走系统字体栈（inherit + SF Mono/Consolas），" +
      "这是桌面对齐原生观感的前提；换 Web 字体在中文环境下只能回落到系统字，平白多一层不一致。2026-09-25 实测全库 0 处。",
    fix: "删掉这一项让字重继承（font-family: inherit）；等宽场景写成 SF Mono / Consolas 那一组。",
  },
  U8: {
    tier: "warn",
    title: "内联 style={{}}",
    why: "内联 style 拿不到伪类/媒体查询/主题覆盖，是 U2/U6/U7 集体失效的根因（改前 133 个组件）。",
    fix: "搬到 CSS Module。已有的不强制迁移，碰到就顺手改。",
  },
  U3_5: {
    tier: "warn",
    title: "catch 只记日志（会落到空态）",
    why: "把「查询失败」渲染成「查询结果为空」，是两件相反的事共用同一屏；空态文案写得越好骗得越彻底。",
    fix: "多一个状态，不是多一句 toast：{loadError ? <错误条 onRetry/> : …}。",
  },
  L2: {
    tier: "warn",
    title: "图标按钮只有 title，没有常驻文字",
    why: "图标标签应始终可见、无需交互；hover 才出现的文字在触屏上根本不生效。",
    fix: "挂常驻文字；只有全球公认的 ×/🔍/⚙/←→ 例外。悬停才出现的行内操作走例外二三条。",
  },
  L3: {
    tier: "block",
    title: "空态只写了「暂无…」",
    why: "空态必须回答「会出现什么 / 怎么让它出现」。只写「暂无数据」= 把教学位浪费掉。",
    fix: "给可执行的下一步（新建/清筛选/导入）；答不出第二步就别用空态教学，改走 L4。",
  },
  V1: {
    tier: "info",
    title: "新增边框",
    why: "层级手段的优先级是 ①间距 → ②背景色 → ③边框。改前 803 处 1px solid，说明边框被当成了第一手。",
    fix: "先问间距和背景色为什么不行——说不出理由就换掉。这是计数型的提醒，不逐行报错。",
  },
  SYNTAX: {
    tier: "block",
    title: "CSS 解析失败（整份文件未被检查）",
    why: "解析失败 = 这个文件后面所有规则都没跑到。浏览器会静默容忍多余的 `}` 和规则外的声明，" +
      "所以它不会在界面上表现成错误——只会让整份样式表的一部分悄悄失效。",
    fix: "多半是多余的 `}` 或跑出规则块的声明。2026-09-22 在 src/styles/popup.css:363 实测到一处。",
  },
};

/**
 * 机器判不了的，交给这 14 条人工过（都是文档 §9 自查清单里剩下的）。
 * 校验器每次跑完都把它们打出来——「查得到的机器查，查不到的别忘了」。
 */
export const MANUAL_CHECKLIST = [
  ["U1", "超过 1 秒的操作，界面有变化吗？"],
  ["U2", "新写的位移/缩放动效承载了信息的话，给了静态替代吗？（PRM 有全局兜底，不必逐文件补 @media）"],
  ["U3", "空 / 加载 / 错误 / **部分成功** 四个分支都在吗？"],
  ["U4", "能撤销的是不是不该弹确认？撤销条 6 秒自动消失、hover 暂停了吗？"],
  ["U7", "点击目标 ≥ 24×24？可聚焦元素有 :focus-visible 吗？状态不只靠颜色？"],
  ["L1", "新文案里有产品黑话吗？有的话在首次出现处就地解释了吗？"],
  ["L2", "悬停才出现的行内操作：图标与别处同一动作一致？有带文字的路径？本应用内不一词多义？"],
  ["L4", "新功能能靠就地一句话说清吗，还是得靠弹窗/文档？"],
  ["L5", "完成当前一步需要记住别处的信息（路径/名字/上一步选了什么）吗？"],
  ["L6", "能点的看得出能点、点不动的没长得像能点吗？"],
  ["V4", "嵌套容器内圆角 = 外圆角 − padding 吗？（结果 ≤ 0 就用直角）"],
  ["V5", "🔴 去色测试：截图转灰度后层级还看得出来吗？"],
  ["V7", "🔴 删元素测试：这块里有没有「删掉后信息量不变」的元素（假数字 / 无目标链接）？"],
  ["—", "🔴 黑话测试：把截图给没用过的人，他能不能逐块说出「这是干吗的」？"],
];
