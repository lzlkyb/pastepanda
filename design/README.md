# 设计稿索引（design/）

> 本文件由 `scripts/gen-design-index.mjs` 自动生成（最近生成：2026-09-19）。**不要手改**——下次生成会覆盖。要调分组规则，改脚本里的 `RULES`。

## 这份目录是什么

PastePanda 所有 UI 改动都走「**先出设计稿 → 用户确认 → 再写代码**」（`claude.md:12` 硬性规则）。
`design/` 就是这条流程的沉淀地：每份 HTML 都能直接在浏览器打开，基于真实组件而来，不是通用模板。

**规范类文档不在这个目录**，在 `docs/`：

| 文档 | 作用 |
|---|---|
| [`docs/PastePanda-UI规则.md`](../docs/PastePanda-UI%E8%A7%84%E5%88%99.md) | U1–U8 视觉与反馈规则，改 UI 前必读 |
| [`docs/PastePanda-色彩规范.md`](../docs/PastePanda-%E8%89%B2%E5%BD%A9%E8%A7%84%E8%8C%83.md) | 色彩令牌与主题定义 |
| [`docs/UI视觉升级-Token改动表.md`](../docs/UI%E8%A7%86%E8%A7%89%E5%8D%87%E7%BA%A7-Token%E6%94%B9%E5%8A%A8%E8%A1%A8.md) | Token 级改动清单 |
| [`docs/结构设计规范.md`](../docs/%E7%BB%93%E6%9E%84%E8%AE%BE%E8%AE%A1%E8%A7%84%E8%8C%83.md) | 文件规模/职责红线、重构路径 |

## 怎么用

1. **动 UI 前**：先读上面的规范文档，再按主题在本目录找同区域的历史稿——避免推翻已经定过的方案。
2. **出新稿**：放在 `design/` 根目录，文件名带主题关键词（如 `截图-遮罩工具重做-设计稿.html`），脚本会自动归类。
3. **改完稿**：跑一次 `npm run gen:design-index` 刷新本索引。

## 关于「状态标注」（为什么这里没有）

本索引**不标「已落地 / 待实施 / 已废弃」**。试过用 CHANGELOG 反推，结论是推不出来：

把每份设计稿的标题关键词拿去 `CHANGELOG.md` 全文匹配，**293 份只命中 5 份**。CHANGELOG 写的是用户语言（「截图后可以继续标注」），
设计稿写的是工程语言（「标注工具栏排序-方案A」），两者天然对不上。拿它当落地判据会大面积误判——宁可不标。

所以这里只给两列**可机械验证**的事实：

- **入库**：该文件在 git 中最早出现的日期（`--diff-filter=A`）。`—` 表示尚未提交（大概率是正在讨论的新稿）。
- **体量**：文件大小，粗略指示详略程度。

「哪份是现行基线」目前只能靠人判断。**让这个索引变可靠的最省事办法**：维护者在定稿的稿子顶部加一行注释（如 `<!-- status: shipped v7.1.6 -->`），
脚本就能自动收集——比事后猜可靠得多。

## 目录结构

| 子目录 | 文件数 | 体量 | 说明 |
|---|---:|---:|---|
| `promo/` | 5717 | 438.7 MB | 推广素材与视频工程（含 hyperframes 视频工具；仓外依赖多，多数文件未纳入 git） |
| `logo-options/` | 13 | 9.2 MB | Logo 备选方案（有 index.html 汇总页） |
| `icon-options/` | 5 | 4.3 MB | 应用图标备选方案 |
| `installer/` | 2 | 5 KB | NSIS 安装器品牌位图 |
| `*.html`（根目录） | 317 | — | 设计稿正文，见下方按主题分组 |

## 设计稿清单（317 份，按主题分组）

### 视觉与品牌（28）

*主题、色彩、图标、Logo、吉祥物、质感、全局规则审计。改观感前先看这里。*

| 设计稿 | 入库 | 体量 |
|---|---|---|
| [`PastePanda-托盘右键菜单-UI升级-设计稿`](./PastePanda-%E6%89%98%E7%9B%98%E5%8F%B3%E9%94%AE%E8%8F%9C%E5%8D%95-UI%E5%8D%87%E7%BA%A7-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-17 近期 | 25 KB |
| [`远程电脑-UI升级-设计稿`](./%E8%BF%9C%E7%A8%8B%E7%94%B5%E8%84%91-UI%E5%8D%87%E7%BA%A7-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-15 近期 | 41 KB |
| [`项目质感提升-效果对照稿`](./%E9%A1%B9%E7%9B%AE%E8%B4%A8%E6%84%9F%E6%8F%90%E5%8D%87-%E6%95%88%E6%9E%9C%E5%AF%B9%E7%85%A7%E7%A8%BF.html) | 2026-09-14 近期 | 22 KB |
| [`设置图标-顶栏同款去方砖`](./%E8%AE%BE%E7%BD%AE%E5%9B%BE%E6%A0%87-%E9%A1%B6%E6%A0%8F%E5%90%8C%E6%AC%BE%E5%8E%BB%E6%96%B9%E7%A0%96.html) | 2026-09-14 近期 | 15 KB |
| [`设置图标-重设计四套对标业界`](./%E8%AE%BE%E7%BD%AE%E5%9B%BE%E6%A0%87-%E9%87%8D%E8%AE%BE%E8%AE%A1%E5%9B%9B%E5%A5%97%E5%AF%B9%E6%A0%87%E4%B8%9A%E7%95%8C.html) | 2026-09-14 近期 | 30 KB |
| [`设置图标-进阶三套双调裸线玻璃`](./%E8%AE%BE%E7%BD%AE%E5%9B%BE%E6%A0%87-%E8%BF%9B%E9%98%B6%E4%B8%89%E5%A5%97%E5%8F%8C%E8%B0%83%E8%A3%B8%E7%BA%BF%E7%8E%BB%E7%92%83.html) | 2026-09-14 近期 | 18 KB |
| [`设置图标-语义色相体系`](./%E8%AE%BE%E7%BD%AE%E5%9B%BE%E6%A0%87-%E8%AF%AD%E4%B9%89%E8%89%B2%E7%9B%B8%E4%BD%93%E7%B3%BB.html) | 2026-09-14 近期 | 15 KB |
| [`设置图标-裸emoji无方砖`](./%E8%AE%BE%E7%BD%AE%E5%9B%BE%E6%A0%87-%E8%A3%B8emoji%E6%97%A0%E6%96%B9%E7%A0%96.html) | 2026-09-14 近期 | 10 KB |
| [`设置图标-彩色瓷砖对照`](./%E8%AE%BE%E7%BD%AE%E5%9B%BE%E6%A0%87-%E5%BD%A9%E8%89%B2%E7%93%B7%E7%A0%96%E5%AF%B9%E7%85%A7.html) | 2026-09-14 近期 | 9 KB |
| [`设置图标-可读性五套方案`](./%E8%AE%BE%E7%BD%AE%E5%9B%BE%E6%A0%87-%E5%8F%AF%E8%AF%BB%E6%80%A7%E4%BA%94%E5%A5%97%E6%96%B9%E6%A1%88.html) | 2026-09-14 近期 | 16 KB |
| [`设置图标-保留emoji三套`](./%E8%AE%BE%E7%BD%AE%E5%9B%BE%E6%A0%87-%E4%BF%9D%E7%95%99emoji%E4%B8%89%E5%A5%97.html) | 2026-09-14 近期 | 9 KB |
| [`设置图标-emoji彩砖白圆盘最终稿`](./%E8%AE%BE%E7%BD%AE%E5%9B%BE%E6%A0%87-emoji%E5%BD%A9%E7%A0%96%E7%99%BD%E5%9C%86%E7%9B%98%E6%9C%80%E7%BB%88%E7%A8%BF.html) | 2026-09-14 近期 | 13 KB |
| [`浮层风格统一-方案设计稿`](./%E6%B5%AE%E5%B1%82%E9%A3%8E%E6%A0%BC%E7%BB%9F%E4%B8%80-%E6%96%B9%E6%A1%88%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-14 近期 | 30 KB |
| [`og-image-源稿`](./og-image-%E6%BA%90%E7%A8%BF.html) | 2026-09-10 近期 | 3 KB |
| [`2026-UI趋势落地-设计稿`](./2026-UI%E8%B6%8B%E5%8A%BF%E8%90%BD%E5%9C%B0-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-10 近期 | 35 KB |
| [`2026-UI升级-Token六主题-设计稿`](./2026-UI%E5%8D%87%E7%BA%A7-Token%E5%85%AD%E4%B8%BB%E9%A2%98-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-10 近期 | 29 KB |
| [`PastePanda-UI规则全量审计-真实稿`](./PastePanda-UI%E8%A7%84%E5%88%99%E5%85%A8%E9%87%8F%E5%AE%A1%E8%AE%A1-%E7%9C%9F%E5%AE%9E%E7%A8%BF.html) | 2026-09-09 近期 | 15 KB |
| [`色彩规范-设计稿`](./%E8%89%B2%E5%BD%A9%E8%A7%84%E8%8C%83-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-08 近期 | 17 KB |
| [`interaction-audit`](./interaction-audit.html) | 2026-08-21 近期 | 16 KB |
| [`ui-audit-interaction-mockups`](./ui-audit-interaction-mockups.html) | 2026-08-15 近期 | 25 KB |
| [`v5.10.1-ui-review`](./v5.10.1-ui-review.html) | 2026-08-10 近期 | 19 KB |
| [`melody-mascot-draft`](./melody-mascot-draft.html) | 2026-08-06 近期 | 21 KB |
| [`immersive-skin-draft`](./immersive-skin-draft.html) | 2026-08-06 近期 | 33 KB |
| [`contrast-audit`](./contrast-audit.html) | 2026-07-29 | 59 KB |
| [`color-preview`](./color-preview.html) | 2026-07-22 | 10 KB |
| [`icon-redesign-preview`](./icon-redesign-preview.html) | 2026-07-03 | 27 KB |
| [`theme-preview`](./theme-preview.html) | 2026-07-01 | 23 KB |
| [`all-icons-redesign`](./all-icons-redesign.html) | 2026-07-01 | 19 KB |

### 流程图（6）

*流程图的内嵌/全屏编辑、分组缩放、空态引导。*

| 设计稿 | 入库 | 体量 |
|---|---|---|
| [`PastePanda-流程图-第三批-分组与缩放`](./PastePanda-%E6%B5%81%E7%A8%8B%E5%9B%BE-%E7%AC%AC%E4%B8%89%E6%89%B9-%E5%88%86%E7%BB%84%E4%B8%8E%E7%BC%A9%E6%94%BE.html) | 2026-08-14 近期 | 22 KB |
| [`PastePanda-流程图-交互升级-第二批`](./PastePanda-%E6%B5%81%E7%A8%8B%E5%9B%BE-%E4%BA%A4%E4%BA%92%E5%8D%87%E7%BA%A7-%E7%AC%AC%E4%BA%8C%E6%89%B9.html) | 2026-08-14 近期 | 31 KB |
| [`PastePanda-流程图-空态引导-设计稿`](./PastePanda-%E6%B5%81%E7%A8%8B%E5%9B%BE-%E7%A9%BA%E6%80%81%E5%BC%95%E5%AF%BC-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-13 近期 | 8 KB |
| [`PastePanda-流程图-内嵌编辑版-重设计`](./PastePanda-%E6%B5%81%E7%A8%8B%E5%9B%BE-%E5%86%85%E5%B5%8C%E7%BC%96%E8%BE%91%E7%89%88-%E9%87%8D%E8%AE%BE%E8%AE%A1.html) | 2026-08-13 近期 | 26 KB |
| [`PastePanda-流程图-全屏编辑版-重设计`](./PastePanda-%E6%B5%81%E7%A8%8B%E5%9B%BE-%E5%85%A8%E5%B1%8F%E7%BC%96%E8%BE%91%E7%89%88-%E9%87%8D%E8%AE%BE%E8%AE%A1.html) | 2026-08-13 近期 | 36 KB |
| [`PastePanda-流程图-UI精修-方案乙`](./PastePanda-%E6%B5%81%E7%A8%8B%E5%9B%BE-UI%E7%B2%BE%E4%BF%AE-%E6%96%B9%E6%A1%88%E4%B9%99.html) | 2026-08-13 近期 | 42 KB |

### 截图与标注（50）

*截图子系统：选区状态机、工具栏、标注工具、取文字/OCR、贴图、长截图、遮罩。*

| 设计稿 | 入库 | 体量 |
|---|---|---|
| [`PastePanda-截图主题适配-设计稿`](./PastePanda-%E6%88%AA%E5%9B%BE%E4%B8%BB%E9%A2%98%E9%80%82%E9%85%8D-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-26 近期 | 52 KB |
| [`screenshot-mosaic-mode`](./screenshot-mosaic-mode.html) | 2026-08-21 近期 | 20 KB |
| [`screenshot-dewatermark`](./screenshot-dewatermark.html) | 2026-08-21 近期 | 16 KB |
| [`截图文字输入框美化+遮罩不可拖动-设计稿`](./%E6%88%AA%E5%9B%BE%E6%96%87%E5%AD%97%E8%BE%93%E5%85%A5%E6%A1%86%E7%BE%8E%E5%8C%96+%E9%81%AE%E7%BD%A9%E4%B8%8D%E5%8F%AF%E6%8B%96%E5%8A%A8-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-19 近期 | 12 KB |
| [`screenshot-toolbar-redesign`](./screenshot-toolbar-redesign.html) | 2026-08-19 近期 | 27 KB |
| [`screenshot-fullscreen-shade`](./screenshot-fullscreen-shade.html) | 2026-08-19 近期 | 13 KB |
| [`screenshot-toolbar-animation`](./screenshot-toolbar-animation.html) | 2026-08-18 近期 | 27 KB |
| [`screenshot-tier3-double-outline`](./screenshot-tier3-double-outline.html) | 2026-08-18 近期 | 14 KB |
| [`PastePanda-长截图预览即默认-设计稿`](./PastePanda-%E9%95%BF%E6%88%AA%E5%9B%BE%E9%A2%84%E8%A7%88%E5%8D%B3%E9%BB%98%E8%AE%A4-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-18 近期 | 6 KB |
| [`PastePanda-选区拖拽即画新框-设计稿`](./PastePanda-%E9%80%89%E5%8C%BA%E6%8B%96%E6%8B%BD%E5%8D%B3%E7%94%BB%E6%96%B0%E6%A1%86-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-18 近期 | 5 KB |
| [`PastePanda-贴图预览即钉-设计稿`](./PastePanda-%E8%B4%B4%E5%9B%BE%E9%A2%84%E8%A7%88%E5%8D%B3%E9%92%89-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-18 近期 | 5 KB |
| [`PastePanda-贴图无边框-设计稿`](./PastePanda-%E8%B4%B4%E5%9B%BE%E6%97%A0%E8%BE%B9%E6%A1%86-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-18 近期 | 8 KB |
| [`PastePanda-自动打码预览式-设计稿`](./PastePanda-%E8%87%AA%E5%8A%A8%E6%89%93%E7%A0%81%E9%A2%84%E8%A7%88%E5%BC%8F-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-18 近期 | 5 KB |
| [`PastePanda-标注默认工具零步可用-设计稿`](./PastePanda-%E6%A0%87%E6%B3%A8%E9%BB%98%E8%AE%A4%E5%B7%A5%E5%85%B7%E9%9B%B6%E6%AD%A5%E5%8F%AF%E7%94%A8-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-18 近期 | 7 KB |
| [`PastePanda-标注工具栏排序-方案B-设计稿`](./PastePanda-%E6%A0%87%E6%B3%A8%E5%B7%A5%E5%85%B7%E6%A0%8F%E6%8E%92%E5%BA%8F-%E6%96%B9%E6%A1%88B-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-18 近期 | 47 KB |
| [`PastePanda-标注工具栏排序-方案A-设计稿`](./PastePanda-%E6%A0%87%E6%B3%A8%E5%B7%A5%E5%85%B7%E6%A0%8F%E6%8E%92%E5%BA%8F-%E6%96%B9%E6%A1%88A-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-18 近期 | 46 KB |
| [`PastePanda-标注工具栏排序-方案2-选区上方胶囊-设计稿`](./PastePanda-%E6%A0%87%E6%B3%A8%E5%B7%A5%E5%85%B7%E6%A0%8F%E6%8E%92%E5%BA%8F-%E6%96%B9%E6%A1%882-%E9%80%89%E5%8C%BA%E4%B8%8A%E6%96%B9%E8%83%B6%E5%9B%8A-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-18 近期 | 24 KB |
| [`PastePanda-标注工具栏排序-方案1-属性条第二层-设计稿`](./PastePanda-%E6%A0%87%E6%B3%A8%E5%B7%A5%E5%85%B7%E6%A0%8F%E6%8E%92%E5%BA%8F-%E6%96%B9%E6%A1%881-%E5%B1%9E%E6%80%A7%E6%9D%A1%E7%AC%AC%E4%BA%8C%E5%B1%82-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-18 近期 | 24 KB |
| [`PastePanda-标注工具栏折叠第二行-设计稿`](./PastePanda-%E6%A0%87%E6%B3%A8%E5%B7%A5%E5%85%B7%E6%A0%8F%E6%8A%98%E5%8F%A0%E7%AC%AC%E4%BA%8C%E8%A1%8C-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-18 近期 | 16 KB |
| [`PastePanda-标注工具栏双行精简-设计稿`](./PastePanda-%E6%A0%87%E6%B3%A8%E5%B7%A5%E5%85%B7%E6%A0%8F%E5%8F%8C%E8%A1%8C%E7%B2%BE%E7%AE%80-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-18 近期 | 13 KB |
| [`PastePanda-标注工具栏单卡整合-设计稿`](./PastePanda-%E6%A0%87%E6%B3%A8%E5%B7%A5%E5%85%B7%E6%A0%8F%E5%8D%95%E5%8D%A1%E6%95%B4%E5%90%88-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-18 近期 | 24 KB |
| [`PastePanda-标注工具栏单卡整合-保留更多-设计稿`](./PastePanda-%E6%A0%87%E6%B3%A8%E5%B7%A5%E5%85%B7%E6%A0%8F%E5%8D%95%E5%8D%A1%E6%95%B4%E5%90%88-%E4%BF%9D%E7%95%99%E6%9B%B4%E5%A4%9A-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-18 近期 | 25 KB |
| [`PastePanda-标注工具栏单列分组-设计稿`](./PastePanda-%E6%A0%87%E6%B3%A8%E5%B7%A5%E5%85%B7%E6%A0%8F%E5%8D%95%E5%88%97%E5%88%86%E7%BB%84-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-18 近期 | 18 KB |
| [`PastePanda-标注与文字识别共存-设计稿`](./PastePanda-%E6%A0%87%E6%B3%A8%E4%B8%8E%E6%96%87%E5%AD%97%E8%AF%86%E5%88%AB%E5%85%B1%E5%AD%98-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-18 近期 | 19 KB |
| [`PastePanda-固定区域预览即默认-设计稿`](./PastePanda-%E5%9B%BA%E5%AE%9A%E5%8C%BA%E5%9F%9F%E9%A2%84%E8%A7%88%E5%8D%B3%E9%BB%98%E8%AE%A4-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-18 近期 | 5 KB |
| [`PastePanda-取文字选区即文字层-设计稿`](./PastePanda-%E5%8F%96%E6%96%87%E5%AD%97%E9%80%89%E5%8C%BA%E5%8D%B3%E6%96%87%E5%AD%97%E5%B1%82-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-18 近期 | 7 KB |
| [`PastePanda-取文字拖选字级-设计稿`](./PastePanda-%E5%8F%96%E6%96%87%E5%AD%97%E6%8B%96%E9%80%89%E5%AD%97%E7%BA%A7-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-18 近期 | 15 KB |
| [`PastePanda-长截图交互-设计稿`](./PastePanda-%E9%95%BF%E6%88%AA%E5%9B%BE%E4%BA%A4%E4%BA%92-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-17 近期 | 12 KB |
| [`PastePanda-遮罩工具重做-设计稿`](./PastePanda-%E9%81%AE%E7%BD%A9%E5%B7%A5%E5%85%B7%E9%87%8D%E5%81%9A-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-17 近期 | 16 KB |
| [`PastePanda-贴图旋转翻转-设计稿`](./PastePanda-%E8%B4%B4%E5%9B%BE%E6%97%8B%E8%BD%AC%E7%BF%BB%E8%BD%AC-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-17 近期 | 13 KB |
| [`PastePanda-截图选区状态机重构-设计稿`](./PastePanda-%E6%88%AA%E5%9B%BE%E9%80%89%E5%8C%BA%E7%8A%B6%E6%80%81%E6%9C%BA%E9%87%8D%E6%9E%84-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-17 近期 | 17 KB |
| [`PastePanda-截图联动-第二梯队-设计稿`](./PastePanda-%E6%88%AA%E5%9B%BE%E8%81%94%E5%8A%A8-%E7%AC%AC%E4%BA%8C%E6%A2%AF%E9%98%9F-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-17 近期 | 18 KB |
| [`PastePanda-截图标注与文字识别-交互设计稿`](./PastePanda-%E6%88%AA%E5%9B%BE%E6%A0%87%E6%B3%A8%E4%B8%8E%E6%96%87%E5%AD%97%E8%AF%86%E5%88%AB-%E4%BA%A4%E4%BA%92%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-17 近期 | 31 KB |
| [`PastePanda-截图工具栏改版-设计稿`](./PastePanda-%E6%88%AA%E5%9B%BE%E5%B7%A5%E5%85%B7%E6%A0%8F%E6%94%B9%E7%89%88-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-17 近期 | 36 KB |
| [`PastePanda-截图图库-设计稿`](./PastePanda-%E6%88%AA%E5%9B%BE%E5%9B%BE%E5%BA%93-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-17 近期 | 20 KB |
| [`PastePanda-截图取文字入口-设计稿`](./PastePanda-%E6%88%AA%E5%9B%BE%E5%8F%96%E6%96%87%E5%AD%97%E5%85%A5%E5%8F%A3-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-17 近期 | 21 KB |
| [`PastePanda-截图主力出口上升-设计稿`](./PastePanda-%E6%88%AA%E5%9B%BE%E4%B8%BB%E5%8A%9B%E5%87%BA%E5%8F%A3%E4%B8%8A%E5%8D%87-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-17 近期 | 26 KB |
| [`图片卡片复制识别文字-设计稿`](./%E5%9B%BE%E7%89%87%E5%8D%A1%E7%89%87%E5%A4%8D%E5%88%B6%E8%AF%86%E5%88%AB%E6%96%87%E5%AD%97-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-15 近期 | 13 KB |
| [`图片卡片OCR标题-设计稿`](./%E5%9B%BE%E7%89%87%E5%8D%A1%E7%89%87OCR%E6%A0%87%E9%A2%98-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-15 近期 | 13 KB |
| [`ocr-wechat-enhance-mockup`](./ocr-wechat-enhance-mockup.html) | 2026-08-15 近期 | 23 KB |
| [`ocr-result-panel-mockup`](./ocr-result-panel-mockup.html) | 2026-08-15 近期 | 17 KB |
| [`ocr-real-ui-wechat-enhanced-mockup`](./ocr-real-ui-wechat-enhanced-mockup.html) | 2026-08-15 近期 | 36 KB |
| [`ocr-current-ui-mockup`](./ocr-current-ui-mockup.html) | 2026-08-15 近期 | 27 KB |
| [`image-toolbar-widen-mockup`](./image-toolbar-widen-mockup.html) | 2026-08-15 近期 | 8 KB |
| [`image-dialog-B-ocrflow-mockup`](./image-dialog-B-ocrflow-mockup.html) | 2026-08-15 近期 | 27 KB |
| [`image-dialog-A-maximize-mockup`](./image-dialog-A-maximize-mockup.html) | 2026-08-15 近期 | 30 KB |
| [`ai-quickbar-image-ocr-mockup`](./ai-quickbar-image-ocr-mockup.html) | 2026-08-15 近期 | 12 KB |
| [`image-preview-redesign`](./image-preview-redesign.html) | 2026-07-01 | 19 KB |
| [`image-ocr-select-preview`](./image-ocr-select-preview.html) | 2026-07-01 | 33 KB |
| [`image-ocr-pin-preview`](./image-ocr-pin-preview.html) | 2026-07-01 | 15 KB |

### 知识库与 MCP（41）

*知识库视图/交互/回收站/版本锚定，以及 MCP 接入、权限、局域网直连。*

| 设计稿 | 入库 | 体量 |
|---|---|---|
| [`MCP局域网直连-设计稿`](./MCP%E5%B1%80%E5%9F%9F%E7%BD%91%E7%9B%B4%E8%BF%9E-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-15 近期 | 16 KB |
| [`2026-知识库同步状态-AB设计稿`](./2026-%E7%9F%A5%E8%AF%86%E5%BA%93%E5%90%8C%E6%AD%A5%E7%8A%B6%E6%80%81-AB%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-14 近期 | 27 KB |
| [`PastePanda-知识库推广落地页-设计稿`](./PastePanda-%E7%9F%A5%E8%AF%86%E5%BA%93%E6%8E%A8%E5%B9%BF%E8%90%BD%E5%9C%B0%E9%A1%B5-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-10 近期 | 87 KB |
| [`MCP-HTTPS-TLS设计稿`](./MCP-HTTPS-TLS%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-10 近期 | 18 KB |
| [`2026-知识库视觉升级-对照稿`](./2026-%E7%9F%A5%E8%AF%86%E5%BA%93%E8%A7%86%E8%A7%89%E5%8D%87%E7%BA%A7-%E5%AF%B9%E7%85%A7%E7%A8%BF.html) | 2026-09-10 近期 | 34 KB |
| [`写入者筛选-真实稿`](./%E5%86%99%E5%85%A5%E8%80%85%E7%AD%9B%E9%80%89-%E7%9C%9F%E5%AE%9E%E7%A8%BF.html) | 2026-09-09 近期 | 8 KB |
| [`MCP文件夹写白名单-真实稿`](./MCP%E6%96%87%E4%BB%B6%E5%A4%B9%E5%86%99%E7%99%BD%E5%90%8D%E5%8D%95-%E7%9C%9F%E5%AE%9E%E7%A8%BF.html) | 2026-09-09 近期 | 23 KB |
| [`知识库模式-升级-乙-设计稿`](./%E7%9F%A5%E8%AF%86%E5%BA%93%E6%A8%A1%E5%BC%8F-%E5%8D%87%E7%BA%A7-%E4%B9%99-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-08 近期 | 36 KB |
| [`知识库模式-升级-乙-真实稿`](./%E7%9F%A5%E8%AF%86%E5%BA%93%E6%A8%A1%E5%BC%8F-%E5%8D%87%E7%BA%A7-%E4%B9%99-%E7%9C%9F%E5%AE%9E%E7%A8%BF.html) | 2026-09-08 近期 | 39 KB |
| [`知识库模式-升级-丙-设计稿`](./%E7%9F%A5%E8%AF%86%E5%BA%93%E6%A8%A1%E5%BC%8F-%E5%8D%87%E7%BA%A7-%E4%B8%99-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-08 近期 | 28 KB |
| [`知识库-第三栏头部-甲-真实稿`](./%E7%9F%A5%E8%AF%86%E5%BA%93-%E7%AC%AC%E4%B8%89%E6%A0%8F%E5%A4%B4%E9%83%A8-%E7%94%B2-%E7%9C%9F%E5%AE%9E%E7%A8%BF.html) | 2026-09-08 近期 | 21 KB |
| [`知识库冲突对照-设计稿`](./%E7%9F%A5%E8%AF%86%E5%BA%93%E5%86%B2%E7%AA%81%E5%AF%B9%E7%85%A7-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-07 近期 | 23 KB |
| [`PastePanda-知识库模式-全面升级-C-设计稿`](./PastePanda-%E7%9F%A5%E8%AF%86%E5%BA%93%E6%A8%A1%E5%BC%8F-%E5%85%A8%E9%9D%A2%E5%8D%87%E7%BA%A7-C-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-06 近期 | 28 KB |
| [`PastePanda-知识库交互修复-设计稿`](./PastePanda-%E7%9F%A5%E8%AF%86%E5%BA%93%E4%BA%A4%E4%BA%92%E4%BF%AE%E5%A4%8D-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-06 近期 | 10 KB |
| [`PastePanda-MCP一键接入-设计稿`](./PastePanda-MCP%E4%B8%80%E9%94%AE%E6%8E%A5%E5%85%A5-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-06 近期 | 13 KB |
| [`PastePanda-知识库配对向导-设计稿`](./PastePanda-%E7%9F%A5%E8%AF%86%E5%BA%93%E9%85%8D%E5%AF%B9%E5%90%91%E5%AF%BC-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-05 近期 | 26 KB |
| [`PastePanda-每日整理-H3行为层-设计稿`](./PastePanda-%E6%AF%8F%E6%97%A5%E6%95%B4%E7%90%86-H3%E8%A1%8C%E4%B8%BA%E5%B1%82-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-05 近期 | 16 KB |
| [`PastePanda-库体检-N3-设计稿`](./PastePanda-%E5%BA%93%E4%BD%93%E6%A3%80-N3-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-05 近期 | 21 KB |
| [`PastePanda-反链面板-设计稿`](./PastePanda-%E5%8F%8D%E9%93%BE%E9%9D%A2%E6%9D%BF-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-05 近期 | 12 KB |
| [`PastePanda-知识库同步配对-设计稿`](./PastePanda-%E7%9F%A5%E8%AF%86%E5%BA%93%E5%90%8C%E6%AD%A5%E9%85%8D%E5%AF%B9-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-04 近期 | 27 KB |
| [`mcp-library-blurb`](./mcp-library-blurb.html) | 2026-09-04 近期 | 11 KB |
| [`知识库能力扩展-设计稿`](./%E7%9F%A5%E8%AF%86%E5%BA%93%E8%83%BD%E5%8A%9B%E6%89%A9%E5%B1%95-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-03 近期 | 16 KB |
| [`知识库交互修复-设计稿`](./%E7%9F%A5%E8%AF%86%E5%BA%93%E4%BA%A4%E4%BA%92%E4%BF%AE%E5%A4%8D-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-03 近期 | 15 KB |
| [`知识库交互优化-A61-设计稿`](./%E7%9F%A5%E8%AF%86%E5%BA%93%E4%BA%A4%E4%BA%92%E4%BC%98%E5%8C%96-A61-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-03 近期 | 20 KB |
| [`知识库版本锚定-W2-设计稿`](./%E7%9F%A5%E8%AF%86%E5%BA%93%E7%89%88%E6%9C%AC%E9%94%9A%E5%AE%9A-W2-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-02 近期 | 8 KB |
| [`知识库模式-视觉统一-设计稿`](./%E7%9F%A5%E8%AF%86%E5%BA%93%E6%A8%A1%E5%BC%8F-%E8%A7%86%E8%A7%89%E7%BB%9F%E4%B8%80-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-02 近期 | 30 KB |
| [`知识库回收站-W1-设计稿`](./%E7%9F%A5%E8%AF%86%E5%BA%93%E5%9B%9E%E6%94%B6%E7%AB%99-W1-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-02 近期 | 27 KB |
| [`知识库MCP服务-设置面板-设计稿`](./%E7%9F%A5%E8%AF%86%E5%BA%93MCP%E6%9C%8D%E5%8A%A1-%E8%AE%BE%E7%BD%AE%E9%9D%A2%E6%9D%BF-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-02 近期 | 48 KB |
| [`知识库MCP写权限-M5-设计稿`](./%E7%9F%A5%E8%AF%86%E5%BA%93MCP%E5%86%99%E6%9D%83%E9%99%90-M5-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-02 近期 | 9 KB |
| [`转笔记模板-B2-8-设计稿`](./%E8%BD%AC%E7%AC%94%E8%AE%B0%E6%A8%A1%E6%9D%BF-B2-8-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-01 近期 | 18 KB |
| [`知识库问答雏形-B2-10-设计稿`](./%E7%9F%A5%E8%AF%86%E5%BA%93%E9%97%AE%E7%AD%94%E9%9B%8F%E5%BD%A2-B2-10-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-01 近期 | 17 KB |
| [`知识库问答-第三栏改版-B2-10b-设计稿`](./%E7%9F%A5%E8%AF%86%E5%BA%93%E9%97%AE%E7%AD%94-%E7%AC%AC%E4%B8%89%E6%A0%8F%E6%94%B9%E7%89%88-B2-10b-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-01 近期 | 18 KB |
| [`知识库字段视图-B2-9-设计稿`](./%E7%9F%A5%E8%AF%86%E5%BA%93%E5%AD%97%E6%AE%B5%E8%A7%86%E5%9B%BE-B2-9-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-01 近期 | 14 KB |
| [`今日速记-B2-3-设计稿`](./%E4%BB%8A%E6%97%A5%E9%80%9F%E8%AE%B0-B2-3-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-01 近期 | 13 KB |
| [`PastePanda-知识库视图-设计稿`](./PastePanda-%E7%9F%A5%E8%AF%86%E5%BA%93%E8%A7%86%E5%9B%BE-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-01 近期 | 32 KB |
| [`kb-c-ai-autotag-summary`](./kb-c-ai-autotag-summary.html) | 2026-08-28 近期 | 50 KB |
| [`kb-b-library-view`](./kb-b-library-view.html) | 2026-08-26 近期 | 95 KB |
| [`kb-a-note-dialog`](./kb-a-note-dialog.html) | 2026-08-26 近期 | 79 KB |
| [`联系人编辑器-设计稿`](./%E8%81%94%E7%B3%BB%E4%BA%BA%E7%BC%96%E8%BE%91%E5%99%A8-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-23 近期 | 9 KB |
| [`目标应用感知重排-X3-设计稿`](./%E7%9B%AE%E6%A0%87%E5%BA%94%E7%94%A8%E6%84%9F%E7%9F%A5%E9%87%8D%E6%8E%92-X3-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-15 近期 | 13 KB |
| [`事件聚合-想起一件事-设计稿`](./%E4%BA%8B%E4%BB%B6%E8%81%9A%E5%90%88-%E6%83%B3%E8%B5%B7%E4%B8%80%E4%BB%B6%E4%BA%8B-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-15 近期 | 13 KB |

### AI 能力（30）

*AI 栏、AI 设置、动作链、变换卡、自进化、服务商卡片。*

| 设计稿 | 入库 | 体量 |
|---|---|---|
| [`自动触发执行-设计稿`](./%E8%87%AA%E5%8A%A8%E8%A7%A6%E5%8F%91%E6%89%A7%E8%A1%8C-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-16 近期 | 21 KB |
| [`画像注入AI输出-D1-设计稿`](./%E7%94%BB%E5%83%8F%E6%B3%A8%E5%85%A5AI%E8%BE%93%E5%87%BA-D1-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-15 近期 | 16 KB |
| [`动作置顶-打破冷启动-设计稿`](./%E5%8A%A8%E4%BD%9C%E7%BD%AE%E9%A1%B6-%E6%89%93%E7%A0%B4%E5%86%B7%E5%90%AF%E5%8A%A8-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-15 近期 | 11 KB |
| [`AI页未来感美化-B方案-设计稿`](./AI%E9%A1%B5%E6%9C%AA%E6%9D%A5%E6%84%9F%E7%BE%8E%E5%8C%96-B%E6%96%B9%E6%A1%88-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-15 近期 | 25 KB |
| [`顶栏AI标识-设计稿`](./%E9%A1%B6%E6%A0%8FAI%E6%A0%87%E8%AF%86-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-12 近期 | 26 KB |
| [`自进化并入AI页-设计稿`](./%E8%87%AA%E8%BF%9B%E5%8C%96%E5%B9%B6%E5%85%A5AI%E9%A1%B5-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-12 近期 | 22 KB |
| [`服务商卡片-等高对齐-设计稿`](./%E6%9C%8D%E5%8A%A1%E5%95%86%E5%8D%A1%E7%89%87-%E7%AD%89%E9%AB%98%E5%AF%B9%E9%BD%90-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-12 近期 | 11 KB |
| [`服务商卡片-名字完整显示-设计稿`](./%E6%9C%8D%E5%8A%A1%E5%95%86%E5%8D%A1%E7%89%87-%E5%90%8D%E5%AD%97%E5%AE%8C%E6%95%B4%E6%98%BE%E7%A4%BA-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-12 近期 | 20 KB |
| [`推荐理由-为什么推荐-设计稿`](./%E6%8E%A8%E8%8D%90%E7%90%86%E7%94%B1-%E4%B8%BA%E4%BB%80%E4%B9%88%E6%8E%A8%E8%8D%90-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-12 近期 | 12 KB |
| [`变换中心-链入口溢出修复-设计稿`](./%E5%8F%98%E6%8D%A2%E4%B8%AD%E5%BF%83-%E9%93%BE%E5%85%A5%E5%8F%A3%E6%BA%A2%E5%87%BA%E4%BF%AE%E5%A4%8D-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-12 近期 | 25 KB |
| [`动作链运行器-垂直溢出修复-设计稿`](./%E5%8A%A8%E4%BD%9C%E9%93%BE%E8%BF%90%E8%A1%8C%E5%99%A8-%E5%9E%82%E7%9B%B4%E6%BA%A2%E5%87%BA%E4%BF%AE%E5%A4%8D-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-12 近期 | 21 KB |
| [`动作链UI-升级-设计稿`](./%E5%8A%A8%E4%BD%9C%E9%93%BEUI-%E5%8D%87%E7%BA%A7-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-12 近期 | 27 KB |
| [`v7.0-AI中枢化-设计稿`](./v7.0-AI%E4%B8%AD%E6%9E%A2%E5%8C%96-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-12 近期 | 22 KB |
| [`learning-insights`](./learning-insights.html) | 2026-08-12 近期 | 22 KB |
| [`AI运行态与变换卡-设计稿`](./AI%E8%BF%90%E8%A1%8C%E6%80%81%E4%B8%8E%E5%8F%98%E6%8D%A2%E5%8D%A1-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-12 近期 | 24 KB |
| [`AI设置页-整体美化-设计稿`](./AI%E8%AE%BE%E7%BD%AE%E9%A1%B5-%E6%95%B4%E4%BD%93%E7%BE%8E%E5%8C%96-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-12 近期 | 27 KB |
| [`AI栏-卡片锛定-设计稿`](./AI%E6%A0%8F-%E5%8D%A1%E7%89%87%E9%94%9B%E5%AE%9A-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-12 近期 | 19 KB |
| [`AI前端页面-升级-设计稿`](./AI%E5%89%8D%E7%AB%AF%E9%A1%B5%E9%9D%A2-%E5%8D%87%E7%BA%A7-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-12 近期 | 32 KB |
| [`ai-status-icon-demo`](./ai-status-icon-demo.html) | 2026-08-12 近期 | 9 KB |
| [`ai-settings-redesign`](./ai-settings-redesign.html) | 2026-08-12 近期 | 31 KB |
| [`ai-ui-polish`](./ai-ui-polish.html) | 2026-08-10 近期 | 13 KB |
| [`ai-setup-v2`](./ai-setup-v2.html) | 2026-08-10 近期 | 15 KB |
| [`ai-setup-full`](./ai-setup-full.html) | 2026-08-10 近期 | 18 KB |
| [`ai-quickbar-demo`](./ai-quickbar-demo.html) | 2026-08-10 近期 | 14 KB |
| [`ai-profile-dialog`](./ai-profile-dialog.html) | 2026-08-10 近期 | 11 KB |
| [`ai-pref-and-plan`](./ai-pref-and-plan.html) | 2026-08-10 近期 | 10 KB |
| [`ai-main-window`](./ai-main-window.html) | 2026-08-10 近期 | 10 KB |
| [`ai-settings-v2-分层渐进`](./ai-settings-v2-%E5%88%86%E5%B1%82%E6%B8%90%E8%BF%9B.html) | 2026-08-08 近期 | 22 KB |
| [`ai-custom-actions`](./ai-custom-actions.html) | 2026-08-08 近期 | 11 KB |
| [`ai-badge`](./ai-badge.html) | 2026-08-08 近期 | 15 KB |

### 设置与帮助（14）

*设置页、关于页、帮助页的版式与信息架构。*

| 设计稿 | 入库 | 体量 |
|---|---|---|
| [`远程电脑-设置去摆设与美化-设计稿`](./%E8%BF%9C%E7%A8%8B%E7%94%B5%E8%84%91-%E8%AE%BE%E7%BD%AE%E5%8E%BB%E6%91%86%E8%AE%BE%E4%B8%8E%E7%BE%8E%E5%8C%96-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | — | 53 KB |
| [`远程电脑-开关可发现与画质自适应-设计稿`](./%E8%BF%9C%E7%A8%8B%E7%94%B5%E8%84%91-%E5%BC%80%E5%85%B3%E5%8F%AF%E5%8F%91%E7%8E%B0%E4%B8%8E%E7%94%BB%E8%B4%A8%E8%87%AA%E9%80%82%E5%BA%94-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | — | 30 KB |
| [`设置页-风格对齐优化对照稿`](./%E8%AE%BE%E7%BD%AE%E9%A1%B5-%E9%A3%8E%E6%A0%BC%E5%AF%B9%E9%BD%90%E4%BC%98%E5%8C%96%E5%AF%B9%E7%85%A7%E7%A8%BF.html) | 2026-09-14 近期 | 20 KB |
| [`设置页-体验升级第二档`](./%E8%AE%BE%E7%BD%AE%E9%A1%B5-%E4%BD%93%E9%AA%8C%E5%8D%87%E7%BA%A7%E7%AC%AC%E4%BA%8C%E6%A1%A3.html) | 2026-09-14 近期 | 20 KB |
| [`设置开关-三套方案对照`](./%E8%AE%BE%E7%BD%AE%E5%BC%80%E5%85%B3-%E4%B8%89%E5%A5%97%E6%96%B9%E6%A1%88%E5%AF%B9%E7%85%A7.html) | 2026-09-14 近期 | 14 KB |
| [`PastePanda-设置改为页面-二级下钻-设计稿`](./PastePanda-%E8%AE%BE%E7%BD%AE%E6%94%B9%E4%B8%BA%E9%A1%B5%E9%9D%A2-%E4%BA%8C%E7%BA%A7%E4%B8%8B%E9%92%BB-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-04 近期 | 33 KB |
| [`settings-editor-redesign-mockup`](./settings-editor-redesign-mockup.html) | 2026-08-15 近期 | 32 KB |
| [`settings-v2`](./settings-v2.html) | 2026-07-05 | 38 KB |
| [`settings-redesign`](./settings-redesign.html) | 2026-07-01 | 19 KB |
| [`settings-help-mockup`](./settings-help-mockup.html) | 2026-07-01 | 23 KB |
| [`settings-full-design`](./settings-full-design.html) | 2026-07-01 | 23 KB |
| [`help-redesign-v3`](./help-redesign-v3.html) | 2026-07-01 | 24 KB |
| [`about-dialog-v2`](./about-dialog-v2.html) | 2026-07-01 | 25 KB |
| [`about-compact-v2`](./about-compact-v2.html) | 2026-07-01 | 10 KB |

### 工具箱与模式（15）

*工具箱、工具模式、粘贴栈、二维码/SVG 编辑器、签到等独立能力。*

| 设计稿 | 入库 | 体量 |
|---|---|---|
| [`PastePanda-粘贴栈HUD-输入框锚定升级-设计稿`](./PastePanda-%E7%B2%98%E8%B4%B4%E6%A0%88HUD-%E8%BE%93%E5%85%A5%E6%A1%86%E9%94%9A%E5%AE%9A%E5%8D%87%E7%BA%A7-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-17 近期 | 27 KB |
| [`PastePanda-粘贴栈-目标窗口可见-设计稿`](./PastePanda-%E7%B2%98%E8%B4%B4%E6%A0%88-%E7%9B%AE%E6%A0%87%E7%AA%97%E5%8F%A3%E5%8F%AF%E8%A7%81-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-17 近期 | 31 KB |
| [`PastePanda-粘贴栈-栈浮标HUD-设计稿`](./PastePanda-%E7%B2%98%E8%B4%B4%E6%A0%88-%E6%A0%88%E6%B5%AE%E6%A0%87HUD-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-17 近期 | 35 KB |
| [`PastePanda-栈循环粘贴-AB方案-设计稿`](./PastePanda-%E6%A0%88%E5%BE%AA%E7%8E%AF%E7%B2%98%E8%B4%B4-AB%E6%96%B9%E6%A1%88-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-17 近期 | 36 KB |
| [`工具模式UI-美化升级对照稿`](./%E5%B7%A5%E5%85%B7%E6%A8%A1%E5%BC%8FUI-%E7%BE%8E%E5%8C%96%E5%8D%87%E7%BA%A7%E5%AF%B9%E7%85%A7%E7%A8%BF.html) | 2026-09-14 近期 | 21 KB |
| [`工具模式-体验升级第三档`](./%E5%B7%A5%E5%85%B7%E6%A8%A1%E5%BC%8F-%E4%BD%93%E9%AA%8C%E5%8D%87%E7%BA%A7%E7%AC%AC%E4%B8%89%E6%A1%A3.html) | 2026-09-14 近期 | 17 KB |
| [`PastePanda-工具箱与模式切换器-设计稿`](./PastePanda-%E5%B7%A5%E5%85%B7%E7%AE%B1%E4%B8%8E%E6%A8%A1%E5%BC%8F%E5%88%87%E6%8D%A2%E5%99%A8-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-01 近期 | 31 KB |
| [`二维码双向编辑器-设计稿`](./%E4%BA%8C%E7%BB%B4%E7%A0%81%E5%8F%8C%E5%90%91%E7%BC%96%E8%BE%91%E5%99%A8-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-23 近期 | 7 KB |
| [`PastePanda-表格拆分进粘贴栈-设计稿`](./PastePanda-%E8%A1%A8%E6%A0%BC%E6%8B%86%E5%88%86%E8%BF%9B%E7%B2%98%E8%B4%B4%E6%A0%88-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-14 近期 | 20 KB |
| [`PastePanda-粘贴栈-chip内容预览-设计稿`](./PastePanda-%E7%B2%98%E8%B4%B4%E6%A0%88-chip%E5%86%85%E5%AE%B9%E9%A2%84%E8%A7%88-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-14 近期 | 11 KB |
| [`PastePanda-栈模式UI优化升级-设计稿`](./PastePanda-%E6%A0%88%E6%A8%A1%E5%BC%8FUI%E4%BC%98%E5%8C%96%E5%8D%87%E7%BA%A7-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-14 近期 | 15 KB |
| [`PastePanda-粘贴栈衍生-P1-设计稿`](./PastePanda-%E7%B2%98%E8%B4%B4%E6%A0%88%E8%A1%8D%E7%94%9F-P1-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-13 近期 | 38 KB |
| [`粘性功能-v6.8-设计稿`](./%E7%B2%98%E6%80%A7%E5%8A%9F%E8%83%BD-v6.8-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-12 近期 | 28 KB |
| [`签到送Token-v6.9-设计稿`](./%E7%AD%BE%E5%88%B0%E9%80%81Token-v6.9-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-12 近期 | 37 KB |
| [`clipboard-stack`](./clipboard-stack.html) | 2026-07-22 | 23 KB |

### 编辑器与预览（23）

*文件/文本编辑器、Markdown 预览与全屏编辑、diff、正则、编解码、PDF。*

| 设计稿 | 入库 | 体量 |
|---|---|---|
| [`PastePanda-MD导出导入-设计稿`](./PastePanda-MD%E5%AF%BC%E5%87%BA%E5%AF%BC%E5%85%A5-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-01 近期 | 13 KB |
| [`颜色调色板渐变编辑器-设计稿`](./%E9%A2%9C%E8%89%B2%E8%B0%83%E8%89%B2%E6%9D%BF%E6%B8%90%E5%8F%98%E7%BC%96%E8%BE%91%E5%99%A8-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-23 近期 | 8 KB |
| [`配置结构化编辑器-设计稿`](./%E9%85%8D%E7%BD%AE%E7%BB%93%E6%9E%84%E5%8C%96%E7%BC%96%E8%BE%91%E5%99%A8-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-23 近期 | 9 KB |
| [`编解码编辑器-设计稿`](./%E7%BC%96%E8%A7%A3%E7%A0%81%E7%BC%96%E8%BE%91%E5%99%A8-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-23 近期 | 9 KB |
| [`日志编辑器-设计稿`](./%E6%97%A5%E5%BF%97%E7%BC%96%E8%BE%91%E5%99%A8-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-23 近期 | 10 KB |
| [`媒体预览编辑器-设计稿`](./%E5%AA%92%E4%BD%93%E9%A2%84%E8%A7%88%E7%BC%96%E8%BE%91%E5%99%A8-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-23 近期 | 8 KB |
| [`SVG源码双向编辑器-设计稿`](./SVG%E6%BA%90%E7%A0%81%E5%8F%8C%E5%90%91%E7%BC%96%E8%BE%91%E5%99%A8-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-23 近期 | 5 KB |
| [`PDF阅读预览-设计稿`](./PDF%E9%98%85%E8%AF%BB%E9%A2%84%E8%A7%88-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-23 近期 | 4 KB |
| [`fullscreen-editor-unify-A`](./fullscreen-editor-unify-A.html) | 2026-08-23 近期 | 14 KB |
| [`diff-editor-upgrade-C`](./diff-editor-upgrade-C.html) | 2026-08-23 近期 | 25 KB |
| [`PastePanda-编辑器增量P1-设计稿`](./PastePanda-%E7%BC%96%E8%BE%91%E5%99%A8%E5%A2%9E%E9%87%8FP1-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-17 近期 | 20 KB |
| [`文档编辑器样式打磨-设计稿`](./%E6%96%87%E6%A1%A3%E7%BC%96%E8%BE%91%E5%99%A8%E6%A0%B7%E5%BC%8F%E6%89%93%E7%A3%A8-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-15 近期 | 12 KB |
| [`文档编辑器整体美化-设计稿`](./%E6%96%87%E6%A1%A3%E7%BC%96%E8%BE%91%E5%99%A8%E6%95%B4%E4%BD%93%E7%BE%8E%E5%8C%96-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-15 近期 | 13 KB |
| [`doc-editor-preview`](./doc-editor-preview.html) | 2026-08-07 近期 | 8 KB |
| [`rich-content-card-editor`](./rich-content-card-editor.html) | 2026-08-06 近期 | 8 KB |
| [`markdown-fullscreen-editor`](./markdown-fullscreen-editor.html) | 2026-07-26 | 21 KB |
| [`markdown-editor-flow`](./markdown-editor-flow.html) | 2026-07-26 | 18 KB |
| [`regex-replace`](./regex-replace.html) | 2026-07-22 | 16 KB |
| [`qrcode-html-strip`](./qrcode-html-strip.html) | 2026-07-22 | 13 KB |
| [`P2-markdown-preview`](./P2-markdown-preview.html) | 2026-07-22 | 30 KB |
| [`markdown-preview`](./markdown-preview.html) | 2026-07-22 | 23 KB |
| [`diff-dialog`](./diff-dialog.html) | 2026-07-22 | 14 KB |
| [`代码高亮预览`](./%E4%BB%A3%E7%A0%81%E9%AB%98%E4%BA%AE%E9%A2%84%E8%A7%88.html) | 2026-07-01 | 23 KB |

### 同步与更新（34）

*设备同步/配对/冲突，以及自动更新、发版说明弹框、版本徽标。*

| 设计稿 | 入库 | 体量 |
|---|---|---|
| [`远程电脑最新设计稿`](./%E8%BF%9C%E7%A8%8B%E7%94%B5%E8%84%91%E6%9C%80%E6%96%B0%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | — | 8 KB |
| [`远程电脑-质感重做-设计稿`](./%E8%BF%9C%E7%A8%8B%E7%94%B5%E8%84%91-%E8%B4%A8%E6%84%9F%E9%87%8D%E5%81%9A-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | — | 68 KB |
| [`远程电脑-设备行布局-设计稿`](./%E8%BF%9C%E7%A8%8B%E7%94%B5%E8%84%91-%E8%AE%BE%E5%A4%87%E8%A1%8C%E5%B8%83%E5%B1%80-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | — | 78 KB |
| [`远程电脑-独立工作台窗口-布局设计稿`](./%E8%BF%9C%E7%A8%8B%E7%94%B5%E8%84%91-%E7%8B%AC%E7%AB%8B%E5%B7%A5%E4%BD%9C%E5%8F%B0%E7%AA%97%E5%8F%A3-%E5%B8%83%E5%B1%80%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | — | 25 KB |
| [`远程电脑-工作台设计稿-v4-质感版`](./%E8%BF%9C%E7%A8%8B%E7%94%B5%E8%84%91-%E5%B7%A5%E4%BD%9C%E5%8F%B0%E8%AE%BE%E8%AE%A1%E7%A8%BF-v4-%E8%B4%A8%E6%84%9F%E7%89%88.html) | — | 82 KB |
| [`远程电脑-工作台设计稿-v3-布局参照版`](./%E8%BF%9C%E7%A8%8B%E7%94%B5%E8%84%91-%E5%B7%A5%E4%BD%9C%E5%8F%B0%E8%AE%BE%E8%AE%A1%E7%A8%BF-v3-%E5%B8%83%E5%B1%80%E5%8F%82%E7%85%A7%E7%89%88.html) | — | 76 KB |
| [`远程电脑-工作台设计稿-v2-规范落地版`](./%E8%BF%9C%E7%A8%8B%E7%94%B5%E8%84%91-%E5%B7%A5%E4%BD%9C%E5%8F%B0%E8%AE%BE%E8%AE%A1%E7%A8%BF-v2-%E8%A7%84%E8%8C%83%E8%90%BD%E5%9C%B0%E7%89%88.html) | — | 45 KB |
| [`远程电脑-会话页布局重构-方案`](./%E8%BF%9C%E7%A8%8B%E7%94%B5%E8%84%91-%E4%BC%9A%E8%AF%9D%E9%A1%B5%E5%B8%83%E5%B1%80%E9%87%8D%E6%9E%84-%E6%96%B9%E6%A1%88.html) | — | 41 KB |
| [`远程电脑-一次性协助-方案C-设计稿`](./%E8%BF%9C%E7%A8%8B%E7%94%B5%E8%84%91-%E4%B8%80%E6%AC%A1%E6%80%A7%E5%8D%8F%E5%8A%A9-%E6%96%B9%E6%A1%88C-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | — | 37 KB |
| [`远程电脑-v5-沉浸工作台-设计稿`](./%E8%BF%9C%E7%A8%8B%E7%94%B5%E8%84%91-v5-%E6%B2%89%E6%B5%B8%E5%B7%A5%E4%BD%9C%E5%8F%B0-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | — | 69 KB |
| [`远程电脑-UI优化-五项-设计稿`](./%E8%BF%9C%E7%A8%8B%E7%94%B5%E8%84%91-UI%E4%BC%98%E5%8C%96-%E4%BA%94%E9%A1%B9-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | — | 78 KB |
| [`远程电脑-配对流程重做-设计稿`](./%E8%BF%9C%E7%A8%8B%E7%94%B5%E8%84%91-%E9%85%8D%E5%AF%B9%E6%B5%81%E7%A8%8B%E9%87%8D%E5%81%9A-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-18 近期 | 66 KB |
| [`远程设备多档在线状态-设计稿`](./%E8%BF%9C%E7%A8%8B%E8%AE%BE%E5%A4%87%E5%A4%9A%E6%A1%A3%E5%9C%A8%E7%BA%BF%E7%8A%B6%E6%80%81-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-17 近期 | 5 KB |
| [`远程电脑-交互精简-B方案-设计稿`](./%E8%BF%9C%E7%A8%8B%E7%94%B5%E8%84%91-%E4%BA%A4%E4%BA%92%E7%B2%BE%E7%AE%80-B%E6%96%B9%E6%A1%88-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-17 近期 | 40 KB |
| [`远程电脑-设计稿`](./%E8%BF%9C%E7%A8%8B%E7%94%B5%E8%84%91-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-15 近期 | 25 KB |
| [`同步设备-暂停启用-设计稿`](./%E5%90%8C%E6%AD%A5%E8%AE%BE%E5%A4%87-%E6%9A%82%E5%81%9C%E5%90%AF%E7%94%A8-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-14 近期 | 15 KB |
| [`剪贴板同步-挪到标签筛选行`](./%E5%89%AA%E8%B4%B4%E6%9D%BF%E5%90%8C%E6%AD%A5-%E6%8C%AA%E5%88%B0%E6%A0%87%E7%AD%BE%E7%AD%9B%E9%80%89%E8%A1%8C.html) | 2026-09-14 近期 | 22 KB |
| [`剪贴板同步-优化设计稿`](./%E5%89%AA%E8%B4%B4%E6%9D%BF%E5%90%8C%E6%AD%A5-%E4%BC%98%E5%8C%96%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-14 近期 | 27 KB |
| [`update-notes-dialog-plan-C`](./update-notes-dialog-plan-C.html) | 2026-09-08 近期 | 23 KB |
| [`update-notes-dialog-cjk-wrap-fix`](./update-notes-dialog-cjk-wrap-fix.html) | 2026-09-08 近期 | 17 KB |
| [`PastePanda-局域网同步-附近设备配对-设计稿`](./PastePanda-%E5%B1%80%E5%9F%9F%E7%BD%91%E5%90%8C%E6%AD%A5-%E9%99%84%E8%BF%91%E8%AE%BE%E5%A4%87%E9%85%8D%E5%AF%B9-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-06 近期 | 17 KB |
| [`sync-pairing-mockup`](./sync-pairing-mockup.html) | 2026-09-04 近期 | 8 KB |
| [`sync-devices-mockup`](./sync-devices-mockup.html) | 2026-09-04 近期 | 7 KB |
| [`sync-conflicts-mockup`](./sync-conflicts-mockup.html) | 2026-09-04 近期 | 6 KB |
| [`update-notes-dialog-fix-B`](./update-notes-dialog-fix-B.html) | 2026-09-03 近期 | 10 KB |
| [`PastePanda-版本快照-设计稿`](./PastePanda-%E7%89%88%E6%9C%AC%E5%BF%AB%E7%85%A7-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-01 近期 | 13 KB |
| [`whatsnew-routeC`](./whatsnew-routeC.html) | 2026-08-19 近期 | 14 KB |
| [`update-notes-dialog`](./update-notes-dialog.html) | 2026-07-23 | 35 KB |
| [`source-badge`](./source-badge.html) | 2026-07-07 | 16 KB |
| [`update-dialog`](./update-dialog.html) | 2026-07-05 | 19 KB |
| [`version-badge-themes`](./version-badge-themes.html) | 2026-07-03 | 6 KB |
| [`version-badge-preview`](./version-badge-preview.html) | 2026-07-03 | 12 KB |
| [`version-badge-designs`](./version-badge-designs.html) | 2026-07-03 | 20 KB |
| [`version-badge-all-themes`](./version-badge-all-themes.html) | 2026-07-03 | 23 KB |

### 主窗口与导航（76）

*主界面骨架：侧栏、顶栏、标签/分组、搜索、时间线、卡片、悬浮卡、托盘、详情弹窗。*

| 设计稿 | 入库 | 体量 |
|---|---|---|
| [`2026-ThreeUI借鉴-GlassDock与统计仪表-设计稿`](./2026-ThreeUI%E5%80%9F%E9%89%B4-GlassDock%E4%B8%8E%E7%BB%9F%E8%AE%A1%E4%BB%AA%E8%A1%A8-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | — | 28 KB |
| [`PastePanda-托盘右键菜单-UI优化-设计稿-v2`](./PastePanda-%E6%89%98%E7%9B%98%E5%8F%B3%E9%94%AE%E8%8F%9C%E5%8D%95-UI%E4%BC%98%E5%8C%96-%E8%AE%BE%E8%AE%A1%E7%A8%BF-v2.html) | 2026-09-17 近期 | 69 KB |
| [`查找悬浮卡-移动交互三方案`](./%E6%9F%A5%E6%89%BE%E6%82%AC%E6%B5%AE%E5%8D%A1-%E7%A7%BB%E5%8A%A8%E4%BA%A4%E4%BA%92%E4%B8%89%E6%96%B9%E6%A1%88.html) | 2026-09-14 近期 | 27 KB |
| [`2026-主窗口视觉升级-对照稿`](./2026-%E4%B8%BB%E7%AA%97%E5%8F%A3%E8%A7%86%E8%A7%89%E5%8D%87%E7%BA%A7-%E5%AF%B9%E7%85%A7%E7%A8%BF.html) | 2026-09-10 近期 | 35 KB |
| [`2026-主窗口一比一对照-设计稿`](./2026-%E4%B8%BB%E7%AA%97%E5%8F%A3%E4%B8%80%E6%AF%94%E4%B8%80%E5%AF%B9%E7%85%A7-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-10 近期 | 44 KB |
| [`顶栏名位微动效-设计稿`](./%E9%A1%B6%E6%A0%8F%E5%90%8D%E4%BD%8D%E5%BE%AE%E5%8A%A8%E6%95%88-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-06 近期 | 29 KB |
| [`PastePanda-顶栏模式专属按钮组-设计稿`](./PastePanda-%E9%A1%B6%E6%A0%8F%E6%A8%A1%E5%BC%8F%E4%B8%93%E5%B1%9E%E6%8C%89%E9%92%AE%E7%BB%84-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-06 近期 | 17 KB |
| [`PastePanda-内容区视图切换动画-设计稿`](./PastePanda-%E5%86%85%E5%AE%B9%E5%8C%BA%E8%A7%86%E5%9B%BE%E5%88%87%E6%8D%A2%E5%8A%A8%E7%94%BB-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-09-05 近期 | 9 KB |
| [`wide-screen-cardlist`](./wide-screen-cardlist.html) | 2026-09-04 近期 | 10 KB |
| [`PastePanda-顶栏三模式-设计稿`](./PastePanda-%E9%A1%B6%E6%A0%8F%E4%B8%89%E6%A8%A1%E5%BC%8F-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-31 近期 | 39 KB |
| [`PastePanda-反馈面板-设计稿`](./PastePanda-%E5%8F%8D%E9%A6%88%E9%9D%A2%E6%9D%BF-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-23 近期 | 14 KB |
| [`sponsor-card`](./sponsor-card.html) | 2026-08-20 近期 | 8 KB |
| [`toast-error-copy-mockup`](./toast-error-copy-mockup.html) | 2026-08-15 近期 | 15 KB |
| [`file-detail-A-redesign-mockup`](./file-detail-A-redesign-mockup.html) | 2026-08-15 近期 | 26 KB |
| [`v6.10-交互革命-设计稿`](./v6.10-%E4%BA%A4%E4%BA%92%E9%9D%A9%E5%91%BD-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) | 2026-08-12 近期 | 17 KB |
| [`pastepanda-pizza-chart`](./pastepanda-pizza-chart.html) | 2026-08-10 近期 | 8 KB |
| [`ui-1to1-restoration-draft`](./ui-1to1-restoration-draft.html) | 2026-08-06 近期 | 92 KB |
| [`search-box-unify`](./search-box-unify.html) | 2026-08-06 近期 | 16 KB |
| [`tag-manager`](./tag-manager.html) | 2026-07-30 | 45 KB |
| [`分组标签系统`](./%E5%88%86%E7%BB%84%E6%A0%87%E7%AD%BE%E7%B3%BB%E7%BB%9F.html) | 2026-07-06 | 34 KB |
| [`main-page-full`](./main-page-full.html) | 2026-07-06 | 36 KB |
| [`card-tag-hover-expand`](./card-tag-hover-expand.html) | 2026-07-06 | 13 KB |
| [`card-optimization`](./card-optimization.html) | 2026-07-06 | 17 KB |
| [`card-optimization-c`](./card-optimization-c.html) | 2026-07-06 | 23 KB |
| [`card-optimization-c-full`](./card-optimization-c-full.html) | 2026-07-06 | 43 KB |
| [`card-optimization-b`](./card-optimization-b.html) | 2026-07-06 | 17 KB |
| [`card-optimization-a`](./card-optimization-a.html) | 2026-07-06 | 20 KB |
| [`vertical-timeline-variants`](./vertical-timeline-variants.html) | 2026-07-05 | 33 KB |
| [`ux-improvements-preview`](./ux-improvements-preview.html) | 2026-07-05 | 30 KB |
| [`TopBar优化方案A`](./TopBar%E4%BC%98%E5%8C%96%E6%96%B9%E6%A1%88A.html) | 2026-07-05 | 19 KB |
| [`TopBar-方案A-精简按钮`](./TopBar-%E6%96%B9%E6%A1%88A-%E7%B2%BE%E7%AE%80%E6%8C%89%E9%92%AE.html) | 2026-07-05 | 53 KB |
| [`TopBar-480px对比`](./TopBar-480px%E5%AF%B9%E6%AF%94.html) | 2026-07-05 | 21 KB |
| [`timeline-solution-compare`](./timeline-solution-compare.html) | 2026-07-05 | 34 KB |
| [`timeline-optimizations`](./timeline-optimizations.html) | 2026-07-05 | 34 KB |
| [`timeline-optimizations-full`](./timeline-optimizations-full.html) | 2026-07-05 | 57 KB |
| [`timeline-node-design`](./timeline-node-design.html) | 2026-07-05 | 28 KB |
| [`time-separator-optimization`](./time-separator-optimization.html) | 2026-07-05 | 25 KB |
| [`sidebar-redesign`](./sidebar-redesign.html) | 2026-07-05 | 23 KB |
| [`p0-sidebar-style-compare`](./p0-sidebar-style-compare.html) | 2026-07-05 | 26 KB |
| [`p0-sidebar-drawer`](./p0-sidebar-drawer.html) | 2026-07-05 | 28 KB |
| [`p0-sidebar-below-topbar`](./p0-sidebar-below-topbar.html) | 2026-07-05 | 33 KB |
| [`p0-plan-e-window-resize`](./p0-plan-e-window-resize.html) | 2026-07-05 | 30 KB |
| [`p0-plan-e-vs-f-compare`](./p0-plan-e-vs-f-compare.html) | 2026-07-05 | 13 KB |
| [`p0-plan-c-dropdown-tags`](./p0-plan-c-dropdown-tags.html) | 2026-07-05 | 37 KB |
| [`p0-plan-ab-push-sidebar`](./p0-plan-ab-push-sidebar.html) | 2026-07-05 | 29 KB |
| [`p0-groups-tags`](./p0-groups-tags.html) | 2026-07-05 | 50 KB |
| [`p0-auto-source-sidebar`](./p0-auto-source-sidebar.html) | 2026-07-05 | 27 KB |
| [`main-page-ux-preview`](./main-page-ux-preview.html) | 2026-07-05 | 46 KB |
| [`hover-mode-selector`](./hover-mode-selector.html) | 2026-07-05 | 26 KB |
| [`hover-drawer-schemes`](./hover-drawer-schemes.html) | 2026-07-05 | 14 KB |
| [`back-to-top-v2-preview`](./back-to-top-v2-preview.html) | 2026-07-05 | 16 KB |
| [`back-to-top-preview`](./back-to-top-preview.html) | 2026-07-05 | 13 KB |
| [`b1-timeline-full-preview`](./b1-timeline-full-preview.html) | 2026-07-05 | 27 KB |
| [`hover-plan-c-popover`](./hover-plan-c-popover.html) | 2026-07-03 | 25 KB |
| [`hover-plan-a-overlay`](./hover-plan-a-overlay.html) | 2026-07-03 | 42 KB |
| [`hover-plan-1-vs-plan-3`](./hover-plan-1-vs-plan-3.html) | 2026-07-03 | 28 KB |
| [`hover-drawer-preview`](./hover-drawer-preview.html) | 2026-07-03 | 22 KB |
| [`详情弹窗统一预览`](./%E8%AF%A6%E6%83%85%E5%BC%B9%E7%AA%97%E7%BB%9F%E4%B8%80%E9%A2%84%E8%A7%88.html) | 2026-07-01 | 29 KB |
| [`文字详情优化预览`](./%E6%96%87%E5%AD%97%E8%AF%A6%E6%83%85%E4%BC%98%E5%8C%96%E9%A2%84%E8%A7%88.html) | 2026-07-01 | 25 KB |
| [`UI_redesign_prototype`](./UI_redesign_prototype.html) | 2026-07-01 | 42 KB |
| [`tray_popup_preview`](./tray_popup_preview.html) | 2026-07-01 | 9 KB |
| [`tray-popup-preview`](./tray-popup-preview.html) | 2026-07-01 | 15 KB |
| [`topbar-icons-redesign`](./topbar-icons-redesign.html) | 2026-07-01 | 7 KB |
| [`today-placement`](./today-placement.html) | 2026-07-01 | 9 KB |
| [`tab-ui-mockup`](./tab-ui-mockup.html) | 2026-07-01 | 17 KB |
| [`tab-alignment-fix`](./tab-alignment-fix.html) | 2026-07-01 | 15 KB |
| [`stats-panel-designs`](./stats-panel-designs.html) | 2026-07-01 | 30 KB |
| [`stats-layout`](./stats-layout.html) | 2026-07-01 | 7 KB |
| [`search-icon-fix`](./search-icon-fix.html) | 2026-07-01 | 7 KB |
| [`search-filter-layout`](./search-filter-layout.html) | 2026-07-01 | 11 KB |
| [`popup`](./popup.html) | 2026-07-01 | 0 KB |
| [`padding-fix-options`](./padding-fix-options.html) | 2026-07-01 | 12 KB |
| [`extract-snippets-redesign`](./extract-snippets-redesign.html) | 2026-07-01 | 47 KB |
| [`design-proposals`](./design-proposals.html) | 2026-07-01 | 27 KB |
| [`clipboard-beautify-options`](./clipboard-beautify-options.html) | 2026-07-01 | 28 KB |
| [`card-contextmenu-preview`](./card-contextmenu-preview.html) | 2026-07-01 | 21 KB |

> 「近期」= 近 45 天内入库。其中尚未提交 git 的稿子共 14 份。

---

_共 317 份设计稿。重新生成：`npm run gen:design-index`_
