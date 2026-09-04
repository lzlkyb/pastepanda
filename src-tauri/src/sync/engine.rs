//! 同步引擎骨架（M6 主体第一片）。**不联网、不碰界面。**
//!
//! # 它做三件事
//!
//! | | |
//! |---|---|
//! | 算增量 | 「上次同步点之后变过的笔记 + 发生过的删除」 |
//! | 写增量 | 落成一个 vault 布局的目录 + 一份清单 |
//! | 应用增量 | 从这样一个目录读回来，按后写胜合并 |
//!
//! 传输层（iroh）只负责把那个目录搬过去。**所以这一层本地就能端到端测**：
//! 两个 `DataStore` + 一个临时目录 = 一次完整同步，不需要网络。
//!
//! # 🔴 为什么不能直接复用 `note_import_dir`
//!
//! 设计稿 §3.2 写「**完全复用** `import_vault_dir`」——**那样会破坏后写胜**。
//!
//! 实测 `note_import_dir` 匹配到已有笔记后**无条件** `note_update`
//! （`note_vault.rs` 的更新分支，不比时间）。那对「用户拿一个外部 vault 导进来」
//! 是对的语义（文件就是权威），但对同步是错的：
//! **对端一份旧版本会覆盖本地刚改过的新版本，而两边都不报错。**
//!
//! 所以这里的做法是：**先按清单把「会输的那些文件」从暂存目录里删掉，再交给
//! `note_import_dir`**。导入侧代码一行不改，语义由本层负责。
//!
//! # ⚠ 这一片没做冲突文件
//!
//! 后写胜会**静默丢掉输的那一边**。设计稿 §7.4 说真冲突要留
//! `.sync-conflict.<NodeId>.<ms>.md`，但「什么算真冲突」需要 HLC 才判得准
//! （§7.5 已推翻「同毫秒才算冲突」那个定义）。
//! 本片只做后写胜，并**把跳过的条数报出来**，让它至少可见。

use crate::data_store::{DataStore, Note};
use std::path::{Path, PathBuf};

/// 增量清单文件名。带前导点，避免被 `note_import_dir` 当成笔记扫进去。
const MANIFEST: &str = ".pp-sync-manifest";
/// 墓碑清单文件名。
const TOMBSTONES: &str = ".pp-sync-tombstones";

/// 一次增量的内容。
#[derive(Debug)]
pub struct Delta {
    /// `updated_ms > since` 的活笔记。
    pub notes: Vec<Note>,
    /// `(note_id, tombstone_ms)`。
    pub tombstones: Vec<(String, i64)>,
    /// 本次之后的新游标。**取本次见到的最大值，不取「现在」**——
    /// 取现在的话，一条正在写、时间戳略大于本次扫描时刻的笔记会被永久跳过。
    pub cursor_ms: i64,
}

impl Delta {
    pub fn is_empty(&self) -> bool {
        self.notes.is_empty() && self.tombstones.is_empty()
    }
}

/// 算增量。纯查询，不写盘。
pub fn compute_delta(store: &DataStore, since_ms: i64) -> Result<Delta, String> {
    let notes = store.note_changed_since(since_ms)?;
    let tombstones = store.note_tombstones_since(since_ms)?;
    let cursor_ms = notes
        .iter()
        .filter_map(|n| store.note_updated_ms(&n.id))
        .chain(tombstones.iter().map(|(_, ms)| *ms))
        .max()
        .unwrap_or(since_ms)
        .max(since_ms);
    Ok(Delta {
        notes,
        tombstones,
        cursor_ms,
    })
}

/// 把增量写成一个目录。目录必须已存在。
pub fn write_delta(store: &DataStore, delta: &Delta, out: &Path) -> Result<(), String> {
    if !out.is_dir() {
        return Err(format!("输出目录不存在: {}", out.display()));
    }
    let folders = store.folder_list()?;
    let dir_of = DataStore::sync_folder_dir_map(&folders, out);

    let mut manifest = String::new();
    for n in &delta.notes {
        let dir = match n.folder_id.as_deref().and_then(|id| dir_of.get(id)) {
            Some(d) => d.clone(),
            None => out.to_path_buf(),
        };
        std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败: {e}"))?;

        // 文件名用 id 而不是标题：这个目录是**机器之间的传输格式**，不给人看。
        // 用标题就得处理重名编号，而重名编号在两台机器上可能编出不同的号，
        // 于是同一篇笔记在对端落成另一个文件 —— 而 id 是唯一且稳定的。
        let name = format!("{}.md", n.id);
        std::fs::write(dir.join(&name), crate::data_store::note_to_markdown(n, true))
            .map_err(|e| format!("写文件失败 {name}: {e}"))?;

        let ms = store.note_updated_ms(&n.id).unwrap_or(0);
        let rel = dir
            .strip_prefix(out)
            .map(|p| p.join(&name))
            .unwrap_or_else(|_| PathBuf::from(&name));
        manifest.push_str(&format!(
            "{}\t{}\t{}\n",
            n.id,
            ms,
            rel.to_string_lossy().replace('\\', "/")
        ));
    }
    std::fs::write(out.join(MANIFEST), manifest).map_err(|e| format!("写清单失败: {e}"))?;

    let tomb: String = delta
        .tombstones
        .iter()
        .map(|(id, ms)| format!("{}\t{}\n", id, ms))
        .collect();
    std::fs::write(out.join(TOMBSTONES), tomb).map_err(|e| format!("写墓碑清单失败: {e}"))?;
    Ok(())
}

/// 应用一次增量的结果。
#[derive(Debug, Default, PartialEq)]
pub struct ApplyReport {
    pub created: i64,
    pub updated: i64,
    /// 被墓碑软删掉的本地笔记数。
    pub deleted: usize,
    /// 🔴 因为**本地更新**而被跳过的笔记数（后写胜里输的那一边）。
    ///
    /// 必须报出来：后写胜会静默丢掉输的那一边，这个数是它唯一的痕迹。
    pub skipped_older: usize,
    /// 清单里提到、但文件不在的条数。**不静默**（规则 #15.3）。
    pub missing_files: usize,
}

/// 从一个增量目录应用到本地库。
///
/// ❗ 会**就地删除**暂存目录里那些「本地更新所以不该导入」的文件。
/// 传进来的目录应当是传输层刚落下的暂存目录，不是用户的 vault。
pub fn apply_delta(store: &DataStore, dir: &Path) -> Result<ApplyReport, String> {
    if !dir.is_dir() {
        return Err(format!("增量目录不存在: {}", dir.display()));
    }
    let mut rep = ApplyReport::default();

    // ① 按清单剔掉会输的那些文件，**在导入之前**。
    let manifest = std::fs::read_to_string(dir.join(MANIFEST)).unwrap_or_default();
    for line in manifest.lines().filter(|l| !l.trim().is_empty()) {
        let mut it = line.split('\t');
        let (Some(id), Some(ms), Some(rel)) = (it.next(), it.next(), it.next()) else {
            return Err(format!("清单行格式不对：{}", line));
        };
        let incoming: i64 = ms
            .parse()
            .map_err(|_| format!("清单里的时间戳不是数字：{}", line))?;
        let path = dir.join(rel);
        if !path.is_file() {
            // 清单说有、文件却不在：传输被截断了。报出来，别当成「这篇没变」。
            rep.missing_files += 1;
            continue;
        }
        // 本地没有这篇 ⇒ 一定要导入（新建）。
        // 本地有且**不更旧** ⇒ 跳过，本地赢。
        if let Some(local) = store.note_updated_ms(id) {
            if local >= incoming {
                let _ = std::fs::remove_file(&path);
                rep.skipped_older += 1;
            }
        }
    }

    // ② 剩下的交给现成的导入。导入侧代码一行不改。
    let imported = store.note_import_dir(&dir.to_string_lossy())?;
    rep.created = imported.created;
    rep.updated = imported.updated;

    // ③ 墓碑传播：把对端删掉的也在本地软删。
    //
    // 🔴 顺序必须在导入**之后**：先删后导的话，同一批里那篇笔记会被
    //    刚导入的文件又建回来——删除等于没发生。
    let tomb = std::fs::read_to_string(dir.join(TOMBSTONES)).unwrap_or_default();
    for line in tomb.lines().filter(|l| !l.trim().is_empty()) {
        let mut it = line.split('\t');
        let (Some(id), Some(_ms)) = (it.next(), it.next()) else {
            return Err(format!("墓碑行格式不对：{}", line));
        };
        // 已经没有或已在回收站的，不重复删也不报错——同一条删除会被多次同步过来。
        if store.note_get(id)?.is_some() {
            store.note_delete(id)?;
            rep.deleted += 1;
        }
    }
    Ok(rep)
}
