# 待办灵动岛材质与形变 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不牺牲圆角、文字可读性与点击穿透的前提下，让待办灵动岛具有连贯形变与单层受光玻璃质感。

**Architecture:** 先做与业务隔离的原生背景视觉探针，以明确 go/no-go；随后统一 Rust 舞台几何与速度连续性、React 内容时序，最后只在岛表面调整材质。原生路线失败时保留 CSS 四档，动效与内容改进独立交付。

**Tech Stack:** Tauri 2 / Rust / Windows Composition / WebView2 / React 19 / CSS Modules / Vitest。

**Spec:** `docs/superpowers/specs/2026-09-26-todo-island-liquid-glass-design.md`

## Global Constraints

- 保留五舞台尺寸：208×32、300×40、420×240、420×280、208×32；顶边距主屏 10px。
- 弹簧仅使用 k=130、c=16；颜色与透明度使用 UI 规则 U2 的四档时长和两条曲线。
- 单个 `.tsx` 组件不超过 300 行；共用纯工具在 `src/lib/utils.ts`。
- 常驻状态无无限动画或逐行玻璃层；窗口隐藏时停止新增工作。
- 不改版本号、不构建 exe、不覆盖现有未提交变更；新增 UI 以已确认的 HTML 稿为视觉依据。
- 原生探针 no-go 时使用现有 CSS 四档；不把已失败的“窗口 Acrylic + SetWindowRgn”直接重新上线。

## Review Focus

- 快速 `pill→peek→list→pill`：动画不能倒跳，旧延时不能覆盖新目标；Task 2、3 测试。
- 125%/150% DPI 和副屏存在时：岛、蒙版和可点范围仍以主屏中心和真实物理像素吻合；Task 1、2 实测。
- 白文档、深色应用、彩色壁纸：四角无方块，主/次文字可读；Task 1、4 实测。
- 勾选失败或输入失败恰逢收起：提示仍在触发动作的可见域，数据可回滚；Task 3、4 测试。
- 系统降低透明度或减少动态效果：显示可读实色和无过冲反馈；Task 1、2、4 测试。

---

### Task 1: 原生材质可行性探针

**Files:**
- Create: `src-tauri/src/todo_island_native_probe.rs`（临时、仅探针环境启用）
- Modify: `src-tauri/src/lib.rs`（仅探针模块接线）
- Reuse: `src-tauri/src/todo_island_probe.rs` 的截图与组内噪声判据

**Interfaces:** 探针读取已有 `PP_TODO_ISLAND_PROBE=1` 开关；不改变正式岛的材质路径。输出两种形态的角点像素、背景运动前后岛内差值、是否阻断点击以及当前系统版本。任何新 Windows API 必须先核对 build 22000 支持。

- [ ] 记录现状基线：透明窗 + CSS 档的角点、动态背景、内存与点击结果。
- [ ] 建立最小独立原生背景视觉/宿主，仅在探针模式下显示胶囊和卡片；先用高饱和 tint 查漏角，再接实时背景采样。
- [ ] 运行实机 A/B，记录两形态的圆角外像素、窗后运动模糊、焦点和穿透；满足 spec 全部条件才标 go。
- [ ] 若 no-go，移除不可交付的实验代码并记录证据；若 go，添加清理、隐藏和禁用透明效果的回退，再接正式岛。不要让探针代码进入常驻路径。

### Task 2: 几何与速度连续的舞台动画

**Files:**
- Create: `src-tauri/src/todo_island_stage/motion.rs`（纯运动状态与测试）
- Modify: `src-tauri/src/todo_island_stage.rs`（登记子模块、调用运动状态、统一几何）

**Interfaces:** `SpringMotion` 持有当前宽/高与对应速度；`retarget(width,height)` 保留速度；`advance(dt)` 返回下一帧尺寸。`todo_island_stage` 仍是前端唯一的舞台尺寸入口。

- [ ] 先写失败单测：目标中途反向后首帧位置连续且速度未归零；落定误差和减少动态效果回退满足规范。
- [ ] 运行 `cargo test todo_island_motion` 确认预期失败。
- [ ] 实现最小运动状态，并让窗口尺寸、水平位置和裁剪使用同一帧几何；新目标作废旧线程。
- [ ] 运行单测与现有 `todo_island_stage` 测试；实机检查 100%、125%、150% DPI 及快速反向操作。

### Task 3: 内容进入/退出时序

**Files:**
- Create: `src/components/todo/useIslandContentPhase.ts`（内容可见性与延时的单一控制）
- Test: `src/components/todo/useIslandContentPhase.test.tsx`
- Modify: `src/components/todo/TodoIsland.tsx`
- Modify: `src/components/todo/TodoIslandList.tsx`（仅为折叠竞态上报失败提示）
- Modify: `src/components/todo/TodoIsland.module.css`

**Interfaces:** Hook 消费 `stage` 和减少动态效果状态，返回折叠层/列表层是否挂载、是否可交互；对每次目标变化作废旧延时。输入草稿仍由 `TodoIsland` 持有。

- [ ] 先写失败测试：展开内容延后进入，收起后列表延后卸载，快速反向不会由旧计时器改错状态，减少动态效果直接切换。
- [ ] 运行 `npx vitest run src/components/todo/useIslandContentPhase.test.tsx` 确认预期失败。
- [ ] 实现 Hook 与双层内容时序；保持展开期间失败提示可见、Esc 两级取消和草稿保留。
- [ ] 运行 Hook 与现有 `TodoIsland.test.tsx`；手测 `pill→peek→list→compose→list→pill`。

### Task 4: 单层玻璃与细节反馈

**Files:**
- Modify: `src/components/todo/TodoIsland.module.css`
- Modify: `src/components/todo/TodoIsland.tsx`
- Modify: `src/components/todo/TodoIslandList.tsx`
- Test: `src/components/todo/TodoIsland.test.tsx`

**Interfaces:** 根层唯一材质；`peek` 的到期信息来自真实 `IslandTask`，没有则隐藏；提醒态只显示提醒文案。勾选保留原有乐观写回与失败回滚。

- [ ] 先写失败测试：peek 不显示虚构时间、提醒不拼接第二条文本、勾选成功/失败反馈按既有语义保留。
- [ ] 运行目标 Vitest 确认失败来自新增断言。
- [ ] 按已确认 HTML 稿精修斜向弱高光、内侧暗边和双层投影；只在交互时点亮，不加常驻动画。完成圈先反馈，再延时移走条目。
- [ ] 运行目标 Vitest 与 `npm run lint:ui`；依 `docs/PastePanda-UI规则.md` §9 手审 U/L/V 未自动判定条款。

### Task 5: 合并验证与代码审查

**Files:** 仅更新与本任务直接相关的 spec/计划/探针结论，不扩展待办存储或设置页。

- [ ] 运行 `npx tsc --noEmit`、`npm test`、`npm run lint:ui` 与 `cargo test`（新终端先设 `LIBCLANG_PATH`）。
- [ ] 使用 `npm run tauri dev` 实机验证材质 go/no-go、角点、鼠标穿透、DPI、降低透明度与减少动态效果；已有 dev 时复用，不重复启动。
- [ ] 请求独立代码审查，核对范围、性能、错误态与未提交用户改动；修复本任务发现的问题后重跑相关检查。
- [ ] 汇总原生探针证据、最终材质路径、动效体验与限制；不升级版本号、不构建 exe。

## Self-review

- 每个范围要求都有对应 Task：材质/回退在 1，几何在 2，内容在 3，视觉和反馈在 4，实机与全量测试在 5。
- Task 1 是明确 go/no-go 的可行性工作，正式实现只在 go 后发生；no-go 仍交付 Task 2–4。
- 本计划不要求提交当前脏工作树，避免把用户的其他未提交文件混入提交。
