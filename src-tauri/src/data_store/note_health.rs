//! 库体检（N3）——把已有的几项检查聚成一份「现在能修什么」的报告。
//!
//! # 不新增任何表或列
//!
//! 四项判据全部复用现有能力：[`DataStore::note_broken_links`]、
//! [`DataStore::note_title_dups`]、[`crate::similar::find_dups`]，加一条长度查询。
//! 本模块只做聚合与封顶。
//!
//! # 🔴 三项实测证明「不是问题」的东西，故意不在这里
//!
//! 2026-09-05 真库（27 篇）实测：**孤立笔记 93%、无文件夹 96%、无标签 96%**。
//! 报这三项等于告诉用户「你的库 93% 有毛病」——它们是「没用这个功能」，不是缺陷。
//! `note_links.rs` 里 [`DataStore::note_orphans`] 的注释已经预警过同一件事。
//! 与 AM-8 那 73 对弱候选的差别在于：那里能用长度门槛滤掉噪声，
//! 而这三项**没有等价的门槛可加**。
//!
//! # 🔴 冲突副本也故意不在这里
//!
//! `KbSyncStatusBar` 已经在知识库顶部报「有 N 处冲突副本还没处理」。
//! 体检再报一遍，两条条并列说同一件事——那正是《知识库-总排期》§2 那类重复规划。
//!
//! # 不提供一键修
//!
//! 全部是报告 + 导航。合并要复用 AM-3 的「遇同名跳过并告警」守卫，
//! 而 AM-3 至今零代码；裸调 O-9 的标题级全库 `REPLACE` 会把指向另一篇同名笔记的
//! 链接一起改坏（AM-8 模块文档已给出同一结论）。

use super::DataStore;
use crate::similar::DupGroup;

/// 每类明细最多带回多少条。界面上只展示前几条 + 「还有 N 条」。
pub const HEALTH_DETAIL_CAP: usize = 5;

/// 不足多少**字符**算极短笔记。
///
/// ❗ 字符不是字节：SQLite 的 `LENGTH()` 对 TEXT 返回字符数，正是我们要的。
/// 若有人改成按字节算，20 个汉字（=60 字节）就会被当成「不短」，
/// 这一档对中文用户彻底失效。已配单测。
pub const TINY_NOTE_CHARS: i64 = 50;

/// 一条断链。
#[derive(Debug, Clone, serde::Serialize)]
pub struct BrokenLink {
    /// 源笔记 id——界面靠它「跳到现场」。
    pub from_id: String,
    pub from_title: String,
    /// 方括号里那个找不到的标题。
    pub to_title: String,
}

/// 一篇几乎是空的笔记。
#[derive(Debug, Clone, serde::Serialize)]
pub struct TinyNote {
    pub id: String,
    pub title: String,
    /// 正文字符数。
    pub len: i64,
}

/// 中性统计——展开面板底部那一行，**不是问题**。
///
/// 「超大笔记」就落在这里而不是单列一档：AM-2 节级命中上线后，
/// 「长」已经不影响检索了，把它报成问题是在造噪声。
#[derive(Debug, Clone, serde::Serialize)]
pub struct KbStats {
    pub note_count: i64,
    /// 正文平均字符数（取整）。
    pub avg_len: i64,
    pub max_len: i64,
    /// **被活笔记用到的**标签数，不是全库标签数。理由见 [`DataStore::kb_health`]。
    pub tag_count: i64,
    /// 活笔记引出的 `[[ ]]` 链总数。
    pub link_count: i64,
}

/// 一份库体检报告。
///
/// 每类都是**明细（封顶）+ 真计数**两个字段。只给封顶后的数组的话，
/// 界面上那句「还有 N 条」就无从算起，截断会变成静默的。
#[derive(Debug, Clone, serde::Serialize)]
pub struct KbHealth {
    pub broken_links: Vec<BrokenLink>,
    pub broken_count: usize,
    pub tag_dups: Vec<DupGroup>,
    pub tag_dup_count: usize,
    pub title_dups: Vec<DupGroup>,
    pub title_dup_count: usize,
    pub tiny_notes: Vec<TinyNote>,
    pub tiny_count: usize,
    pub stats: KbStats,
}

impl DataStore {
    /// 跑一遍库体检。
    ///
    /// # 🔴 标签只算被笔记用到的那一批
    ///
    /// `tags` 是剪贴板与知识库的**共用表**。真库（2026-09-05）共 38 个标签，
    /// 被笔记用到的只有 6 个；而全库唯一那组重名（`Java` / `java`）
    /// **两个都没任何笔记在用**——它们是剪贴板内容分类器打的代码类型标签。
    ///
    /// 拿 `get_tags()` 算，体检就会报一条「标签重名」，而用户点进去
    /// 修不了知识库的任何东西。已配单测钉住。
    ///
    /// # 性能
    ///
    /// 三条查询都是全表扫。今天 27 篇怎么算都快；
    /// **1 万篇的预算挂 N5（规模化性能预算）**，到那一步再讨论增量维护或索引，
    /// 现在不提前优化。
    pub fn kb_health(&self) -> Result<KbHealth, String> {
        // 一、断链——直接用已有查询，口径（指向回收站也算断）跟它走，不另定一套
        let broken_raw = self.note_broken_links()?;
        let broken_count = broken_raw.len();
        let broken_links: Vec<BrokenLink> = broken_raw
            .into_iter()
            .take(HEALTH_DETAIL_CAP)
            .map(|(from_id, from_title, to_title)| BrokenLink {
                from_id,
                from_title,
                to_title,
            })
            .collect();

        // 二、标题近重复——同样直接复用
        let title_raw = self.note_title_dups()?;
        let title_dup_count = title_raw.len();
        let title_dups: Vec<DupGroup> = title_raw.into_iter().take(HEALTH_DETAIL_CAP).collect();

        // 三、标签近重复——只取**活笔记实际用到**的标签名。
        // ❗ 必须在 `lock_conn()` 之前调：它自己要拿锁，拿着锁再调会死锁。
        // 上面两条（note_broken_links / note_title_dups）同理。
        let tag_names = self.note_tag_names()?;
        let tag_raw = crate::similar::find_dups(&tag_names);
        let tag_dup_count = tag_raw.len();
        let tag_dups: Vec<DupGroup> = tag_raw.into_iter().take(HEALTH_DETAIL_CAP).collect();

        // 下面才开始自己拿锁查表。上面三条全是复用已有方法（它们各自拿锁）。
        let conn = self.lock_conn();

        // 四、极短笔记
        let tiny_count: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL AND LENGTH(content) < ?1",
                [TINY_NOTE_CHARS],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|e| e.to_string())? as usize;
        let tiny_notes: Vec<TinyNote> = {
            // 最短的排前面：真空的那几篇最可能是误建，最值得先看一眼。
            let mut st = conn
                .prepare(
                    "SELECT id, title, LENGTH(content) FROM notes
                     WHERE deleted_at IS NULL AND LENGTH(content) < ?1
                     ORDER BY LENGTH(content), title LIMIT ?2",
                )
                .map_err(|e| e.to_string())?;
            let rows = st
                .query_map(
                    rusqlite::params![TINY_NOTE_CHARS, HEALTH_DETAIL_CAP as i64],
                    |r| {
                        Ok(TinyNote {
                            id: r.get(0)?,
                            title: r.get(1)?,
                            len: r.get(2)?,
                        })
                    },
                )
                .map_err(|e| e.to_string())?;
            rows.filter_map(Result::ok).collect()
        };

        // 五、中性统计
        // 空库时 AVG/MAX 返 NULL，所以接 Option 再兑 0；直接 get::<i64> 会报类型错。
        let (note_count, avg_len, max_len): (i64, i64, i64) = conn
            .query_row(
                "SELECT COUNT(*),
                        CAST(COALESCE(AVG(LENGTH(content)), 0) AS INTEGER),
                        COALESCE(MAX(LENGTH(content)), 0)
                 FROM notes WHERE deleted_at IS NULL",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| e.to_string())?;
        let tag_count: i64 = conn
            .query_row(
                "SELECT COUNT(DISTINCT nt.tag_id) FROM note_tags nt
                 JOIN notes n ON n.id = nt.note_id AND n.deleted_at IS NULL",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let link_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM note_links l
                 JOIN notes f ON f.id = l.from_id AND f.deleted_at IS NULL",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;

        Ok(KbHealth {
            broken_links,
            broken_count,
            tag_dups,
            tag_dup_count,
            title_dups,
            title_dup_count,
            tiny_notes,
            tiny_count,
            stats: KbStats {
                note_count,
                avg_len,
                max_len,
                tag_count,
                link_count,
            },
        })
    }
}
