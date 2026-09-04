//! data_store/note_vault.rs —— 笔记目录的导出 / 导入（B1 #5 / D1）。
//!
//! 设计稿：design/PastePanda-MD导出导入-设计稿.html。
//! frontmatter 的生成与解析在 `note_md.rs`；这里只管目录、文件与匹配。
//!
//! # 为什么整个写文件的活在 Rust
//!
//! 前端只用 dialog 选目录，把路径交过来。好处三条：
//! ① N 篇笔记一次 IPC（而不是 N+ 次）；② 不需要 fs 插件的 mkdir 权限；
//! ③ 导入反正必须在 Rust，放一起才不会出现两份 frontmatter 实现。
//!
//! 🔴 红线：无 AI。全程只在本机文件系统与本机 SQLite 之间走。

use super::note_md::{markdown_to_note, note_to_markdown, safe_file_stem};
use super::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// 导出的笔记上限。个人规模远达不到，写一个只是不想让 SQL 拿到 u32::MAX。
const EXPORT_CAP: u32 = 100_000;

/// 导入时新建标签的颜色。外部文件里只有标签名，颜色用户自己改。
const IMPORT_TAG_COLOR: &str = "#6B7280";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportReport {
    pub notes: i64,
    pub folders: i64,
    /// 本次清理掉的**陈旧** `.md`（相对路径）。
    ///
    /// ❗ 这个字段背后的清理动作修的是一个真会丢数据的闭环：导出侧以前
    ///   **从不删文件**，于是笔记删掉后 vault 里那个 `.md` 永远留着；下次导入时
    ///   `note_get` 与 `find_note_by_title` 都带 `deleted_at IS NULL`，两级匹配
    ///   都认不出它 —— 于是走 `note_create`，**复活成一条新 id 的笔记**。
    ///   不需要第二台机器：单机「导出 → 删除 → 导入」就会发生。
    ///
    /// 只删三条件全中的文件：① 在导出目录树内；② 能解析出 `pastepanda_id`；
    /// ③ 该 id 已不在库里（或已进回收站）。**没有 `pastepanda_id` 的一律不动** ——
    /// 说明页明确请用户「把本目录当 vault 打开」，里面很可能有他自己写的 `.md`。
    pub removed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportReport {
    pub created: i64,
    pub updated: i64,
    pub skipped: i64,
    /// 目录深度超过 [`MAX_FOLDER_DEPTH`]、被**平接到最深一层**的篇数。
    ///
    /// ❗ 这个字段本来没有，而平接是一次**用户完全看不见的降级**：
    ///   深目录结构默默消失，而报告里的 created/updated 看上去完全正常。
    ///   平接本身是设计稿定的（不是 bug），但不告知是（规则 #15.3）。
    pub flattened: i64,
    /// 当前的文件夹深度上限（= [`MAX_FOLDER_DEPTH`]）。
    ///
    /// ❗ 跟着 `flattened` 一起发，是为了让前端不用写死这个数字。
    ///   上限已经从 3 改到过 4，而当时 toast 里那句「最多 3 层」是写死的
    ///   ——不带这个字段的话，下一次改常量它就又对不上了，而编译器不会报。
    pub max_depth: i64,
    /// 平接后撞上【同一文件夹 + 同标题】、因而**另建了一条**的文件（相对路径）。
    ///
    /// ❗ 修的是一个真丢数据的 bug：以前第二个文件会命中第一个刚建出的笔记并
    ///   `note_update` **覆盖它的正文**——两篇不同的笔记导完只剩一篇，
    ///   而报告显示「新增 1、更新 1」。现在宁可出现两条同名笔记也不丢内容。
    pub collided: Vec<String>,
    /// `pastepanda_id` 指向一条**已被删除**的笔记、因而被**跳过**的文件（相对路径）。
    ///
    /// 「已被删除」含两种：还在回收站的，以及已被物理清、只剩墓碑的（M6-P4）。
    /// 两者的处置一样（跳过），所以合用一个字段；但提示语得把两种都说到，
    /// 只说「去回收站恢复」对后一种是句假话。
    ///
    /// ❗ 跳过而不是恢复：用户的删除是比这个文件更近的操作，而导入的语义是
    ///   「只新增与更新，永远不删」—— 替他把刚删的笔记恢复回来等于替他改主意。
    ///   想找回就去回收站，那里本来就有。
    ///
    /// 不跳过的话就是上面 `removed` 注释里那条复活链路：认不出墓碑 ⇒ 另建新 id。
    pub in_trash: Vec<String>,
    /// 失败的文件，形如 `相对路径：原因`。**不静默**（规则 #15.3）。
    ///
    /// ❗ 以前这里只有文件名且**只装得下「读不出来」一种失败**：其余每一步都是 `?`
    ///   直接向外抛，一旦中途出错，已经累计的 created/updated **随之丢弃**——
    ///   用户只看到「导入失败」，但库里其实已经进了一批，且不知道进了哪些。
    ///   现在**单篇失败只让那一篇失败**，整次结果照旧返回。
    pub failed: Vec<String>,
}

/// 单个 `.md` 的导入上限。
///
/// 10MB 对齐 `commands/system.rs` 读文本文件的同一个限制（那边报「文件过大」）；
/// 图片/PDF 那条线是 20MB/50MB（`commands/images.rs`）。
///
/// ❗ 这条路上之前**一个限制都没有**：裸 `read_to_string`，既不预检也不截断，
/// 一个 500MB 的 `.md` 会整份读进内存再整份塞进 SQLite。而同项目别处都有线，
/// 所以这是**遗漏而不是取舍**。
const MAX_IMPORT_BYTES: u64 = 10 * 1024 * 1024;

/// 导入一篇的结果。不导出：它只是 `import_one` 与主循环之间的内部交接。
struct ImportOne {
    /// true = 新建，false = 命中已有笔记并更新。
    created: bool,
    /// 它的目录层级超限、被平接了。
    flattened: bool,
    /// 它想命中的笔记已被本次导入的另一个源文件认领，所以另建了一条。
    collided: bool,
    /// 它的 `pastepanda_id` 指向一条已在回收站的笔记 ⇒ 整篇跳过。
    ///
    /// 这一位为 true 时，上面三位都无意义（既没建也没更新）。
    in_trash: bool,
}

/// 报告里用的相对路径（形如 `A/B/C/x.md`）。
///
/// 不用绝对路径：它带着用户的全盘符与目录名，而 toast 里就那么宽。
/// 也不用光文件名：撞车的往往正是不同目录下的同名文件。
fn rel_label(rel_dirs: &[String], path: &std::path::Path) -> String {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("?")
        .to_string();
    if rel_dirs.is_empty() {
        name
    } else {
        format!("{}/{}", rel_dirs.join("/"), name)
    }
}

/// 导出目录里的说明页文件名。下划线开头让它在 Obsidian 里排在前面。
const README_NAME: &str = "_PastePanda导出说明.md";

fn readme_text(notes: i64, folders: i64) -> String {
    format!(
        "---\ntitle: PastePanda 导出说明\n---\n\n\
         这个目录是 PastePanda 导出的笔记，共 **{notes} 篇**，分布在 **{folders} 个文件夹**里。\n\n\
         ## 直接用 Obsidian 打开\n\n\
         把本目录当作一个 vault 打开即可。每篇笔记的 frontmatter 里写了 `title` / `tags` /\n\
         `created` / `updated`，都是 Obsidian 认的字段名。\n\n\
         ## 怎么导回去\n\n\
         PastePanda → 设置 → 数据管理 → 「从 Markdown 目录导入」，选这个目录。\n\n\
         每篇笔记的 frontmatter 里有一行 `pastepanda_id`，导回时靠它认人——\
         **改文件名、换文件夹都不要紧**，但别删那一行。\n\n\
         导入是**合并**不是同步：它只新增与更新，**永远不删** PastePanda 里的笔记。\n\
         被更新的笔记会自动留一份导入前的版本快照，在笔记的「历史」里可以回退。\n\n\
         ## 删掉的笔记不会回来\n\n\
         如果这里某个 `.md` 对应的笔记已经在 PastePanda 的回收站里，导入会**跳过**它。\n\
         想找回请去回收站恢复，而不是靠重新导入。\n\n\
         重新导出到本目录时，这些已删笔记留下的旧文件会被**清理掉**。只清理带\n\
         `pastepanda_id` 的文件——你自己在这里写的 `.md` 不会被动。\n\n\
         ## 哪些东西没导\n\n\
         - **图片与附件**：目前的图片笔记存的是识别出的文字 + 对原卡片的引用，\
         正文里本来就没有图片链接，所以导出目录里也不会有图。\n\
         - **剪贴板历史记录**：那是另一条路（设置 → 数据管理 → 导出数据，JSON）。\n"
    )
}

impl DataStore {
    /// 把全部笔记导出成一个可直接当 vault 打开的目录。
    /// 文件夹 id → 导出目录的绝对路径。
    ///
    /// 🔴 **抽出来是为了不让两条导出路径各算一遍**（规则 #11）：
    /// 全量导出与 M6 的增量导出必须把同一篇笔记放进同一个目录，
    /// 否则对端会看成「两个文件夹里各有一篇」——而那从报告上看不出来。
    ///
    /// 深度已由后端封死在 3 层，往上走不会失控。
    pub(super) fn folder_dir_map(folders: &[NoteFolder], root: &Path) -> HashMap<String, PathBuf> {
        Self::sync_folder_dir_map(folders, root)
    }

    /// 同上，给 `crate::sync::engine` 用（它在 `data_store` 之外，`pub(super)` 到不了）。
    pub fn sync_folder_dir_map(folders: &[NoteFolder], root: &Path) -> HashMap<String, PathBuf> {
        let by_id: HashMap<&str, &NoteFolder> =
            folders.iter().map(|f| (f.id.as_str(), f)).collect();
        let mut dir_of: HashMap<String, PathBuf> = HashMap::new();
        for f in folders {
            let mut parts: Vec<&str> = vec![f.name.as_str()];
            let mut cur = f.parent_id.as_deref();
            while let Some(pid) = cur {
                match by_id.get(pid) {
                    Some(p) => {
                        parts.push(p.name.as_str());
                        cur = p.parent_id.as_deref();
                    }
                    None => break, // 孤岛：当顶层处理，与前端 buildFolderTree 同口径
                }
            }
            parts.reverse();
            let mut p = root.to_path_buf();
            for seg in parts {
                p.push(safe_file_stem(seg, &f.id));
            }
            dir_of.insert(f.id.clone(), p);
        }
        dir_of
    }

    pub fn note_export_dir(&self, root: &str) -> Result<ExportReport, String> {
        let root = PathBuf::from(root);
        if !root.is_dir() {
            return Err(format!("目录不存在: {}", root.display()));
        }

        let folders = self.folder_list()?;
        let dir_of = Self::folder_dir_map(&folders, &root);

        let notes = self.note_list("all", &[], EXPORT_CAP, 0)?;

        // 「还活着的笔记」id 集合，给最后的陈旧文件清理用。
        // `note_list("all", ..)` 本身就排掉了回收站里的，所以不用再滤一道。
        let live_ids: std::collections::HashSet<&str> =
            notes.iter().map(|n| n.id.as_str()).collect();

        // 同一目录下的重名计数。笔记标题库里没唯一约束，不编号就互相覆盖、静默丢笔记。
        let mut used: HashMap<PathBuf, u32> = HashMap::new();
        let mut written = 0i64;

        for n in &notes {
            let dir = match n.folder_id.as_deref().and_then(|id| dir_of.get(id)) {
                Some(d) => d.clone(),
                None => root.clone(), // 未分类 ⇒ 根目录
            };
            std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败: {e}"))?;

            let stem = safe_file_stem(&n.title, &n.id);
            let key = dir.join(stem.to_lowercase()); // Windows 文件名不区分大小写
            let seq = used.entry(key).or_insert(0);
            *seq += 1;
            let name = if *seq == 1 {
                format!("{stem}.md")
            } else {
                format!("{stem} ({seq}).md")
            };

            std::fs::write(dir.join(&name), note_to_markdown(n, true))
                .map_err(|e| format!("写文件失败 {name}: {e}"))?;
            written += 1;
        }

        let folder_count = folders.len() as i64;
        std::fs::write(root.join(README_NAME), readme_text(written, folder_count))
            .map_err(|e| format!("写说明文件失败: {e}"))?;

        // 清理陈旧 `.md`。必须放在全部写完**之后**：这一轮刚写出的文件
        // id 全在 `live_ids` 里，所以扫不到它们；放在写之前则多一次无用扫盘。
        Ok(ExportReport {
            notes: written,
            folders: folder_count,
            removed: prune_stale_md(&root, &live_ids),
        })
    }

    /// 从一个 Markdown 目录导入。**合并语义：只新增与更新，永远不删。**
    pub fn note_import_dir(&self, root: &str) -> Result<ImportReport, String> {
        let root = PathBuf::from(root);
        if !root.is_dir() {
            return Err(format!("目录不存在: {}", root.display()));
        }

        let mut files: Vec<(PathBuf, Vec<String>)> = Vec::new();
        let mut skipped = 0i64;
        collect_md(&root, &mut Vec::new(), &mut files, &mut skipped)?;

        let mut rep = ImportReport {
            created: 0,
            updated: 0,
            skipped,
            flattened: 0,
            max_depth: MAX_FOLDER_DEPTH,
            collided: Vec::new(),
            in_trash: Vec::new(),
            failed: Vec::new(),
        };

        // 本次导入已经被**某个源文件认领**的笔记 id。
        //
        // ❗ 这是修「平接后互相覆盖」的关键：【文件夹 + 标题】匹配本身没错（它让
        //   重复导入幂等），错的是它把**两个不同的源文件**当成了同一篇笔记。
        //   一次导入内，一篇笔记只能被一个源文件认领；第二个来抢的只能另建。
        let mut claimed: std::collections::HashSet<String> = std::collections::HashSet::new();

        for (path, rel_dirs) in files {
            // 报告里用**相对路径**而不是光文件名：出问题的往往正是多层目录里
            // 的同名文件，只报 `x.md` 用户根本分不出是哪一个。
            let label = rel_label(&rel_dirs, &path);
            match self.import_one(&path, &rel_dirs, &mut claimed) {
                // 墓碑：既没建也没更新，不能计进 created/updated，否则报告里
                // 会出现一条根本没发生的变更。
                Ok(o) if o.in_trash => rep.in_trash.push(label),
                Ok(o) => {
                    if o.flattened {
                        rep.flattened += 1;
                    }
                    if o.collided {
                        rep.collided.push(label);
                    }
                    if o.created {
                        rep.created += 1;
                    } else {
                        rep.updated += 1;
                    }
                }
                // 单篇失败只让那一篇失败。以前这里是 `?`，中途出错会把整份报告丢掉
                // （而库里已经进了一批，用户却只看到一句「导入失败」）。
                Err(e) => rep.failed.push(format!("{label}：{e}")),
            }
        }

        Ok(rep)
    }

    /// 导入**一篇**的结果。拆出来是为了让上层能用 `?`，
    /// 而失败只落到这一篇头上、不拖垮整次导入。
    fn import_one(
        &self,
        path: &std::path::Path,
        rel_dirs: &[String],
        claimed: &mut std::collections::HashSet<String>,
    ) -> Result<ImportOne, String> {
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("无标题")
            .to_string();

        // 大小预检。放在 `read_to_string` **之前**：目的就是不把整份读进内存。
        // 拿不到 metadata 不当错（接着读，读不了自然会报）——不为一个预检
        // 把本来能导的文件拦下来。
        if let Ok(md) = std::fs::metadata(path) {
            if md.len() > MAX_IMPORT_BYTES {
                return Err(format!(
                    "文件过大（{:.1}MB，超过 {}MB 限制）",
                    md.len() as f64 / 1_048_576.0,
                    MAX_IMPORT_BYTES / 1_048_576
                ));
            }
        }

        // 非 UTF-8 / 读不了。原先只记个文件名，现在把原因也带上。
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("读不出来（{e}），或不是 UTF-8 文本"))?;

        let parsed = markdown_to_note(&text, &stem);

        // 墓碑检查。放在 `ensure_folder_path` **之前**：这一篇既然要跳过，
        // 就不该在库里给它留下一串空文件夹。
        //
        // 🔴 **两种「已删」都要认**（M6-P4）：
        //   · 还在回收站 → `note_is_in_trash`
        //   · 已被物理清（清空回收站 / 30 天自动清理）→ `note_tombstones`
        //
        // 只认前者的话有条静默的复活链路：物理清之后本地没有任何行记得它被删过，
        // 另一台机器上那份旧 `.md` 一导入就把它请回来。
        // **而 P0 修好之后这条链路更隐蔽**——现在会用原来那个 id 建回去，
        // 从库里看就像它从来没被删过。
        if let Some(id) = parsed.id.as_deref() {
            if self.note_is_in_trash(id)? || self.note_is_tombstoned(id) {
                return Ok(ImportOne {
                    created: false,
                    flattened: false,
                    collided: false,
                    in_trash: true,
                });
            }
        }

        let (folder_id, flattened) = self.ensure_folder_path(rel_dirs)?;

        // 三级匹配（设计稿 §4）：先 id，再【文件夹 + 标题】，都没有就新建。
        let matched = match parsed.id.as_deref() {
            Some(id) if self.note_get(id)?.is_some() => Some(id.to_string()),
            _ => self.find_note_by_title(folder_id.as_deref(), &parsed.title)?,
        };

        // 已被本次导入的另一个源文件认领过 ⇒ 不能再覆盖它，另建一条。
        let collided = matched.as_deref().is_some_and(|id| claimed.contains(id));
        let existing = if collided { None } else { matched };

        // 🔴 P0：新建时优先**沿用文件里的 `pastepanda_id`**，别铸新的。
        //   以前一律铸新 uuid，于是同一篇笔记到了第二台机器就换了身份——
        //   删除传播按 id 找不到人，改个标题连「文件夹+标题」兜底都断。
        //   ❗ 两道门卡缺一不可，否则撞主键：
        //     ① 库里确实没有（有的话上面已经匹配到、走 update 了）；
        //     ② 本次导入还没被别的源文件认领（两个文件带同一个 id 的情形）。
        let keep_id: Option<String> = match parsed.id.as_deref() {
            Some(pid) if !claimed.contains(pid) && self.note_get(pid)?.is_none() => {
                Some(pid.to_string())
            }
            _ => None,
        };

        let (note_id, created) = match existing {
            Some(id) => {
                // 走 note_update ⇒ **自动留下一份导入前的快照**（#4 白送的）
                self.note_update(&id, &parsed.title, &parsed.content)?;
                (id, false)
            }
            None => {
                let n = match keep_id.as_deref() {
                    Some(pid) => self.note_create_keeping_id(pid, &parsed.title, &parsed.content)?,
                    None => self.note_create(None, &parsed.title, &parsed.content)?,
                };
                if folder_id.is_some() {
                    self.note_set_folder(&n.id, folder_id.as_deref())?;
                }
                (n.id, true)
            }
        };
        claimed.insert(note_id.clone());

        // 摘要只在文件里真有时写回去。缺这一行不能把库里已有的摘要抹了——
        // 用户可能是拿一个外部 vault 导进来的，那边根本没有 summary 字段。
        if let Some(sm) = parsed.summary.as_deref() {
            self.note_set_summary(&note_id, Some(sm))?;
        }

        if !parsed.tags.is_empty() {
            let ids = self.ensure_tag_ids(&parsed.tags)?;
            self.note_set_tags(&note_id, &ids)?;
        }

        Ok(ImportOne {
            created,
            flattened,
            collided,
            in_trash: false,
        })
    }

    /// 按相对目录链找 / 建文件夹。超过深度上限的层级**平接到最深一层**。
    ///
    /// 返回 `(文件夹 id, 是否发生了平接)`。第二个值是新加的：平接本身是设计稿定的，
    /// 但以前它**不留任何痕迹**，于是目录结构默默消失而报告看上去一切正常。
    fn ensure_folder_path(&self, rel: &[String]) -> Result<(Option<String>, bool), String> {
        let flattened = rel.len() > MAX_FOLDER_DEPTH as usize;
        let mut parent: Option<String> = None;
        for name in rel.iter().take(MAX_FOLDER_DEPTH as usize) {
            let all = self.folder_list()?;
            let hit = all
                .iter()
                .find(|f| f.parent_id.as_deref() == parent.as_deref() && &f.name == name)
                .map(|f| f.id.clone());
            parent = Some(match hit {
                Some(id) => id,
                None => self.folder_create(name, parent.as_deref())?.id,
            });
        }
        Ok((parent, flattened))
    }

    /// 这条 id 在库里存在，但**已经进了回收站**（软删）。
    ///
    /// 为何需要一个专门的查询：`note_get` 带 `deleted_at IS NULL`，所以它
    /// 分不清「id 不存在」与「id 在回收站里」—— 而导入对这两种情况的处置
    /// 正好相反：前者新建，后者跳过。以前两者都走新建，于是回收站里的
    /// 笔记会被 vault 里那份陈旧 `.md` 复活成一条新 id 的笔记。
    fn note_is_in_trash(&self, id: &str) -> Result<bool, String> {
        let conn = self.lock_conn();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE id = ?1 AND deleted_at IS NOT NULL",
                [id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    /// 【文件夹 + 标题】找一条笔记。标题库里不唯一，取最近改过的那条。
    fn find_note_by_title(
        &self,
        folder_id: Option<&str>,
        title: &str,
    ) -> Result<Option<String>, String> {
        let conn = self.lock_conn();
        let sql = match folder_id {
            Some(_) => {
                // 带 deleted_at：否则导入会认到一条已删的笔记头上，内容写进去了
                // 却因为它还在回收站而永远不显示——静默丢数据。
                "SELECT id FROM notes WHERE title = ?1 AND folder_id = ?2 AND deleted_at IS NULL
                 ORDER BY updated_at DESC LIMIT 1"
            }
            None => {
                // 排掉速记：外部拿来一个名为 2026-09-01.md 的文件时，宁可新建一条，
                // 也不能静默盖掉那天的速记（真正的速记往返靠 pastepanda_id 匹配，走不到这里）
                "SELECT id FROM notes WHERE title = ?1 AND folder_id IS NULL \
                 AND daily_date IS NULL AND deleted_at IS NULL
                 ORDER BY updated_at DESC LIMIT 1"
            }
        };
        let res = match folder_id {
            Some(f) => conn.query_row(sql, rusqlite::params![title, f], |r| r.get::<_, String>(0)),
            None => conn.query_row(sql, rusqlite::params![title], |r| r.get::<_, String>(0)),
        };
        match res {
            Ok(id) => Ok(Some(id)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    /// 标签名 → id，不存在就建。
    ///
    /// 两个调用方：MD 导入（文件里只有名字）与 AI 建议标签（模型只给名字）。
    /// 写两遍就会漂——比如一边做了 trim 另一边没做，结果是库里出现两个看上去一样的标签。
    pub(super) fn ensure_tag_ids(&self, names: &[String]) -> Result<Vec<String>, String> {
        let existing = self.get_tags()?;
        let mut out = Vec::with_capacity(names.len());
        for name in names {
            let n = name.trim();
            if n.is_empty() {
                continue;
            }
            match existing.iter().find(|t| t.name == n) {
                Some(t) => out.push(t.id.clone()),
                // 建失败（如超 50 字）就跳过这个标签，不连累整篇笔记
                None => {
                    if let Ok(t) = self.create_tag(n, IMPORT_TAG_COLOR) {
                        out.push(t.id);
                    }
                }
            }
        }
        Ok(out)
    }
}

/// 删掉导出目录里**已经不对应任何活笔记**的 `.md`，返回删掉的相对路径清单。
///
/// 三个条件全中才删，见 [`ExportReport::removed`] 的注释。这里只说为何
/// 每一条“不确定”都倒向**不删**：删用户目录里的文件不可逆，而漏删一个
/// 陈旧文件的代价只是它下次导入时被当墓碑跳过（已由导入侧兜住）。
///
/// ❗ 不删空目录：删完文件可能剩下一个空文件夹，Obsidian 里无害，
///   而递归删目录的误删面比删单文件大得多。
fn prune_stale_md(root: &Path, live_ids: &std::collections::HashSet<&str>) -> Vec<String> {
    let mut files: Vec<(PathBuf, Vec<String>)> = Vec::new();
    let mut ignored = 0i64;
    // 复用导入那套遍历：它已经排掉了 `.obsidian/` 等隐藏目录与说明页，
    // 而「导出会删哪些」与「导入会读哪些」本来就应该是同一个集合。
    if collect_md(root, &mut Vec::new(), &mut files, &mut ignored).is_err() {
        // 读不了目录就什么都不删。清理是附带动作，不该让导出本身失败。
        return Vec::new();
    }

    let mut removed = Vec::new();
    for (path, rel_dirs) in &files {
        // 读不出来（非 UTF-8 / 没权限 / 被占）⇒ 不动它。
        // 宁可留一个陈旧文件，也不能删一个我们没看懂的文件。
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        // 条件②：必须解析出 `pastepanda_id`。用户自己写的 `.md` 没有这一行，
        // 于是永远走不到删除；frontmatter 坏了的话 `markdown_to_note` 降级成
        // 「整文当正文」、id 也是 None —— 同样是不删，方向在安全那一边。
        let Some(id) = markdown_to_note(&text, "").id else {
            continue;
        };
        // 条件③：这个 id 已不在活笔记里 —— 被软删、被彻底清理，或它本来
        // 就来自别的库（那种文件导入时会被当成新笔记另给一个 id，
        // 内容早已落库并重新写成新文件，所以删这个外来壳不丢东西）。
        if live_ids.contains(id.as_str()) {
            continue;
        }
        match std::fs::remove_file(path) {
            Ok(()) => removed.push(rel_label(rel_dirs, path)),
            // 删不掉不算导出失败，但也**不静默**（规则 #15.3）：落日志。
            Err(e) => log::warn!("[Vault] 清理陈旧文件失败 {}: {}", path.display(), e),
        }
    }
    removed
}

/// 递归收集 .md。返回（文件路径, 相对目录链）。
fn collect_md(
    dir: &Path,
    rel: &mut Vec<String>,
    out: &mut Vec<(PathBuf, Vec<String>)>,
    skipped: &mut i64,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("读目录失败: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // .obsidian/ .git/ 等隐藏目录一律不进
        if name.starts_with('.') {
            *skipped += 1;
            continue;
        }
        if path.is_dir() {
            rel.push(name);
            collect_md(&path, rel, out, skipped)?;
            rel.pop();
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            // 导出时自己写的说明页不当笔记导回来
            if name == README_NAME {
                *skipped += 1;
                continue;
            }
            out.push((path, rel.clone()));
        } else {
            *skipped += 1;
        }
    }
    Ok(())
}
