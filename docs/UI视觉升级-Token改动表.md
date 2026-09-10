# PastePanda UI 视觉升级 · Token 改动表（主题兼容）

> 2026-09-09 · 配套设计稿：
> - `design/2026-主窗口视觉升级-对照稿.html`
> - `design/2026-知识库视觉升级-对照稿.html`
>
> 目标：环境光 + 表面厚度。不换布局、不给列表卡片加 `backdrop-filter`（规则 8.3）。

---

## 0. 主题现状（决定「改多少」）

| 主题 | 类型 | `--app-bg` | 卡片 | 已有氛围？ | 本轮力度 |
|------|------|------------|------|------------|----------|
| **ocean**（默认） | 浅色·无场景 | 纯色 `#F7F7F8` | 不透明白 `#FFFFFF` | ❌ 死白 | **主改** |
| forest | 浅色·纸感场景 | 暖纸渐变 + SkinScene | 半透 22% | ✅ | 轻改（阴影/选中） |
| blossom | 浅色·糖果场景 | 粉渐变 + SkinScene | 半透 22% | ✅ | 轻改 |
| dawn | 浅色·晨光场景 | 暖光渐变 + SkinScene | 半透 22% | ✅ | 轻改 |
| midnight | 深色·星夜场景 | 深底 + SkinScene | 半透 22% | ✅ | 轻改 |
| ocean-dark | 深色·海面场景 | 蓝径向渐变 + SkinScene | 半透 22% | ✅ | 轻改 |

**结论：** 五套场景主题已有「空气」，硬加第二层渐变会脏。  
**Ocean 是唯一缺环境的**——本轮视觉收益最大；其它主题只吃「阴影厚度 / 选中柔光环」。

---

## 1. 新增 Token（`:root` 一次声明 + 各主题可覆写）

所有新 token **带 fallback**。组件一律写 `var(--xxx, 旧值)`，主题没覆写时行为不变 → 可分 PR 上线。

### 1.1 壳层（侧栏 / 顶栏容器，**不是**列表项）

| Token | 用途 | `:root` 默认（六主题通用） | Ocean 覆写建议 | 深色覆写建议 |
|-------|------|---------------------------|----------------|--------------|
| `--shell-bg` | 侧栏/顶栏壳底 | `color-mix(in srgb, var(--card-bg) 72%, transparent)` | `rgba(244,247,251,0.72)` | `color-mix(in srgb, var(--card-bg) 78%, transparent)` |
| `--shell-border` | 壳描边 | `color-mix(in srgb, var(--card-bg) 85%, transparent)` | `rgba(255,255,255,0.85)` | `color-mix(in srgb, var(--card-bg) 90%, transparent)` |
| `--shell-blur` | 壳模糊 | `blur(16px) saturate(1.2)` | 同左 | `blur(18px) saturate(1.25)` |
| `--shell-top-fade` | 顶栏渐变盖 | `linear-gradient(180deg, color-mix(in srgb, var(--card-bg) 70%, transparent) 0%, transparent 100%)` | 白系 | 深色系 |

**硬约束：** blur **只**挂在 `.sidebar` 与顶栏 header **各一个容器**。禁止下放到行/卡。

### 1.2 卡片阴影（记录卡 + 知识笔记行共用）

| Token | 用途 | `:root` 默认 | Ocean 覆写 | 深色覆写 |
|-------|------|--------------|------------|----------|
| `--glass-card-shadow` | **改现有** | 见分表 | 三段浅影（见 §2） | 微调即可 |
| `--glass-card-elev` | 新：近+中影 | `0 1px 2px rgba(15,23,42,.04), 0 6px 16px rgba(15,23,42,.07)` | 同左 | `0 1px 2px rgba(0,0,0,.25), 0 8px 24px rgba(0,0,0,.35)` |
| `--card-top-light` | 新：顶部微光层 | `linear-gradient(180deg, rgba(255,255,255,.55) 0%, transparent 45%)` | 同左 | `linear-gradient(180deg, rgba(255,255,255,.08) 0%, transparent 45%)` |
| `--card-selected-glow` | 新：选中柔环 | `color-mix(in srgb, var(--accent) 16%, transparent)` | 同左 | `color-mix(in srgb, var(--accent) 22%, transparent)` |

**消费方：** `CardList.module.css` `.card` / `KnowledgeView.module.css` `.row`。  
**仍禁止：** `backdrop-filter` 非 `none`（各主题 `--glass-card-filter` 保持 `none`）。

### 1.3 控件微光（搜索 / 筛选 / 页签 / 工具钮）

| Token | 用途 | `:root` 默认 | 说明 |
|-------|------|--------------|------|
| `--control-glass` | 次级控件底 | `color-mix(in srgb, var(--card-bg) 72%, transparent)` | 搜索框、筛选下拉 |
| `--control-ring` | 激活柔环 | `inset 0 0 0 1px color-mix(in srgb, var(--accent) 20%, transparent), 0 1px 4px color-mix(in srgb, var(--accent) 12%, transparent)` | 工具钮 on / 列表视图 on |
| `--seg-on-gradient` | 页签/模式激活实底 | `linear-gradient(180deg, var(--accent) 0%, var(--accent-solid) 100%)` | 仍配 `color:#fff` |

**消费方：** `TopBar` search/seg、`KnowledgeView` searchBox/modeSeg、`ViewControls` iconOn。  
**ModeSwitcher** 继续用 `--accent-solid` 实底（透明顶栏下正确），只把圆角/投影接到 `--control-ring` 同源描述。

### 1.4 氛围底（仅 Ocean 需要写死；其余主题已有场景）

| Token | Ocean 覆写 | 其它主题 |
|-------|------------|----------|
| `--app-bg` | **改现有**为多层静态渐变（见 §2.1） | **不动**（已是渐变/场景） |

不新增 `--ambient-*`：避免组件再绑一层「氛围」概念。`--app-bg` 本身就是唯一底。

---

## 2. 分主题改值表

### 2.1 `--app-bg`

| 主题 | 现值 | 改后 | 备注 |
|------|------|------|------|
| **ocean** | `#F7F7F8` | `radial-gradient(ellipse 900px 420px at 18% -10%, rgba(2,132,199,.14), transparent 55%), radial-gradient(ellipse 700px 380px at 88% 0%, rgba(109,40,217,.08), transparent 50%), linear-gradient(168deg, #F4F8FC 0%, #EEF3F8 42%, #E8F0F7 100%)` | 静态、可缓存；青/微紫呼应 accent |
| forest | 纸感渐变 | **不变** | 已有 SkinScene |
| blossom | 粉渐变 | **不变** | 同上 |
| dawn | 暖光渐变 | **不变** | 同上 |
| midnight | 深底+场景 | **不变** | 同上 |
| ocean-dark | 蓝径向+场景 | **不变** | 同上 |

### 2.2 `--glass-card-shadow`（及 hover）

| 主题 | 现值摘要 | 改后建议 |
|------|----------|----------|
| **ocean** | `0 1px 3px … + ring 1px` | `0 1px 2px rgba(15,23,42,.04), 0 6px 16px rgba(15,23,42,.07), 0 0 0 1px rgba(15,23,42,.04)` |
| forest / blossom / dawn | 半透 + inset 高光 + 浅影 | 保留 inset；中影提到 `0 6px 18px rgba(0,0,0,.08)` |
| midnight / ocean-dark | 已有 `0 4px 16px` 深影 | 微调为 `0 2px 6px` 近影 + 保留中影，避免「浮得太远」 |

Hover 阴影同样按「近影 + accent 柔环」两段，不再堆三层硬描边。

### 2.3 `--sidebar-bg`

| 主题 | 现值 | 改后 |
|------|------|------|
| **ocean** | `#EFF1F5` 实色 | `var(--shell-bg)` + 容器上 `backdrop-filter: var(--shell-blur)` |
| 场景主题 | 已半透或实色压场景 | 改为 `var(--shell-bg)`，**避免双层磨砂**（侧栏若已是半透则 filter 保持 none，只统一 token） |

侧栏 `backdrop-filter`：**仅 ocean 打开**；场景主题默认 `--shell-blur: none` 以免与 SkinScene 叠出 GPU 乘法。

### 2.4 `--card-selected-*`（选中柔光环）

| 主题 | 现值 | 改后 |
|------|------|------|
| 全部 | 浅底 + 2px 硬环 | 底可用现值或 `linear-gradient` 白→accent-light；环改为 `0 0 0 3px var(--card-selected-glow)` + 淡投影 `0 8px 24px color-mix(in srgb, var(--accent) 16%, transparent)` |
| ocean 示例 | bg `#E0F2FE` border `#0284C7` | bg `linear-gradient(180deg,#FFF,#F0F9FF)`；border `color-mix(in srgb, var(--accent) 35%, transparent)`；shadow 见上 |
| midnight 示例 | bg `#1E1B4B` | 可保持；只把 2px 硬环换 3px 柔环 |

---

## 3. 组件消费改动（不改逻辑）

| 文件 | 选择器 | 改什么 | 不改什么 |
|------|--------|--------|----------|
| `styles/theme.css` | 各主题块 | §2 的值 + `:root` 新 token | 语义色、对比度已校的 accent 档 |
| `App.module.css` / 布局 | `.appShell` | `background: var(--app-bg)` 已有，无需改 | flex 结构 |
| `Sidebar.module.css` | `.sidebar` | ocean：`background: var(--shell-bg)` + `backdrop-filter: var(--shell-blur, none)` | 宽度 180、item 几何 |
| `TopBar.module.css` | `.header` | 渐变壳 `var(--shell-top-fade)`（可选） | 拖动区、图标钮几何 |
| `CardList.module.css` | `.card` / `.selected` | shadow / selected 走新 token；`::before` 用 `--card-top-light` | h72 / r16 / gap10；filter none |
| `KnowledgeView.module.css` | `.row` / `.rowActive` | 与卡片同一套 shadow/selected | r16 / gap10 / 无 filter |
| `KnowledgeView.module.css` | `.searchBox` | `background: var(--control-glass, …)` | 搜/问结构 |
| `ViewControls.module.css` | `.iconOn` | `box-shadow: var(--control-ring)` | 28px、常驻标签 L2 |
| `ModeSwitcher.module.css` | `.indicator` | 仍 `--accent-solid`；可选渐变 `--seg-on-gradient` | 实底白字策略 |
| `KbInboxPanel.module.css` | `.banner` | 微光边/渐变（可选 P3） | `--distill` 身份色、文案 |

---

## 4. 主题兼容策略（落地规则）

1. **先 `:root` 后覆写**  
   新 token 写在 `:root`，用 `var(--accent)` / `var(--card-bg)` 推导 → 未覆写主题自动跟 accent。

2. **组件侧永远带 fallback**  
   `box-shadow: var(--glass-card-elev, var(--glass-card-shadow));`  
   这样 P1 只改 ocean 也能合入，其它主题零回归。

3. **深浅两档，不是六套手调**  
   - 浅色：近影用 `rgba(15,23,42,…)`  
   - 深色：近影用 `rgba(0,0,0,…)` + 白 inset 微光  
   forest/blossom/dawn 归浅色档；midnight/ocean-dark 归深色档。

4. **场景主题禁用第二层壳 blur**  
   `--shell-blur`：ocean = `blur(16px)…`；**其余五套 = `none`**。  
   原因：SkinScene 动画 × 侧栏采样 = 乘法开销（规则 8.2/8.3）。

5. **对比度不回退**  
   选中态文字仍用 `--accent-strong`；实底白字仍用 `--accent-solid` / `--seg-on-gradient` 终点色。  
   改完须抽查：ocean / blossom / midnight 三套的选中项与页签。

6. **`--card-shimmer-*` 策略不变**  
   ocean 继续 `display:none` / `anim:none`（白卡上看不见）。  
   场景主题可继续用现有 shimmer；本轮不恢复 ocean 的扫光。

---

## 5. 落地切片（可独立合并）

| PR | 范围 | 验收 | 回滚 |
|----|------|------|------|
| **P1** | `:root` 新 token + **仅 ocean** `--app-bg` / shadow / selected | ocean 主窗+知识库截图对比；五套场景主题 diff 为空或仅 shadow 微调 | 还原 ocean 三变量即可 |
| **P2** | 侧栏/顶栏 `--shell-*`；ocean 开 blur，其余 `none` | 四窗口一致；列表滚动无掉帧（目测 + 性能面板） | shell-blur → none |
| **P3** | 控件 `--control-glass/ring`；ViewControls/搜索/页签 | 激活态可辨、L2 标签仍在、对比度抽查 | 回退控件 CSS |
| **P4** | 知识库 banner 微光（可选） | 蒸馏紫身份不变；distill-on-tint 仍 ≥4.5:1 | 去掉 banner 渐变 |

**版本号：** 不自动递增（规则 2）；是否升版由你拍板。

---

## 6. 明确不做

| 项 | 原因 |
|----|------|
| 列表卡片 `backdrop-filter` | 规则 8.3；ocean 已付过 GPU 学费 |
| 全站 Bento 概览条 | 你已否掉；占首屏高度 |
| 侧栏底部 AI 门控 | 你已否掉；顶栏已有状态 |
| 换 Neobrutalism / 大改导航 | 与信息架构、可学性冲突 |
| 六主题逐套手调氛围渐变 | 场景主题已有；手调会脏且难维护 |
| 恢复 ocean 卡片扫光 | 白底不可见，白付合成层 |

---

## 7. 验收清单（合并前）

- [ ] 6 主题切换：无布局跳动、无空白卡、无「半套新半套旧」
- [ ] ocean：主窗 + 知识库 vs 设计稿，观感方向一致
- [ ] forest/blossom/dawn/midnight/ocean-dark：与改前对比，**仅**阴影/选中可感知差异
- [ ] 无任何卡片层 `backdrop-filter ≠ none`
- [ ] 侧栏 blur 仅 ocean；开启后滚动列表不卡
- [ ] 选中项 / 激活页签文字对比度 ≥4.5:1（ocean、blossom、midnight）
- [ ] `prefers-reduced-motion`：无新增必须动画（阴影/渐变本身不是动画）
- [ ] 四窗口（主窗/托盘/快捷/全屏）同一主题下壳层表现一致

---

## 8. 建议实现顺序

```
P1 ocean token + app-bg/shadow/selected
    → 截图对照设计稿
P2 shell（侧栏/顶栏）
    → 四窗口 + 滚动性能
P3 控件微光
    → 对比度抽查
P4（可选）知识库 banner
    → distill 复查
```

确认 P1 取值后，我可以直接改 `theme.css` ocean 块 + `:root` 新 token，并附 ocean 改前/改后截图清单。
