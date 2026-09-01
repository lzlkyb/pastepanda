//! 笔记文件夹（B1 #1）。设计稿：design/PastePanda-知识库视图-设计稿.html
//!
//! 邻接表（`parent_id`）。选它而不选物化路径的代价就是本文件里两个必须自己守的不变量：
//!
//! ① **不得成环**。把父文件夹移进自己的后代，两边就从根上断开：递归从顶层往下走
//!    永远到不了它们，而行还在表里——**笔记不会丢，但永久看不见**。
//! ② **深度 ≤ 3**。不是拍的：侧栏 180px，第 4 层名字只剩 ~97px（约 8 个中文字），
//!    普遍被截，树不再可读。导入（#5）将来可能带进更深的目录，所以后端也得校。
//!
//! 🔴 红线：无 AI。纯结构操作，不读笔记内容。

use super::*;

/// 深度上限（顶层计为 1）。改它前先去量一下侧栏宽度，设计稿 §2 有该表。
pub const MAX_FOLDER_DEPTH: i64 = 3;

/// 一个文件夹。`note_count` 是**含后代**的计数。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteFolder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    /// 本文件夹**及其所有后代**里的笔记数。
    ///
    /// 为何含后代：不含的话点「工作」看到 15 条而侧栏写 62，用户会以为丢了。
    /// 侧栏计数与列表内容必须同口径——同待沉淀区「横幅 225 / 列表 200」的教训（`↩A-32`）。
    #[serde(default)]
    pub note_count: i64,
    /// 深度（顶层 = 1）。给前端算缩进与「能不能再建子文件夹」用。
    #[serde(default)]
    pub depth: i64,
}

/// 递归取某文件夹的自身 + 全部后代 id。多处复用，收口成常量（规则 #11）。
///
/// `?1` = 起点 id。注意它**含自身**——防环校验与含后代计数都需要这个语义。
pub(super) const SUBTREE_CTE: &str = "
    WITH RECURSIVE sub(id) AS (
        SELECT id FROM note_folders WHERE id = ?1
        UNION ALL
        SELECT f.id FROM note_folders f JOIN sub ON f.parent_id = sub.id
    )";

fn folder_now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

impl DataStore {
    // ===== 查询 =====

    /// 全部文件夹，带含后代的笔记数与深度，按「同父下 sort_order → name」排序。
    ///
    /// 一次把整棵树取回去而不是按层懒加载：文件夹是几十个量级，懒加载只会让
    /// 前端多一堆展开态管理，换不回任何东西。前端拿平表自己建 parent→children。
    pub fn folder_list(&self) -> Result<Vec<NoteFolder>, String> {
        let conn = self.lock_conn();

        // 深度与计数都在 SQL 里算完：前端重算一遍就是两份口径。
        let sql = format!(
            "WITH RECURSIVE tree(id, name, parent_id, sort_order, created_at, depth) AS (
                 SELECT id, name, parent_id, sort_order, created_at, 1
                   FROM note_folders WHERE parent_id IS NULL
                 UNION ALL
                 SELECT f.id, f.name, f.parent_id, f.sort_order, f.created_at, t.depth + 1
                   FROM note_folders f JOIN tree t ON f.parent_id = t.id
             )
             SELECT t.id, t.name, t.parent_id, t.sort_order, t.created_at, t.depth,
                    (SELECT COUNT(*) FROM notes n WHERE n.folder_id IN (
                        {subtree} SELECT id FROM sub
                    )) AS cnt
             FROM tree t
             ORDER BY t.depth, t.sort_order, t.name",
            // 子查询里的 ?1 要绑到 t.id，所以把常量里的 ?1 换成列引用
            subtree = SUBTREE_CTE.replace("?1", "t.id"),
        );

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows: Vec<NoteFolder> = stmt
            .query_map([], |r| {
                Ok(NoteFolder {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    parent_id: r.get(2)?,
                    sort_order: r.get(3)?,
                    created_at: r.get(4)?,
                    depth: r.get(5)?,
                    note_count: r.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 未分类笔记数。侧栏内置项用。
    ///
    /// 口径必须与 `push_note_filters` 的 `unfiled` 分支一致（同样排掉速记），
    /// 否则侧栏显示 12 条、点进去只有 5 条。
    pub fn folder_unfiled_count(&self) -> Result<i64, String> {
        self.lock_conn()
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE folder_id IS NULL AND daily_date IS NULL",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())
    }

    /// 某文件夹的自身 + 后代 id 集合。笔记列表按文件夹筛选时用它。
    pub fn folder_subtree_ids(&self, folder_id: &str) -> Result<Vec<String>, String> {
        let conn = self.lock_conn();
        let sql = format!("{SUBTREE_CTE} SELECT id FROM sub");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let ids = stmt
            .query_map([folder_id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(ids)
    }

    /// 删除前的影响预览：`(子文件夹数, 会变未分类的笔记数)`。
    ///
    /// 确认框必须拿真数字去填，不能写泛泛的「相关内容可能受影响」——
    /// 用户靠这两个数决定要不要点确定。
    pub fn folder_delete_impact(&self, folder_id: &str) -> Result<(i64, i64), String> {
        let conn = self.lock_conn();
        let sub_sql = format!("{SUBTREE_CTE} SELECT COUNT(*) FROM sub");
        // 含自身，所以减 1 才是子文件夹数
        let subtree_total: i64 = conn
            .query_row(&sub_sql, [folder_id], |r| r.get(0))
            .map_err(|e| e.to_string())?;

        let note_sql = format!(
            "{SUBTREE_CTE} SELECT COUNT(*) FROM notes WHERE folder_id IN (SELECT id FROM sub)"
        );
        let notes: i64 = conn
            .query_row(&note_sql, [folder_id], |r| r.get(0))
            .map_err(|e| e.to_string())?;

        Ok(((subtree_total - 1).max(0), notes))
    }

    // ===== 写入 =====

    /// 新建文件夹。`parent_id` 为 `None` = 顶层。
    ///
    /// 三道校验：名字非空 · 同父下不重名 · 深度不超限。
    /// 同父下重名必须拦：否则树里两行完全一样，用户无法区分哪个是哪个。
    pub fn folder_create(
        &self,
        name: &str,
        parent_id: Option<&str>,
    ) -> Result<NoteFolder, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("文件夹名不能为空".to_string());
        }

        let depth = match parent_id {
            None => 1,
            Some(p) => {
                let pd = self.folder_depth(p)?;
                if pd >= MAX_FOLDER_DEPTH {
                    return Err(format!(
                        "文件夹最多 {MAX_FOLDER_DEPTH} 层，这里不能再建子文件夹"
                    ));
                }
                pd + 1
            }
        };

        let conn = self.lock_conn();
        Self::ensure_name_free_on(&conn, name, parent_id, None)?;

        let id = uuid::Uuid::new_v4().to_string();
        let now = folder_now();
        // sort_order 取同父下的最大值 + 1：新建的排在末尾，而不是插到开头
        let next_order: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM note_folders
                 WHERE parent_id IS ?1",
                [parent_id],
                |r| r.get(0),
            )
            .unwrap_or(0);

        conn.execute(
            "INSERT INTO note_folders (id, name, parent_id, sort_order, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, name, parent_id, next_order, now],
        )
        .map_err(|e| e.to_string())?;

        Ok(NoteFolder {
            id,
            name: name.to_string(),
            parent_id: parent_id.map(|s| s.to_string()),
            sort_order: next_order,
            created_at: now,
            note_count: 0,
            depth,
        })
    }

    /// 重命名。邻接表的便宜处：**只 UPDATE 一行**，后代不用动
    /// （物化路径就得改所有后代的 path）。
    pub fn folder_rename(&self, id: &str, name: &str) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("文件夹名不能为空".to_string());
        }
        let conn = self.lock_conn();
        let parent: Option<String> = conn
            .query_row(
                "SELECT parent_id FROM note_folders WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .map_err(|_| "文件夹不存在".to_string())?;
        Self::ensure_name_free_on(&conn, name, parent.as_deref(), Some(id))?;

        let n = conn
            .execute(
                "UPDATE note_folders SET name = ?1 WHERE id = ?2",
                rusqlite::params![name, id],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            // 规则 #15.3：改不存在的目标是调用方 bug，不能静默成功
            return Err("文件夹不存在".to_string());
        }
        Ok(())
    }

    /// 移动文件夹。`new_parent` 为 `None` = 移到顶层。
    ///
    /// **这是邻接表方案的全部风险所在**，三道校验一道都不能少：
    /// ① 目标 == 自己；
    /// ② 目标 ∈ 自己的后代（否则整棵子树从根上断开，笔记不丢但永久看不见）；
    /// ③ 移过去后子树总高度超限。
    ///
    /// UI 侧会把这三类目标从「移动到…」列表里去掉，但**后端仍是权威**——
    /// 导入（#5）与将来的 MCP 写入（M4）不走 UI。
    pub fn folder_move(&self, id: &str, new_parent: Option<&str>) -> Result<(), String> {
        if let Some(p) = new_parent {
            if p == id {
                return Err("不能把文件夹移动到自己里".to_string());
            }
            // ② 目标是否在自己的子树里
            if self.folder_subtree_ids(id)?.iter().any(|x| x == p) {
                return Err("不能把文件夹移动到它自己的子文件夹里".to_string());
            }
            // ③ 目标深度 + 自身子树高度 ≤ 上限
            let target_depth = self.folder_depth(p)?;
            let own_height = self.folder_height(id)?;
            if target_depth + own_height > MAX_FOLDER_DEPTH {
                return Err(format!(
                    "移过去会超过 {MAX_FOLDER_DEPTH} 层（目标在第 {target_depth} 层，\
                     这个文件夹自己有 {own_height} 层）"
                ));
            }
        }

        let conn = self.lock_conn();
        // 重名校验：移到新父下也不能与已有兄弟同名
        let name: String = conn
            .query_row("SELECT name FROM note_folders WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .map_err(|_| "文件夹不存在".to_string())?;
        Self::ensure_name_free_on(&conn, &name, new_parent, Some(id))?;

        let n = conn
            .execute(
                "UPDATE note_folders SET parent_id = ?1 WHERE id = ?2",
                rusqlite::params![new_parent, id],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("文件夹不存在".to_string());
        }
        Ok(())
    }

    /// 删除文件夹。**子文件夹随之删（CASCADE），笔记不删（SET NULL）**。
    ///
    /// 两个行为都靠建表时的外键子句，不在这里手写 —— `PRAGMA foreign_keys=ON`
    /// 已在 mod.rs 开着，手写一遍只会多一份可能与 DDL 漂的逻辑。
    pub fn folder_delete(&self, id: &str) -> Result<(), String> {
        let conn = self.lock_conn();
        let n = conn
            .execute("DELETE FROM note_folders WHERE id = ?1", [id])
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("文件夹不存在".to_string());
        }
        Ok(())
    }

    /// 给笔记归档。`folder_id` 为 `None` = 移回未分类。
    pub fn note_set_folder(&self, note_id: &str, folder_id: Option<&str>) -> Result<(), String> {
        let conn = self.lock_conn();
        let n = conn
            .execute(
                "UPDATE notes SET folder_id = ?1 WHERE id = ?2",
                rusqlite::params![folder_id, note_id],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("笔记不存在".to_string());
        }
        Ok(())
    }

    // ===== 内部工具 =====

    /// 某文件夹的深度（顶层 = 1）。
    fn folder_depth(&self, id: &str) -> Result<i64, String> {
        let conn = self.lock_conn();
        conn.query_row(
            "WITH RECURSIVE up(id, parent_id, d) AS (
                 SELECT id, parent_id, 1 FROM note_folders WHERE id = ?1
                 UNION ALL
                 SELECT f.id, f.parent_id, up.d + 1
                   FROM note_folders f JOIN up ON f.id = up.parent_id
             )
             SELECT MAX(d) FROM up",
            [id],
            |r| r.get::<_, Option<i64>>(0),
        )
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "文件夹不存在".to_string())
    }

    /// 某文件夹子树的高度（只有自己 = 1）。移动时算会不会超深。
    fn folder_height(&self, id: &str) -> Result<i64, String> {
        let conn = self.lock_conn();
        conn.query_row(
            "WITH RECURSIVE down(id, h) AS (
                 SELECT id, 1 FROM note_folders WHERE id = ?1
                 UNION ALL
                 SELECT f.id, down.h + 1
                   FROM note_folders f JOIN down ON f.parent_id = down.id
             )
             SELECT MAX(h) FROM down",
            [id],
            |r| r.get::<_, Option<i64>>(0),
        )
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "文件夹不存在".to_string())
    }

    /// 同父下重名校验。`exclude` 是自身 id（改名/移动时要把自己排除在外）。
    ///
    /// 为何不用 UNIQUE 约束：`parent_id` 可为 NULL，而 SQLite 的 UNIQUE 把多个 NULL
    /// 当不同值，顶层同名根本拦不住。只能手查。
    fn ensure_name_free_on(
        conn: &rusqlite::Connection,
        name: &str,
        parent_id: Option<&str>,
        exclude: Option<&str>,
    ) -> Result<(), String> {
        let taken: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM note_folders
                 WHERE parent_id IS ?1 AND name = ?2 AND (?3 IS NULL OR id != ?3)",
                rusqlite::params![parent_id, name, exclude],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if taken > 0 {
            return Err(format!("同一层已经有叫「{name}」的文件夹了"));
        }
        Ok(())
    }
}
