# AI 智能分类 — 详细实施方案

> 版本: v1.0  
> 日期: 2026-07-06  
> 优先级: P1 ⭐⭐⭐  
> 预估工时: ~1.5 天

---

## 一、方案概述

### 核心思路

在 Rust 后端实现纯本地规则引擎，剪贴板内容被捕获后立即自动分类，将识别到的类别作为 **自动标签（Auto Tag）** 自动写入 `history_tags` 关联表。自动标签与用户手动标签共存在同一标签系统中，通过 `Tag` 结构体新增的 `source` 字段区分来源（`"auto"` / `"manual"`），UI 上自动标签用虚线边框 + AI 图标区分显示。

### 为什么与现有标签系统统一？

- ✅ 复用现有标签 CRUD、筛选、展示全部基础设施
- ✅ 自动标签和手动标签可以混合筛选（如"代码 + 手动标签-项目A"）
- ✅ 用户可以一键"确认"自动标签转为人造标签（改 `source` 字段即可）
- ✅ 减少前端代码量：不需要单独的 `auto_tags` 字段和独立筛选逻辑

---

## 二、分类维度（10 类）

| 序号 | 类别 | 标签名 | 默认颜色 | 识别规则 |
|------|------|--------|----------|----------|
| 1 | 代码 | `代码` | `#6366F1` | 编程语言关键字密度 + 语法结构 |
| 2 | 链接 | `链接` | `#06B6D4` | URL 正则 |
| 3 | JSON | `JSON` | `#F59E0B` | 合法 JSON 格式 |
| 4 | 配置文件 | `配置文件` | `#10B981` | YAML/TOML/INI/ENV 格式 |
| 5 | 日志 | `日志` | `#6B7280` | 时间戳前缀 + 级别标识 |
| 6 | 表格数据 | `表格` | `#8B5CF6` | CSV/TSV 格式 |
| 7 | 命令行 | `命令行` | `#EF4444` | 命令 + 参数结构 |
| 8 | 密钥/Token | `密钥` | `#DC2626` | Base64 编码 + 长度特征 |
| 9 | 数字 | `数字` | `#14B8A6` | 纯数字内容 |
| 10 | 纯文本 | `纯文本` | `#9CA3AF` | 以上均不匹配的默认分类 |

### 代码子类（代码检测通过后进一步识别语言）

| 语言 | 识别特征 |
|------|----------|
| JavaScript/TypeScript | `function`, `const`, `let`, `=>`, `import`, `export` |
| Python | `def `, `import `, `print(`, `self.`, 缩进 + 冒号 |
| Rust | `fn `, `let `, `mut`, `impl`, `use `, `pub` |
| Java | `public class`, `private`, `void`, `System.out` |
| Go | `func `, `package `, `defer`, `go routine` |
| SQL | `SELECT`, `FROM`, `WHERE`, `CREATE TABLE`, `INSERT INTO` |
| HTML/XML | `<html`, `<div`, `</`, 标签结构 |
| CSS | `{ ` + 属性:值 模式, `@media`, `@keyframes` |
| Shell | `#!/bin/`, `if [`, `echo`, `chmod`, 以 `$` 开头 |
| 通用代码 | 默认（无法识别语言时） |

**语言标签命名规则**：标签名 = 语言名（如 `JavaScript`），颜色 = 语言对应色。

---

## 三、数据库设计

### 3.1 修改 `tags` 表

```sql
-- 新增 source 字段，区分自动/手动标签
ALTER TABLE tags ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
-- source 取值: "manual" | "auto"
```

### 3.2 自动标签种子数据

首次启动时自动插入 10 个类别标签 + ~10 个语言标签（如果不存在），标记 `source = 'auto'`。

```sql
INSERT OR IGNORE INTO tags (id, name, color, source, created_at) VALUES
  ('auto-code',      '代码',   '#6366F1', 'auto', '2026-01-01T00:00:00'),
  ('auto-link',      '链接',   '#06B6D4', 'auto', '2026-01-01T00:00:00'),
  ('auto-json',      'JSON',   '#F59E0B', 'auto', '2026-01-01T00:00:00'),
  ('auto-config',    '配置文件', '#10B981', 'auto', '2026-01-01T00:00:00'),
  ('auto-log',       '日志',   '#6B7280', 'auto', '2026-01-01T00:00:00'),
  ('auto-table',     '表格',   '#8B5CF6', 'auto', '2026-01-01T00:00:00'),
  ('auto-command',   '命令行',  '#EF4444', 'auto', '2026-01-01T00:00:00'),
  ('auto-secret',    '密钥',   '#DC2626', 'auto', '2026-01-01T00:00:00'),
  ('auto-number',    '数字',   '#14B8A6', 'auto', '2026-01-01T00:00:00'),
  ('auto-plaintext', '纯文本',  '#9CA3AF', 'auto', '2026-01-01T00:00:00');
```

### 3.3 不需要新表

自动标签的结果直接写入 `history_tags` 表（与手动标签共享同一张关联表），不需要新建 `classification_results` 表。标签来源通过 `tags.source` 字段区分。

---

## 四、Rust 后端实现

### 4.1 新增文件：`src-tauri/src/content_classifier.rs`

```
src-tauri/src/content_classifier.rs
├── ClassificationRule        — 分类规则结构体
├── ContentClassifier         — 分类器主结构体
│   ├── new()                 — 初始化，编译所有正则规则
│   ├── classify(text)        — 入口：对文本分类，返回标签名列表
│   ├── detect_type(text)     — 检测主类别
│   └── detect_language(text) — 检测代码语言（仅在 detect_type=代码 时调用）
```

#### 分类流程

```
classify(text)
  │
  ├─ 1. 预处理：trim，去首尾空白
  ├─ 2. 快速判断（无正则，零开销）：
  │     ├─ 纯数字？ → 返回 ["数字"]
  │     ├─ 空文本？ → 返回 ["纯文本"]
  │     └─ 超短文本(<10字)？ → 返回 ["纯文本"]
  │
  ├─ 3. 正则链式匹配（按优先级）：
  │     ├─ URL 正则命中？ → 返回 ["链接"]
  │     ├─ 合法 JSON？ → 返回 ["JSON"]
  │     ├─ YAML/TOML/INI？ → 返回 ["配置文件"]
  │     ├─ CSV/TSV？ → 返回 ["表格"]
  │     ├─ 命令行格式？ → 返回 ["命令行"]
  │     ├─ 日志格式？ → 返回 ["日志"]
  │     ├─ Base64 密钥？ → 返回 ["密钥"]
  │     └─ 代码关键字密度高？ → detect_language() → 返回 ["代码", "{语言}"]
  │
  └─ 4. 默认：返回 ["纯文本"]
```

#### 各规则详细设计

**1. 链接检测**
```rust
// URL 正则（覆盖 http/https/ftp/file/等协议）
static URL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(https?|ftp|file|ws|wss)://[^\s]+$").unwrap()
});
// 命中条件：文本整体是 URL（不是包含 URL）
```

**2. JSON 检测**
```rust
// 先快速检查首字符 { 或 [，再 serde_json::from_str 解析
fn is_json(text: &str) -> bool {
    let trimmed = text.trim();
    ((trimmed.starts_with('{') && trimmed.ends_with('}')) ||
     (trimmed.starts_with('[') && trimmed.ends_with(']')))
    && serde_json::from_str::<serde_json::Value>(text).is_ok()
}
```

**3. 配置文件检测**
```rust
// YAML: 包含 `key: value` 模式的行占比 > 60%
// TOML: 包含 `[section]` 或 `key = "value"`
// INI:  包含 `[section]` + `key=value`
// ENV:  包含 `KEY=VALUE` 模式的行占比 > 80%
```

**4. 表格数据检测**
```rust
// CSV: 多行，逗号/制表符分隔，每行列数一致
// 检查：前 5 行每行列数相同，且至少 2 列
```

**5. 命令行检测**
```rust
// 特征：以常见命令开头（git/docker/npm/cargo/python/...）
// 格式：`命令 子命令 --flag value` 结构
// 常用命令列表: git, docker, npm, yarn, cargo, python, node, kubectl, curl, wget, ssh, ...
```

**6. 日志检测**
```rust
// 特征：每行以时间戳开头
// 格式: "2024-01-01 12:00:00 [ERROR] ..."
// 或: "[2024-01-01T12:00:00] ..."
// 或: "01/01 12:00:00 INFO ..."
// 检查：前几行是否包含时间戳 + 日志级别（DEBUG/INFO/WARN/ERROR/FATAL）
```

**7. 密钥/Token 检测**
```rust
// JWT Token: 三段 Base64URL 用 `.` 分隔，长度 > 50
// AWS Key: 以 "AKIA" 开头
// GitHub Token: 以 "ghp_" 开头
// 通用 Base64: 仅包含 [A-Za-z0-9+/=]，长度 > 30
// 注意：为避免误判，需排除明显的文本内容
```

**8. 代码检测（关键字密度法）**
```rust
// 统计代码特征行数占比：
// - 包含 `{ } ;` 等语法符号
// - 包含编程语言关键字（if/for/while/return/function/class/def/fn/...）
// - 行首有缩进（空格/Tab）
// 阈值：代码特征行 > 总行数的 40%
```

**9. 代码语言识别（关键字密度 + 语法特征）**
```rust
// 对每种语言计算得分，取最高分：
// JavaScript: "function" + "const" + "=>" + "import" + "export"
// Python:     "def " + "import " + "self." + ": "结尾行 + 缩进模式
// Rust:       "fn " + "let mut" + "impl" + "pub " + "use "
// SQL:        "SELECT" + "FROM" + "WHERE" + "CREATE TABLE"
// ... 每种语言 5-8 个特征关键词
// 得分 = 匹配的特征关键词数量
// 如果所有语言得分都 < 2，返回 "通用代码"
```

### 4.2 修改 `src-tauri/Cargo.toml`

```toml
# 新增依赖
regex = "1"          # 正则匹配（分类规则）
lazy_static = "1"    # 静态编译正则
```

> 注：`serde_json` 已有（用于 JSON 验证），`md-5` 已有（可辅助 Base64 检测）。

### 4.3 修改 `src-tauri/src/lib.rs`

```rust
// 新增模块声明
mod content_classifier;

// 在 setup 中：
// 1. 初始化自动标签种子数据
store.ensure_auto_tags()?;  // ← DataStore 新增方法

// 2. 创建并托管 ContentClassifier
let classifier = content_classifier::ContentClassifier::new();
app.manage(classifier);
```

### 4.4 修改 `src-tauri/src/data_store.rs`

新增方法：

```rust
// 确保自动标签种子数据存在
pub fn ensure_auto_tags(&self) -> Result<(), String> { ... }

// 为历史记录添加标签（自动分类使用）
pub fn add_history_tags(&self, history_id: &str, tag_ids: &[String]) -> Result<(), String> { ... }

// 根据标签名列表查找标签 ID
pub fn resolve_auto_tag_ids(&self, labels: &[String]) -> Result<Vec<String>, String> { ... }

// 将自动标签转为手动标签
pub fn confirm_auto_tags(&self, history_id: &str) -> Result<(), String> { ... }
```

### 4.5 修改 `src-tauri/src/clipboard_monitor.rs`

在 `insert_history` 成功后，异步触发分类（不阻塞轮询循环）：

```rust
// 在 insert_history 之后，emit 之前插入：
let classifier_clone = classifier.clone();
let store_clone = store.clone();
let history_id = item.id.clone();
let text = item.text.clone();

tokio::spawn(async move {
    let labels = classifier_clone.classify(&text);
    let tag_ids = store_clone.resolve_auto_tag_ids(&labels)?;
    store_clone.add_history_tags(&history_id, &tag_ids)?;
    Ok::<(), String>(())
});
```

> **关键**：`tokio::spawn` 异步执行，不阻塞 400ms 轮询周期。分类耗时 < 0.5ms，即使异步也几乎即时完成。

### 4.6 修改 `src-tauri/src/commands.rs`

新增 1 个 Tauri command：

```rust
/// 将指定记录的所有自动标签转为手动标签（用户确认）
#[tauri::command]
pub fn confirm_auto_tags(
    store: State<DataStore>,
    history_id: String,
) -> Result<(), String> {
    store.confirm_auto_tags(&history_id)
}
```

---

## 五、前端实现

### 5.1 类型定义更新

```typescript
// Tag 新增 source 字段
export interface Tag {
  id: string;
  name: string;
  color: string;
  source: "manual" | "auto";  // ★ 新增
  created_at: string;
}
```

### 5.2 Store 更新 (`appStore.ts`)

```typescript
// 新增派生数据
get autoTags(): Tag[] {
  return this.tags.filter(t => t.source === "auto");
}

get manualTags(): Tag[] {
  return this.tags.filter(t => t.source === "manual");
}

// 新增 action
confirmAutoTags: (historyId: string) => {
  invoke("confirm_auto_tags", { historyId });
}
```

### 5.3 TagBadge 更新 (`TagBadge.tsx`)

自动标签使用虚线边框 + 🤖 前缀区分：

```tsx
<span className={`${styles.tag} ${tag.source === 'auto' ? styles.autoTag : ''}`}>
  {tag.source === 'auto' && <span className={styles.aiIcon}>🤖</span>}
  {tag.name}
</span>
```

CSS 差异：
```css
.autoTag {
  border-style: dashed;    /* 虚线边框 */
  opacity: 0.85;           /* 稍透明 */
}
```

### 5.4 TagPickerPopover 更新

在标签选择器中将标签分为两组显示：

```
┌──────────────────────────────┐
│ 🔍 搜索标签...                │
│ ──────────────────────────── │
│ 🤖 智能标签                   │
│ ☑ 🤖 代码         🔵        │
│ ☐ 🤖 JSON         🟡        │
│ ──────────────────────────── │
│ 🏷️ 我的标签                   │
│ ☑ 项目A           🟢        │
│ ☐ 工具函数         🟠        │
└──────────────────────────────┘
```

### 5.5 右键菜单新增

```typescript
// ContextMenu.tsx — 当记录有关联自动标签时新增：
{ itemHasAutoTags && (
  <MenuItem onClick={() => confirmAutoTags(item.id)}>
    确认自动标签
  </MenuItem>
)}
{ itemHasAutoTags && (
  <MenuItem onClick={() => removeAutoTags(item.id)}>
    移除自动标签
  </MenuItem>
)}
```

---

## 六、自动标签生命周期

```
剪贴板捕获
  │
  ▼
分类引擎 classify(text)
  │
  ▼
写入 history_tags (source=auto)
  │
  ├─→ 用户忽略 → 标签保留（虚线显示，不碍事）
  │
  ├─→ 用户筛选 → 标签正常工作（与手动标签一样 AND 筛选）
  │
  ├─→ 用户确认 → source 改为 "manual"（实线显示）
  │
  └─→ 用户移除 → 删除 history_tags 关联
```

---

## 七、性能考量

| 指标 | 值 | 说明 |
|------|-----|------|
| 单次分类耗时 | < 0.5ms | 纯正则 + 简单逻辑，无 IO |
| 内存开销 | ~50KB | 预编译的正则表达式 + 关键字列表 |
| 对剪贴板轮询影响 | 零 | `tokio::spawn` 异步，不阻塞 400ms 循环 |
| 数据库写入 | 1-3 条 INSERT | history_tags 表插入 |
| 前端渲染影响 | 忽略不计 | TagBadge 是纯展示组件，已使用 memo 优化 |

---

## 八、实施步骤

| 步骤 | 内容 | 预估工时 | 产出文件 |
|------|------|----------|----------|
| **Step 1** | Rust: content_classifier.rs — 分类引擎核心 | 3h | `content_classifier.rs` (新) |
| **Step 2** | Rust: DataStore 扩展 — ensure_auto_tags + add_history_tags | 1h | `data_store.rs` (改) |
| **Step 3** | Rust: 集成到 clipboard_monitor + 注册 command | 1.5h | `clipboard_monitor.rs` (改), `lib.rs` (改), `commands.rs` (改) |
| **Step 4** | Rust: Cargo.toml 添加依赖 + 编译验证 | 0.5h | `Cargo.toml` (改) |
| **Step 5** | 前端: Tag 类型 + Store + API 更新 | 1h | `appStore.ts` (改), `api.ts` (改) |
| **Step 6** | 前端: TagBadge 自动标签样式（虚线+AI图标） | 1h | `TagBadge.tsx` (改), `TagBadge.module.css` (改) |
| **Step 7** | 前端: TagPickerPopover 分组显示 + 右键菜单 | 1.5h | `TopBar.tsx` (改), `ContextMenu.tsx` (改) |
| **Step 8** | 联调测试：复制各类内容验证分类准确性 | 1.5h | — |
| **合计** | | **~1.5 天** | **1 新文件, 8 修改文件** |

---

## 九、风险与对策

| 风险 | 概率 | 影响 | 对策 |
|------|------|------|------|
| 代码语言误判 | 中 | 低 | 关键字密度阈值可调，默认保守（宁可不分类也不分错） |
| 日志格式多样导致漏识别 | 中 | 低 | 提供 3 种常见日志格式的正则，覆盖 90% 场景 |
| JSON 解析失败（含注释的 JSON） | 低 | 低 | 先尝试去除 `//` 注释后解析 |
| 短文本误判为命令行 | 低 | 低 | 命令行检测要求至少 8 个字符 + 匹配命令白名单 |
| 自动标签过多干扰用户 | 低 | 低 | 每条记录只产生 1-2 个自动标签，UI 用虚线区分 |
