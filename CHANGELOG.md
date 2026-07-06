# Changelog

PastePanda 版本更新日志。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

## [5.0.126] - 2026-07-06

### 修复
- 修复窗口状态恢复 — window-state 插件从 .plugin() 链移至 .setup() 闭包，确保先恢复后显示
- 修复侧边栏开关时窗口宽度漂移问题

### 变更
- 侧边栏宽度 220px → 180px，内容区更宽敞
- 侧边栏开关改为纯 CSS transition，窗口宽度不再随侧边栏变化

### 重构
- 移除 Rust animate_window_width 命令及相关代码（~70行）
- 简化 App.tsx 侧边栏切换逻辑，删除 isTogglingRef/logicalWidthRef/初始化宽度同步

## [5.0.118] - 2026-07-05

### 新功能
- 侧边栏改版 — macOS Finder 风格，独立背景色，来源分组带颜色标识

### 变更
- 优化更新检查与状态展示，新增侧边栏设计稿和方案文档

### 修复
- FAB 依次粘贴悬浮按钮移至卡片面板内，侧边栏打开时不再遮挡

## [5.0.117] - 2026-07-05

### 变更
- 参考 CC Switch 架构全面优化
- CSP connect-src 改为 https: 通配模式

### 修复
- 修复自动更新检查失败 — CSP 缺失 GitHub 域名
- 修复 BackToTop 回到顶部按钮点击失效问题

## [5.0.113] - 2026-07-04

### 变更
- SettingsDialog 重构为子组件模式，优化各组件代码

### 修复
- 添加缺失的 settings 子组件文件，修复 CI 构建报错

## [5.0.112] - 2026-07-04

### 变更
- 移除快捷键悬浮按钮并优化布局间距
- 引入 Lenis 平滑滚动库替换自实现滚动引擎

### 重构
- Tab 计数改为后端查询 + 30s 缓存，移除前端增量维护

## [5.0.111] - 2026-07-03

### 新功能
- Timeline Mini 模式优化 — 方案 C+D 组合
- 设置页面滚动隐藏 Tab Bar + Tab 切换动画

### 变更
- 时间轴多项优化 + 节点间距自动对齐

### 重构
- 样式模块化 — 从全局 CSS 拆分为组件级 CSS Module
