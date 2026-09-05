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
    // 三元组：(note_id, tombstone_ms, local_ms)。
    let rows = store.note_tombstones_since(since_ms)?;
    // 🔴 游标用 `local_ms`，不用 `tombstone_ms`——必须与筛选字段一致。
    //
    // 转发一条旧删除时两者差得很远（tombstone_ms 是一周前、local_ms 是现在）：
    // 拿 tombstone_ms 算游标的话，`.max(since_ms)` 会把它压回 since，游标原地踏步，
    // 于是下次同步同一条墓碑**又被取到、又发一遍**，永不收敛。
    let cursor_ms = notes
        .iter()
        .filter_map(|n| store.note_updated_ms(&n.id))
        .chain(rows.iter().map(|(_, _, local_ms)| *local_ms))
        .max()
        .unwrap_or(since_ms)
        .max(since_ms);
    // 上线只带 (id, tombstone_ms)：local_ms 是**本机的**记账，对端拿去没意义，
    // 而且 LWW 要比的是源头删除时刻。
    let tombstones = rows
        .into_iter()
        .map(|(id, tomb_ms, _)| (id, tomb_ms))
        .collect();
    Ok(Delta {
        notes,
        tombstones,
        cursor_ms,
    })
}

/// 记一条「没落地」的时间戳。取最小值，见 [`ApplyReport::unsettled_min_ms`]。
fn note_unsettled(rep: &mut ApplyReport, ms: i64) {
    rep.unsettled_min_ms = Some(match rep.unsettled_min_ms {
        Some(cur) => cur.min(ms),
        None => ms,
    });
}

/// 两边是不是**同一个内容版本**。比标题、正文、标签。
///
/// 🔴 **不能直接比整份文件的字节。** 前置字段里的 `created` / `updated`
/// 是**本机时间字串**，同一篇笔记在两台机器上必然不同——
/// 第一版就是按字节比的，测试直接 red，靠的就是这一条。
///
/// 也不比 `summary`：它是 AI 生成的，按设计**不抬 `updated_ms`**
/// （见 `note.rs` 里列的四个故意不抬的地方），
/// 所以只有摘要不同的笔记根本不会进增量。
fn same_version(local: &Note, incoming_md: &str) -> bool {
    let p = crate::data_store::markdown_to_note(incoming_md, &local.title);
    if p.title != local.title || p.content != local.content {
        return false;
    }
    let mut theirs: Vec<&str> = p.tags.iter().map(|s| s.as_str()).collect();
    let mut mine: Vec<&str> = local.tags.iter().map(|t| t.name.as_str()).collect();
    theirs.sort_unstable();
    mine.sort_unstable();
    theirs == mine
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
    /// 内容与本地一模一样、直接跳过的条数（回声）。见下面那条拦截。
    pub identical: usize,
    /// 导入阶段真正失败的条数。**不静默**（规则 #15.3）。
    pub import_failed: usize,
    /// 没落地的条目里**最小的那个时间戳**。调用方拿它夹游标。
    ///
    /// # 🔴 为什么不是一个 `bool`（「有没有失败」）
    ///
    /// 第一版是「一旦有失败就完全不推游标」。那会引出一个更坏的东西——
    /// **冲突副本风暴**：游标钉在低位 `C`，而真冲突的判据是
    /// `local > C && incoming > C`。于是任何一篇「我本地改过、对端还是旧版」的笔记
    /// 都会**每轮生一份冲突副本**——与 `705d6af` 修掉的是同一类事，只是换了个门进来。
    ///
    /// 夹到「最小未落地戳 − 1」就同时满足两件事：
    /// 已经落地的那些过了游标（不再被重发、也不再参与冲突判定），
    /// 没落地的那几篇下一轮会重来。
    pub unsettled_min_ms: Option<i64>,
    /// 检测到的真冲突数（两边都在上次同步之后改过）。每个都留了一份冲突副本。
    pub conflicts: usize,
    /// 🔴 对端时钟超前太多，本机拒绝吸收时的超前毫秒数。
    ///
    /// 非 `None` 意味着一个**必须让人知道**的后果：
    /// 本机之后赢不过那台机器的笔记（它的时间戳永远更大），
    /// 用户会看到「自己改的东西总是不生效」而不知道为什么。真正的修法是去修钟。
    pub clock_too_far_ahead_ms: Option<i64>,
}

/// 从一个增量目录应用到本地库。
///
/// ❗ 会**就地删除**暂存目录里那些「本地更新所以不该导入」的文件。
/// 传进来的目录应当是传输层刚落下的暂存目录，不是用户的 vault。
/// `since_cursor` = 与这台对端上次同步到哪儿（[`DataStore::device_cursor`]）。
/// **冲突检测靠它**：HLC 只给全序，不告诉你两边是不是各改了一次。
/// 传 `0` = 从头同步，那时一切都算「对端的新东西」，不判冲突。
pub fn apply_delta(
    store: &DataStore,
    dir: &Path,
    since_cursor: i64,
) -> Result<ApplyReport, String> {
    if !dir.is_dir() {
        return Err(format!("增量目录不存在: {}", dir.display()));
    }
    let mut rep = ApplyReport::default();
    // 会被导入的条目的「对端版本戳」。导入完之后要把它们盖回去，见 ③ 之后。
    let mut keep_stamp: Vec<(String, i64, PathBuf)> = Vec::new();

    // ① 先吸收对端时钟（HLC，§7.5 档②），**在任何本地写入之前**。
    //
    // 🔴 顺序很要紧：下面的导入会调 `note_update` → `hlc_now()`。
    //    先吸收，本机接下来发的时间戳才会高于对端那一批；
    //    反过来的话，导入产生的时间戳可能还低于刚收到的那些，
    //    于是本机在自己刚应用的东西之上做的修改，反而判输。
    let manifest = std::fs::read_to_string(dir.join(MANIFEST)).unwrap_or_default();
    let tomb_raw = std::fs::read_to_string(dir.join(TOMBSTONES)).unwrap_or_default();
    let remote_max = manifest
        .lines()
        .chain(tomb_raw.lines())
        .filter_map(|l| l.split('\t').nth(1))
        .filter_map(|v| v.parse::<i64>().ok())
        .max();
    if let Some(rm) = remote_max {
        match store.absorb_remote_clock(rm) {
            crate::sync::hlc::Absorb::Ok => {}
            crate::sync::hlc::Absorb::TooFarAhead { ahead_ms } => {
                log::warn!(
                    "[Sync] 对端时钟比本机快 {} 毫秒，拒绝吸收。                     本机之后无法覆盖那台机器的笔记——请检查两台机器的系统时间。",
                    ahead_ms
                );
                rep.clock_too_far_ahead_ms = Some(ahead_ms);
            }
        }
    }

    // ② 按清单剔掉会输的那些文件，**在导入之前**。
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
            note_unsettled(&mut rep, incoming);
            continue;
        }
        // 本地没有这篇 ⇒ 一定要导入（新建），不可能有冲突。
        let Some(local) = store.note_updated_ms(id) else {
            keep_stamp.push((id.to_string(), incoming, path.clone()));
            continue;
        };

        // 🔴 内容一模一样 ⇒ 没什么可合的：不导入、不算冲突、也不算「输」。
        //
        // 这条挡的是**回声**：会话中途失败、或两端游标不一致时，
        // 对端会把我们已经有的那一批原样送回来。少了这条，那一批的每一篇都满足
        // 「本地 > 游标 且 对端 > 游标」（导入时戳是跟着内容走的，见 ④），
        // 于是**每篇都生一份冲突副本**，而且每轮再生一次。
        //
        // 只比内容、不比时间戳：戳相同而内容不同是**真的平手**
        // （两台机器可能吸收同一个下界之后发出同一个值），那种情况仍走下面的判定。
        let incoming_text = std::fs::read_to_string(&path).unwrap_or_default();
        let identical = store
            .note_get(id)?
            .map(|n| same_version(&n, &incoming_text))
            .unwrap_or(false);
        if identical {
            let _ = std::fs::remove_file(&path);
            rep.identical += 1;
            continue;
        }

        // 🔴 真冲突的判据：**两边都在上次同步之后改过**。
        //
        //   §7.4 原本把真冲突定义成「同毫秒两端不同改（概率极低）」，
        //   而 §7.5 已经推翻了那个定义。HLC 给了全序，但全序**不告诉你并发**——
        //   「B 在看到 A 那版之后改的」和「B 独立改的」在时间戳上长得一样。
        //
        //   游标是我们手里唯一的「共同祖先」标记：上次同步时两边是一致的，
        //   所以「本地 > 游标」且「对端 > 游标」就是各改了一次。
        let both_changed = local > since_cursor && incoming > since_cursor;

        if local >= incoming {
            // 本地赢。冲突时把**对端那份**留成副本，否则它就没了。
            if both_changed {
                save_conflict_copy(store, id, &incoming_text, incoming, "对端")?;
                rep.conflicts += 1;
            }
            let _ = std::fs::remove_file(&path);
            rep.skipped_older += 1;
        } else {
            // 对端赢 ⇒ 导入之后要把对端的戳盖回来（见下面的说明）。
            keep_stamp.push((id.to_string(), incoming, path.clone()));
        }
        if local < incoming && both_changed {
            // 对端赢，但本地那份也是真改动 ⇒ 先把**本地这份**留成副本，再让导入覆盖它。
            let local_note = store.note_get(id)?;
            if let Some(n) = local_note {
                let text = crate::data_store::note_to_markdown(&n, false);
                save_conflict_copy(store, id, &text, local, "本机")?;
                rep.conflicts += 1;
            }
        }
    }

    // ③ 剩下的交给现成的导入。导入侧代码一行不改。
    let imported = store.note_import_dir(&dir.to_string_lossy())?;
    rep.created = imported.created;
    rep.updated = imported.updated;
    // 🔴 `failed` 不能丢。之前只取 created/updated，于是单篇导入失败
    //    （读文件出错 / 写库出错）既不进报告、游标又照常前进——那几篇
    //    **再也不会被重发**，是永久且完全无痕的丢数据。
    //    与 `missing_files` 被认真上报的做法自相矛盾，现在两者一致：
    //    都报出来，且都让调用方按住游标（见 `session::run`）。
    rep.import_failed = imported.failed.len();
    for f in &imported.failed {
        log::warn!("[Sync] 单篇导入失败：{}", f);
    }

    // 🔴 逐条核对**内容是不是真的进来了**，而不是只看「这条在不在」。
    //
    // `imported.failed` 给的是「相对路径：原因」，反查不回 id，所以不解析它。
    // 但只判 `note_get(id).is_none()` 也不够：`keep_stamp` 里既有新建也有更新，
    // **更新失败时旧行还在**，`is_none()` 是 false → 不算未落地 → 游标照推。
    // 而紧接着的 ④ 又会把**对端的戳盖到本地这份旧内容上**，此后每轮都是
    // `local >= incoming` → 判成 skipped_older，对端再发多少次都进不来：
    // 内容永久停在旧版，界面上却显示成最新的。
    //
    // 可达路径很具体：导出侧不限大小、传输上限 256MiB，而 `import_one` 的
    // `MAX_IMPORT_BYTES` 是 10MiB —— 一篇超过 10MiB 的笔记每轮导入必失败。
    let mut landed: Vec<(String, i64)> = Vec::new();
    for (id, ms, path) in &keep_stamp {
        let ok = match store.note_get(id)? {
            Some(n) => {
                let text = std::fs::read_to_string(path).unwrap_or_default();
                same_version(&n, &text)
            }
            None => false,
        };
        if ok {
            landed.push((id.clone(), *ms));
        } else {
            note_unsettled(&mut rep, *ms);
        }
    }

    // ④ 🔴 **把对端的版本戳盖回去。** 这一步不是优化，是 LWW 的前提。
    //
    // `note_import_dir` 走 `note_update` / `note_create`，两者都会用**本机** HLC
    // 发一个新的 `updated_ms`。于是同一份内容在两台机器上戳不一样——
    // 而 LWW 是靠比这个戳判胜负的，戳一不一样，比较就没有意义：
    //
    // - B 刚导入的那份（没改过）会带着一个可能更大的戳，
    //   于是 **A 之后的真实编辑反而判输**；
    // - 「本地 > 游标」也不再表示「本地改过」，冲突检测跟着误判。
    //
    // 正解是把 `updated_ms` 当成**内容版本的戳**，不是「本地这行何时被碰过」。
    // 复制一份内容不产生新版本，所以戳要跟着内容走。
    //
    // ❗ 这里是**故意把戳往下调**（可能低于刚才 `MAX(?, updated_ms+1)` 抬上去的值）。
    //   本机单调性不受影响：下一次真的本地编辑会走 HLC，而 HLC 的下界
    //   在 ① 已经吸收过对端最大值了。
    {
        let conn = store.lock_conn();
        // ❗ 只盖**真正落地**的那些。盖到导入失败的旧内容上，
        //   等于给旧版本贴了个新版本号，之后再也没人能覆盖它。
        for (id, ms) in &landed {
            if let Err(e) = conn.execute(
                "UPDATE notes SET updated_ms = ?2 WHERE id = ?1",
                rusqlite::params![id, ms],
            ) {
                log::warn!("[Sync] 盖回版本戳失败 {}: {}", id, e);
            }
        }
    }

    // ⑤ 墓碑传播：把对端删掉的也在本地软删。
    //
    // 🔴 顺序必须在导入**之后**：先删后导的话，同一批里那篇笔记会被
    //    刚导入的文件又建回来——删除等于没发生。
    for line in tomb_raw.lines().filter(|l| !l.trim().is_empty()) {
        let mut it = line.split('\t');
        let (Some(id), Some(ms)) = (it.next(), it.next()) else {
            return Err(format!("墓碑行格式不对：{}", line));
        };
        let tomb_ms: i64 = ms
            .parse()
            .map_err(|_| format!("墓碑里的时间戳不是数字：{}", line))?;

        // 🔴 先记对端墓碑，再软删，顺序不能反。
        //
        // 记墓碑是为了本机能把这条删除**继续转发给第三台**（§12.12）：
        // A 删 → B 收到并软删 → B↔C 同步时清单里得有它，否则 C 永远保留那篇。
        //
        // 用对端给的 `tomb_ms` 而不是本机删除时刻：删除意图发生在源头，
        // LWW 要拿它与对端可能存在的更新编辑比大小。
        // 而下面 `note_delete` 内部也会落一次墓碑，它用的是 `INSERT OR IGNORE`——
        // 先记的这一条（带源头时刻）会赢，正是想要的。
        //
        // ❗ 这一步曾经写过又被撤回，因为当时墓碑不分类：补落之后用户在本机还原，
        //   本机仍会把墓碑广播出去把还原的副本又删掉，且 `note_is_tombstoned`
        //   会让这个 id 再也导不进来——完全静默。现在两个前提都已改掉：
        //   墓碑分 `purged` 0/1，`note_restore_deleted` 会把 0 那一类撤掉，
        //   `note_is_tombstoned` 只认 1。**三处是一体的，单拿任一处都会重新引入那个 bug。**
        store.note_record_remote_tombstone(id, tomb_ms);

        // 已经没有或已在回收站的，不重复删也不报错——同一条删除会被多次同步过来。
        if store.note_get(id)?.is_some() {
            store.note_delete(id)?;
            rep.deleted += 1;
        }
    }
    Ok(rep)
}

/// 把冲突里**输的那一份**存成一篇新笔记。
///
/// # 🔴 为什么不按 §7.4 写成 `.sync-conflict.<NodeId>.<ms>.md` 文件
///
/// 设计稿那个形式来自「vault 目录 + Syncthing 式冲突文件」的思路。但我们的
/// **合并目标是数据库**，写文件会引出两个问题：放在哪个目录（同步目录还没定），
/// 以及**用户可能永远不去看**。
///
/// 存成一篇笔记则是：立刻在知识库里看得见、能用现成的编辑器对比合并、
/// 能被搜索到、还自动进版本历史。**同一个目的（双版本保留 + 人工合并），
/// 更少的活动部件，而且不需要新界面。**
///
/// 带一行 `- [conflict]`（AM-7 的行内类别）——于是
/// `kb_search(kind="conflict")` 就是那个「冲突列表」，不用另做设置页。
fn save_conflict_copy(
    store: &DataStore,
    origin_id: &str,
    losing_markdown: &str,
    losing_ms: i64,
    losing_side: &str,
) -> Result<(), String> {
    let title = store
        .note_get(origin_id)
        .ok()
        .flatten()
        .map(|n| n.title)
        .unwrap_or_else(|| "（无标题）".to_string());

    let body = format!(
        "- [conflict] 这是一份**冲突副本**，来自**{}**那一份（时间戳 {}）。\n\
         \n\
         两台机器在上次同步之后都改过《{}》，后写胜保留了另一份。\n\
         这一份没有丢，但**也没有被自动合并**——请自己比对后处理，处理完删掉本篇。\n\
         \n\
         原笔记 id：`{}`\n\
         \n\
         ---\n\
         \n\
         {}\n",
        losing_side, losing_ms, title, origin_id, losing_markdown
    );
    store
        .note_create(None, &format!("{}（冲突副本 {}）", title, losing_ms), &body)
        .map(|_| ())
}
