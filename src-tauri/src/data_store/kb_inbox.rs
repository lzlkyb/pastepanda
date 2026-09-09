//! 待沉淀区（知识库 A 阶段 · 规划 §8.1 4️⃣，设计稿 §5）。
//!
//! **它是虚拟视图，不是队列表。** 整个文件只有一个写入动作（`kb_inbox_dismiss`，
//! 用户点「忽略」才走）。候选集全靠一条 SQL 实时算出——**无后台写入就无噪音写入**，
//! 也就不需要任何清理任务：取消收藏 / 已转笔记 / 卡片被删，候选自然消失。
//!
//! 🔴 红线：无 AI。不读内容做任何判断，只数信号。

use super::history::{row_to_history_item, HISTORY_COLS};
use super::*;

/// 一条待沉淀候选。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxCandidate {
    /// 原卡片。直接给前端复用卡片渲染能力（文本预览 / 来源 / 时间）。
    pub item: HistoryItem,
    /// 入选原因：`star` 收藏 / `research` 找回。
    ///
    /// 由 SQL 的 `reason_expr()` 算，**不在 Rust 里再推一遍**：
    /// 忽略时要把它写进 `kb_inbox_dismissed.reason`，两边各算一遍就会漂。
    pub reason: String,
    /// 被搜索命中次数。主排序依据，也是 `research` 征标上的数字。
    pub search_hit_count: i64,
    /// 重复复制次数。`recopy` 征标上的数字。
    ///
    /// ❗ 它不在 `HISTORY_COLS` 里（`HistoryItem` 没这个字段），所以必须单选一列。
    /// 不传的后果不是「少个数字」，是征标只能写「重复用」而说不出几次。
    pub recopy_count: i64,
    /// 是否有过 `action_events.outcome='pasted'`。
    ///
    /// 只做同分时的 tiebreaker（`↩A-28`）：它语义最准（真的被取用了），
    /// 但只覆盖热键类用法，**不能当候选源**。
    pub recently_pasted: bool,
    /// 当前分组下的组键（B2 #9）。`None` = 不分组。
    ///
    /// 存的是**原始值**（`code` / `Chrome` / `star`），中文名由前端映射——
    /// `content_type` → 中文的那份表住在前端 `CONTENT_TYPE_META`，不在 Rust 里再写一份。
    #[serde(default)]
    pub group_key: Option<String>,
}

// ── 四条入选通路，每条只定义一次 ───────────────────────────────
//
// 🔴 为什么拆成常量：入选条件与「入选原因」必须用**同一份口径**。
// 旧实现把原因写在三处（`group_expr` / `push_inbox_filters` / 行映射），
// 加一条通路就要三处各改一次——而漏一处不报错，只是徒然多出一个
// 筛不出东西的分组。现在它们都从这四个常量拼出来。

/// 通路#1 收藏。实测全库为 0，不删是因为零成本且用了就是最强意图。
const SIG_STAR: &str = "h.pinned = 1";
/// 通路#2 找回。口径已于 2026-09-08 改成「搜完真的用了那条」，并清了存量。
const SIG_RESEARCH: &str = "COALESCE(h.search_hit_count, 0) >= 2";
// ❌ 通路#3（重复复制 ≥ 3）**已于 2026-09-09 撤销**。
//
// 它与每日蒸馏（P1/P2）重叠：一条被反复复制的内容，必然也扎在
// 当天或跨天的簇里，蒸馏一定会把它卷进去——用户在同一屏看到两遍。
//
// 🔴 更根本的理由：它被归错类了。当时把它当成「零成本拿到的强意图」，
// 但「被复制了 3 次」不是意图，是**分布**。剩下两条通路测的都是
// **你的动作**（点了星 / 搜出来真用了），而蒸馏整个就是分布。
// 分界线因此变成一句话：**待沉淀 = 你动过手的；可蒸馏 = 机器看出来的**。
//
// ❗ `history.recopy_count` 列与它的累加**保留**：那是一个真实的计数，
// 仍然给待沉淀的排序选项用；撤的只是「凭它自动入选」这件事。
// ❌ 通路#5（截图文字量 ≥ 800）**已于 2026-09-08 当天撤销**。
//
// 它是四条里唯一一个不问「你做过什么」、只问「它长什么样」的：
// 其余三条测量**意图**（点了星 / 搜出来用了 / 又复制了一次），
// 而它测量**体积**。体积预测不了价值——一张 1200 字的报错截图
// 和一张 1200 字的文档截图，在这条规则眼里一模一样。
//
// 🔴 当时为了压住它专门挑了个高阀值（800，实测 +43 张）——
// **需要靠调阀值压住的信号，本身就是错的信号**。
// 而且 43 vs 通路#3 的 11，它会把待沉淀变成图片墙；
// 它又恰好是「一张截图 1:1 变一篇笔记」这个已被判定错误的形态。
//
// 截图改走**每日蒸馏（P1）**进知识库：那里是聚合形态
//（「今天你截了 5 张关于 X 的图」），比单张挤进来有用得多。
//
// ❗ 同天做的另外两件与本通路无关，**保留**：
//   ① 待沉淀加载 OCR（图片终于能转笔记）——那是修 bug
//   ② 可转性过滤（排掉 file 卡片）

/// 入选原因的**唯一**口径。分组 / 筛选 / 列表行都从这里取。
///
/// ❗ `WHEN` 的顺序就是优先级：一条卡片可能同时满足好几条通路，
/// 只报最强的那个。顺序必须与 `candidate_where()` 里的 OR 一致。
///
/// 🔴 `ELSE` 分支直接取 `research` 而不是另给一个兑底值：两条通路与
/// `candidate_where()` 的 OR 是**同一套**，能进来就必中其一，
/// 兑底值永远取不到——给了反而多一个筛不出东西的分组。
fn reason_expr() -> String {
    format!("CASE WHEN {SIG_STAR} THEN 'star' ELSE 'research' END")
}

/// 候选条件。抽出来：列表与计数必须用**完全相同**的条件，
/// 否则横幅上写「待沉淀 225 条」而列表里只有 200 条，用户会以为丢了东西。
///
/// 两条信号（任一命中即入选）+ 三个排除。
/// ❗ 占位符用**匿名** `?` 而不是 `?1`：字段视图（B2 #9）要往后面拼不定个数的
/// 筛选参数，编号绑定下每加一个参数就要重排全部序号——而排错不报错，只是结果静默变错。
fn candidate_where() -> String {
    format!("
    WHERE h.workspace = ?
      AND ({SIG_STAR} OR {SIG_RESEARCH})
      -- 带 deleted_at：笔记被删了，那张卡片就又变回「没沉淀过」，该回到收件箱。
      AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.history_id = h.id AND n.deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM kb_inbox_dismissed d WHERE d.history_id = h.id)
      -- 排掉压根没法转笔记的：列了也只能给一个灏掉的「不支持转笔记」，
      -- 占着位置又做不了事。口径与前端 `extractNoteDraft` 逐条对应：
      --   file        → 正文就是一串路径，不支持
      --   image       → 没 OCR 文字就是一条空笔记
      --   其余类型   → `draftFromText` 对空文本返回 null
      -- ❗ 写在这里而不是前端过滤：列表与计数共用本常量，前端筛会让
      -- 横幅上的总数比列表多出几条（上面那段注释钉的就是这个）。
      AND (CASE h.type
             WHEN 'file' THEN 0
             WHEN 'image' THEN EXISTS (SELECT 1 FROM image_ocr_cache o
                                        WHERE o.image_path = h.content
                                          AND TRIM(COALESCE(o.full_text, '')) <> '')
             ELSE TRIM(COALESCE(h.text, '')) <> ''
           END)")
}

/// 待沉淀区的视图选项（B2 #9）。**全默认 = 与做这个功能之前一模一样**。
///
/// 与笔记侧的 `NoteViewOpts` 是两份而不是一份：可用字段完全不同
/// （这边是卡片的 content_type / source / 信号强度，那边是文件夹 / 摘要 / 标签）。
/// 强行合成一个结构体只会得到一堆在对方那边永远为空的字段。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InboxViewOpts {
    /// `""`|`"signal"` 信号最强 / `"recent"` 最近采集 / `"recopy"` 重复复制最多
    pub sort: String,
    /// `""` 不分组 / `"type"` 按内容类型 / `"source"` 按来源应用 / `"reason"` 按入选原因
    pub group_by: String,
    /// `""` 不筛 / `"star"` 只看收藏 / `"research"` 只看找回
    pub reason: String,
    /// 三态：是否粘贴过
    pub pasted: String,
    /// 内容类型多选（空 = 不筛）。多选是**并集**：选了「代码」和「链接」
    /// 的意思是「这两类都要」，而不是「同时是两类」（后者根本不存在）。
    /// 这与标签的交集语义相反，因为一张卡片只有一个 `content_type`。
    pub types: Vec<String>,
}

impl InboxViewOpts {
    fn order_by(&self) -> &'static str {
        match self.sort.as_str() {
            "recent" => "h.time DESC, h.rowid DESC",
            // recopy_count 是 2026-09-01 刚落的列（A-44），刚开始累加时全部为 0，
            // 此时此排序等于按时间倒序——这不是 bug，是数据还没长出来。
            "recopy" => "COALESCE(h.recopy_count, 0) DESC, h.time DESC",
            // 默认：信号最强优先 → 同分时粘贴过的往前（`↩A-28`）→ 再同分按时间倒序。
            // 最后那道是为了**结果稳定**：不加的话同分行的相对顺序由 SQLite 自由安排，
            // 分页时会出现同一条重复 / 跌页。
            _ => "hit DESC, pasted DESC, h.time DESC",
        }
    }

    /// 分组键。
    ///
    /// ❗ 与笔记侧不同，这里返回的是**原始值**（`code` / `Chrome` / `star`）而不是中文标签：
    /// `content_type` → 中文名的映射住在前端 `CONTENT_TYPE_META`（卡片上的类型徽用的同一份）。
    /// 在 Rust 里再拄一份 19 项的中文表，两边早晚对不上（规则 #11）。
    fn group_expr(&self) -> String {
        match self.group_by.as_str() {
            "type" => "COALESCE(h.content_type, 'text')".to_string(),
            "source" => "h.source".to_string(),
            // 不在这里再写一遍 CASE：口径只有 `reason_expr()` 一份。
            "reason" => reason_expr(),
            _ => "NULL".to_string(),
        }
    }

    fn group_order(&self) -> Option<&'static str> {
        match self.group_by.as_str() {
            "type" | "source" | "reason" => Some("grp COLLATE NOCASE ASC"),
            _ => None,
        }
    }
}

/// 待沉淀区的筛选片段。与列表 / 计数 / 组头计数三处共用（规则 #11）。
fn push_inbox_filters(
    sql: &mut String,
    params: &mut Vec<Box<dyn rusqlite::types::ToSql>>,
    o: &InboxViewOpts,
) {
    // 🔴 直接拿 `reason_expr()` 去比，不另写一套等价条件。
    // 旧实现把「找回」翻译成 `h.pinned = 0`，那在只有两条通路时碰巧等价；
    // 加了第三、第四条之后它就错了——而且**不报错**，只是筛出一堆不属于这个原因的。
    if matches!(o.reason.as_str(), "star" | "research") {
        sql.push_str(&format!(" AND ({}) = '{}'", reason_expr(), o.reason));
    }
    match o.pasted.as_str() {
        "yes" => sql.push_str(
            " AND EXISTS (SELECT 1 FROM action_events ae \
               WHERE ae.history_id = h.id AND ae.outcome = 'pasted')",
        ),
        "no" => sql.push_str(
            " AND NOT EXISTS (SELECT 1 FROM action_events ae \
               WHERE ae.history_id = h.id AND ae.outcome = 'pasted')",
        ),
        _ => {}
    }
    if !o.types.is_empty() {
        let holes = vec!["?"; o.types.len()].join(",");
        sql.push_str(&format!(
            " AND COALESCE(h.content_type, 'text') IN ({})",
            holes
        ));
        for t in &o.types {
            params.push(Box::new(t.clone()));
        }
    }
}

/// 一个分组的真实条数。组名是**原始值**，前端负责映射成中文。
#[derive(Debug, Clone, Serialize)]
pub struct InboxGroupCount {
    pub key: String,
    pub count: i64,
}

impl DataStore {
    /// 待沉淀候选列表（分批）。
    ///
    /// 排序：`search_hit_count` 降序（最强信号优先）→ 同分时有 `pasted` 的往前
    /// （`↩A-28`）→ 再同分按时间倒序。最后那道是为了**结果稳定**：
    /// 不加的话同分行的相对顺序由 SQLite 自由安排，分页时会出现同一条重复 / 跌页。
    pub fn kb_inbox_list(
        &self,
        workspace: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<InboxCandidate>, String> {
        self.kb_inbox_list_view(workspace, &InboxViewOpts::default(), limit, offset)
    }

    /// 列表 / 计数 / 组头计数共用的 `FROM … WHERE …` 与参数（B2 #9）。
    ///
    /// `workspace` 固定是第一个参数，筛选参数接在后面。
    fn inbox_from_where(
        workspace: &str,
        opts: &InboxViewOpts,
    ) -> (String, Vec<Box<dyn rusqlite::types::ToSql>>) {
        let mut sql = format!(" FROM history h {}", candidate_where());
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> =
            vec![Box::new(workspace.to_string())];
        push_inbox_filters(&mut sql, &mut params, opts);
        (sql, params)
    }

    /// 带视图选项的候选列表（B2 #9）。`opts` 全默认时与旧行为完全一致。
    pub fn kb_inbox_list_view(
        &self,
        workspace: &str,
        opts: &InboxViewOpts,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<InboxCandidate>, String> {
        let conn = self.lock_conn();
        let (from_where, mut params) = Self::inbox_from_where(workspace, opts);
        let mut sql = format!(
            "SELECT {cols},
                    COALESCE(h.search_hit_count, 0) AS hit,
                    EXISTS(SELECT 1 FROM action_events ae
                            WHERE ae.history_id = h.id AND ae.outcome = 'pasted') AS pasted,
                    COALESCE(h.recopy_count, 0) AS recopy,
                    {grp} AS grp,
                    {rsn} AS reason{from_where}",
            // 列名带 h. 前缀：子查询里也有 history_id 同名列，不限定会歧义
            cols = HISTORY_COLS
                .split(", ")
                .map(|c| format!("h.{c}"))
                .collect::<Vec<_>>()
                .join(", "),
            grp = opts.group_expr(),
            // 🔴 原因从 SQL 里取，不在 Rust 里再算一遍。
            // 旧实现写的是 `if item.pinned { "star" } else { "research" }`——
            // 一加通路就会把重复复制与截图全报成「找回」。
            rsn = reason_expr(),
            from_where = from_where,
        );
        sql.push_str(" ORDER BY ");
        if let Some(g) = opts.group_order() {
            sql.push_str(g);
            sql.push_str(", ");
        }
        sql.push_str(opts.order_by());
        sql.push_str(" LIMIT ? OFFSET ?");
        params.push(Box::new(limit));
        params.push(Box::new(offset));

        let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        // 先拆成两排：`load_ocr_texts_into_items` 要的是 `&mut [HistoryItem]`，
        // 从 `Vec<InboxCandidate>` 里取不出连续切片。最后再 zip 回去。
        let mut items: Vec<HistoryItem> = Vec::new();
        let mut metas: Vec<(i64, i64, i64, Option<String>, String)> = Vec::new();
        let iter = stmt
            .query_map(refs.as_slice(), |row| {
                let item = row_to_history_item(row)?;
                // 🔴 按**列名**取，不写死下标。
                // 旧实现是 `row.get(13..15)`，而本轮在中间插了一列 `recopy`，
                // 下标全错位——**而且不报错**，只是静默读到隔壁列。
                // 笔记侧 `row_to_note_grouped` 已经为同一件事撞过一次。
                let hit: i64 = row.get("hit")?;
                let pasted: i64 = row.get("pasted")?;
                let recopy: i64 = row.get("recopy")?;
                let group_key: Option<String> = row.get("grp")?;
                let reason: String = row.get("reason")?;
                Ok((item, hit, pasted, recopy, group_key, reason))
            })
            .map_err(|e| e.to_string())?;
        for (item, hit, pasted, recopy, group_key, reason) in iter.filter_map(|r| r.ok()) {
            items.push(item);
            metas.push((hit, pasted, recopy, group_key, reason));
        }
        // 🔴 先放锁再去取 OCR：`load_ocr_texts_into_items` 自己要 `lock_conn()`，
        // 拿着这把锁去调就是自己等自己。
        drop(stmt);
        drop(conn);
        // ❗ 没这一行的后果不是「图片缺点信息」，是**全部图片都显示「不支持转笔记」**：
        // 前端 `extractNoteDraft` 对 image 的判据就是 `ocr_text`，为空就返回 null。
        // 此前本文件一次都没加载过 OCR（只有 `history.rs` 的三条搜索路径加了），
        // 实测待沉淀里 80 张图片全部有 OCR 文字，却一张都转不了。
        self.load_ocr_texts_into_items(&mut items)?;
        let rows: Vec<InboxCandidate> = items
            .into_iter()
            .zip(metas)
            .map(|(item, (hit, pasted, recopy, group_key, reason))| {
                InboxCandidate {
                    reason,
                    search_hit_count: hit,
                    recopy_count: recopy,
                    recently_pasted: pasted != 0,
                    group_key,
                    item,
                }
            })
            .collect();
        Ok(rows)
    }

    /// 候选总数（横幅计数）。与 `kb_inbox_list` 共用 `candidate_where()`。
    pub fn kb_inbox_count(&self, workspace: &str) -> Result<i64, String> {
        self.kb_inbox_count_view(workspace, &InboxViewOpts::default())
    }

    /// 带视图选项的候选总数（B2 #9）。
    pub fn kb_inbox_count_view(
        &self,
        workspace: &str,
        opts: &InboxViewOpts,
    ) -> Result<i64, String> {
        let conn = self.lock_conn();
        let (from_where, params) = Self::inbox_from_where(workspace, opts);
        let sql = format!("SELECT COUNT(*){}", from_where);
        let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        conn.query_row(&sql, refs.as_slice(), |r| r.get(0))
            .map_err(|e| e.to_string())
    }

    /// 每个分组的真实条数（B2 #9）。不分组时返回空。
    pub fn kb_inbox_group_counts(
        &self,
        workspace: &str,
        opts: &InboxViewOpts,
    ) -> Result<Vec<InboxGroupCount>, String> {
        if opts.group_order().is_none() {
            return Ok(Vec::new());
        }
        let conn = self.lock_conn();
        let (from_where, params) = Self::inbox_from_where(workspace, opts);
        let sql = format!(
            "SELECT {} AS grp, COUNT(*) AS c{} GROUP BY grp ORDER BY {}",
            opts.group_expr(),
            from_where,
            opts.group_order().unwrap_or("grp"),
        );
        let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(refs.as_slice(), |r| {
                Ok(InboxGroupCount {
                    key: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    count: r.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 忽略一条候选（本文件**唯一**的写入）。
    ///
    /// 整卡粒度：「这条别烦我」比「这个信号别烦我」更符合直觉（设计稿 §5-3）。
    /// 用 `INSERT OR REPLACE` 而不是 `INSERT`：同一张卡片可能先因找回入选被忽略，
    /// 后来又因收藏重新入选（用户手动取消了 dismiss 才会），`reason` 取最后一次。
    pub fn kb_inbox_dismiss(&self, history_id: &str, reason: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT OR REPLACE INTO kb_inbox_dismissed (history_id, reason, created_at)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![
                history_id,
                reason,
                // 全库时间戳惯例（action_events.rs:169 等处同形）。不用 note.rs 里的毫秒版：
                // 那里加毫秒是为了笔记列表排序稳定，而这张表从不按时间排序
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 恢复一条被忽略的候选（忽略的撤销）。
    ///
    /// 为何需要它：忽略是单击就生效的，而候选行上两个按钮靠得很近。
    /// 没有回头路的话，一次误点就把那张卡片永久逐出了待沉淀区，而用户无从发现。
    pub fn kb_inbox_undismiss(&self, history_id: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM kb_inbox_dismissed WHERE history_id = ?1",
            [history_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}
