# 远程电脑工作台 · UX / 交互 / 可访问性审查报告

> 审查范围：`design/远程电脑-质感重做-设计稿.html` + `src/components/rc/` 全部 22 个文件 + 全局 Toast/ConfirmDialog。
> 方法：源码逐文件审读（file:line 均已核对）+ 对比度按 WCAG 公式实测 + ui-ux-pro-max 规范库检索（toast 播报、焦点陷阱、目标尺寸三条均有据可查）。
> 日期：2026-09-18

## 结论先行

交互与状态反馈是强项（按钮真 `<button>`、busy 全链路禁用、失败回滚、live region 纪律都做对了）；短板集中在**屏幕阅读器可达性**：Toast 全应用静默、入站申请不播报、对话框无 dialog 语义。共 3 项 P0、4 项 P1、7 项 P2。

---

## P0（对辅助技术用户功能性致盲）

### 1. Toast 无 live region —— 全应用错误/成功反馈对屏幕阅读器静默
- **位置**：`src/components/Toast.tsx:161`（`.toastContainer`）及所有 toast item。
- **影响**：所有 `toast(msg, "error")` 的失败反馈（rc 的禁止/忘记/改名失败、剪贴板自动同步失败等）SR 用户完全收不到；成功确认同样静默。这是全应用级缺陷，rc 只是重灾区。
- **修复**：容器加 `role="status" aria-live="polite"`；`type==="error"` 的条目加 `role="alert"`（或单独 assertive region）。live region 容器必须常驻挂载、子项动态插入才生效。

### 2. 入站申请确认条（最高危操作）无任何播报
- **位置**：`src/components/rc/RcJoinRequests.tsx:23`（`.joinGlobal`）、`RcOverlay.tsx:157`。
- **影响**：有人申请远程本机时，SR 用户既收不到 toast（P0-1 叠加）、确认条出现也无公告，只能靠 Tab 乱摸。而「同意远程」是全产品最高危操作。
- **修复**：`.joinGlobal` 容器加 `role="alert"`，或标题行加 `aria-live="assertive"`；一次播报到位（设备名 + 能力）。

### 3. ConfirmDialog 无 dialog 语义、无焦点陷阱
- **位置**：`src/components/ConfirmDialog.tsx`（Escape 有 :44、autoFocus 取消钮有 :87——这两处是对的）。
- **影响**：缺 `role="dialog" aria-modal="true"`，SR 不宣告进入了对话框；Tab 可以跑出遮罩到底层被挡住的控件上，键盘用户会在"看不见的界面"里操作。
- **修复**：加 `role="dialog" aria-modal="true" aria-labelledby aria-describedby`；Tab 在首尾控件间循环；关闭后焦点还原到触发元素。

## P1（键盘用户路径受损 / 落地即违规）

### 4. 设备行整行可点但键盘不可达
- **位置**：`src/components/rc/RcDeviceRow.tsx:116-138`（`<div onClick>`，无 role/tabIndex/onKeyDown）。
- **影响**：鼠标用户的主路径（点行=发起）对键盘用户不存在；SR 把整行读成普通文本，不知道可点。行内 26px 图标按钮是唯一可达入口。
- **修复**：加 `role="button"` `tabIndex={0}`，onKeyDown 处理 Enter/Space（复用行点击逻辑，含 menuOpen/editing 收起分支）；行 hover 样式同步到 `:focus-visible`。

### 5. 设计稿次级文字对比度不达标（落地即回退）
- **位置**：设计稿 `.metaSub` #7C8CA0 = **3.43:1**、`.secLabel` #6E8095 = **4.05:1**（均 < 4.5:1）。当前实现用 `var(--text-muted)`（#627083 = 4.56:1）是对的。
- **影响**：照稿落地会把主题里已修过一轮的对比度（theme.css:242-243 注释记录了 3.26→4.56 的修复）又退回去。
- **修复**：落地时次级文字一律接 `var(--text-muted)` / `var(--text-secondary)`；设计稿中两处色值同步替换。另：稿内 deskBar 文字 10px 偏小，统一 ≥10.5px（仅 HUD）。

### 6. 下拉与菜单键盘支持不完整
- **位置**：`RcDropdown.tsx`（无 Esc 关闭、无方向键；Esc 只在 RcDeviceRow:90-92 管设备菜单）；`RcDeviceMenu.tsx:53-71`（无 `role="menu"`/`menuitem`、触发钮无 `aria-haspopup`、无方向键循环、关闭后焦点不回触发钮）。
- **影响**：键盘用户只能靠 Tab 逐项穿菜单，Esc 行为不一致（设备菜单能关、画质下拉不能关）。
- **修复**：两处统一——Esc 关闭 + 焦点回触发钮；↑↓ 在项间循环；`RcDeviceMenu` 加 `role="menu"` + 项 `role="menuitem"`（分组标签 `role="presentation"`）；触发钮补 `aria-haspopup="menu"`。

### 7. 画面区键盘捕获无 SR 提示、canvas 无替代文本
- **位置**：`RcSessionView.tsx:169-187`（fakeScreen `tabIndex=0` 无 aria-label）、`RcScreenCanvas.tsx:57`（canvas 无 label）。
- **影响**：SR 用户 Tab 进画面区会被捕获键盘（可控会话），无任何预先告知；Esc 可释放是好的，但用户不知道这个契约。
- **修复**：fakeScreen 加 `role="application"`（可控时）+ `aria-label="远程画面：聚焦后键盘与滚轮将转发给对方，按 Esc 释放"`；view-only 时 label 说明「仅观看」。

## P2（打磨项）

| # | 问题 | 位置 | 建议 |
|---|---|---|---|
| 8 | 🔔 emoji 作视觉主标记（SR 读「铃铛」，且与 RcEmptyGuide 已定的 emoji→lucide 纪律冲突） | RcJoinRequests.tsx:24、RcOverlay.tsx:173 | 换 lucide `Bell` + `aria-hidden` |
| 9 | pill 选中态只靠 class，SR 听不出当前档 | RcQualityBar.tsx:86,100 | 加 `aria-pressed={选中}` |
| 10 | 「画质已保存/失败已恢复」反馈无播报 | RcQualityBar.tsx:107（`.fb` span） | 加 `role="status"` |
| 11 | RcDropdown 菜单项 `role="option"` 挂在 button 上、listbox 非受控焦点容器 | RcDropdown.tsx:58-74 | 改 `role="menu"`+`menuitemradio`+`aria-checked`，与 P1-6 一并做 |
| 12 | 26px 图标按钮是 WCAG 2.2 AA（24px）贴线通过，无余量 | RemoteComputer.module.css（icoBtn） | 冻结下限 26px，禁止再降；行间 gap 6px 保持 |
| 13 | RcOverlay 出站横幅有 `role="status"` 但被控横幅的容器无 landmark | RcOverlay.tsx:120 | 统一容器 `role="region" aria-label="远程会话状态"` |
| 14 | Windows 高对比/forced-colors 模式未适配（全局 backlog，玻璃质感首当其冲） | 全局 | `@media (forced-colors: active)` 回退实色边框 |

## 做对了的（保持，勿在重构中丢掉）

- 图标按钮 aria-label + title 成对纪律（RcDeviceRow.tsx:16-22、RcDeviceMenu.tsx:54-56）。
- 开关 `role="switch"` + aria-checked + 轨道内「开/关」文字（RcSelfToggleRow.tsx:49-63，SC 1.4.1 双保险）。
- live region 纪律：被控状态进 live region、每秒计时器移出（RcControlBanner.tsx:48-61）——教科书级。
- busy 全链路禁用 + 失败才收菜单/编辑框 + 失败回滚画质档。
- 全局 `:focus-visible` 零特异性兜底环（globals.css:103-113），主题 muted 色已有实测修复记录（theme.css:242-243, 379-380）。
- 入站申请不设全局快捷键（B6，防 Enter 撞上同意被控）——正确的防御式决策。

## 建议实施顺序

1. **第一批（一次提交，纯前端）**：P0-1 Toast live region、P0-2 入站申请播报、P0-3 ConfirmDialog 语义+焦点陷阱 —— 三处都在共享层，收益覆盖全应用。
2. **第二批**：P1-4 设备行键盘化、P1-6 菜单/下拉键盘统一 —— rc 模块内交互收口。
3. **第三批（随质感稿落地一起）**：P1-5 对比度 token 化、P1-7 画面区 aria、全部 P2。
