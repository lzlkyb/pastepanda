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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportReport {
    pub created: i64,
    pub updated: i64,
    pub skipped: i64,
    /// 读失败 / 非 UTF-8 的文件名。**不静默**（规则 #15.3），结果里列出来。
    pub failed: Vec<String>,
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
         ## 哪些东西没导\n\n\
         - **图片与附件**：目前的图片笔记存的是识别出的文字 + 对原卡片的引用，\
         正文里本来就没有图片链接，所以导出目录里也不会有图。\n\
         - **剪贴板历史记录**：那是另一条路（设置 → 数据管理 → 导出数据，JSON）。\n"
    )
}

impl DataStore {
    /// 把全部笔记导出成一个可直接当 vault 打开的目录。
    pub fn note_export_dir(&self, root: &str) -> Result<ExportReport, String> {
        let root = PathBuf::from(root);
        if !root.is_dir() {
            return Err(format!("目录不存在: {}", root.display()));
        }

        let folders = self.folder_list()?;
        let by_id: HashMap<&str, &NoteFolder> =
            folders.iter().map(|f| (f.id.as_str(), f)).collect();

        // 文件夹 id → 相对路径。深度已由后端封死在 3 层，往上走不会失控。
        let mut dir_of: HashMap<&str, PathBuf> = HashMap::new();
        for f in &folders {
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
            let mut p = root.clone();
            for seg in parts {
                p.push(safe_file_stem(seg, &f.id));
            }
            dir_of.insert(f.id.as_str(), p);
        }

        let notes = self.note_list("all", &[], EXPORT_CAP, 0)?;

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

        let report = ExportReport {
            notes: written,
            folders: folders.len() as i64,
        };
        std::fs::write(
            root.join(README_NAME),
            readme_text(report.notes, report.folders),
        )
        .map_err(|e| format!("写说明文件失败: {e}"))?;

        Ok(report)
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
            failed: Vec::new(),
        };

        for (path, rel_dirs) in files {
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("无标题")
                .to_string();

            // 非 UTF-8 / 读不了：跳过并记下名字，不中断整次导入
            let Ok(text) = std::fs::read_to_string(&path) else {
                rep.failed.push(stem);
                continue;
            };

            let parsed = markdown_to_note(&text, &stem);
            let folder_id = self.ensure_folder_path(&rel_dirs)?;

            // 三级匹配（设计稿 §4）：先 id，再【文件夹 + 标题】，都没有就新建。
            let existing = match parsed.id.as_deref() {
                Some(id) if self.note_get(id)?.is_some() => Some(id.to_string()),
                _ => self.find_note_by_title(folder_id.as_deref(), &parsed.title)?,
            };

            let note_id = match existing {
                Some(id) => {
                    // 走 note_update ⇒ **自动留下一份导入前的快照**（#4 白送的）
                    self.note_update(&id, &parsed.title, &parsed.content)?;
                    rep.updated += 1;
                    id
                }
                None => {
                    let n = self.note_create(None, &parsed.title, &parsed.content)?;
                    if folder_id.is_some() {
                        self.note_set_folder(&n.id, folder_id.as_deref())?;
                    }
                    rep.created += 1;
                    n.id
                }
            };

            // 摘要只在文件里真有时写回去。缺这一行不能把库里已有的摘要抹了——
            // 用户可能是拿一个外部 vault 导进来的，那边压根没有 summary 字段。
            if let Some(sm) = parsed.summary.as_deref() {
                self.note_set_summary(&note_id, Some(sm))?;
            }

            if !parsed.tags.is_empty() {
                let ids = self.ensure_tag_ids(&parsed.tags)?;
                self.note_set_tags(&note_id, &ids)?;
            }
        }

        Ok(rep)
    }

    /// 按相对目录链找 / 建文件夹。超过深度上限的层级**平接到最深一层**。
    fn ensure_folder_path(&self, rel: &[String]) -> Result<Option<String>, String> {
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
        Ok(parent)
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
                "SELECT id FROM notes WHERE title = ?1 AND folder_id = ?2
                 ORDER BY updated_at DESC LIMIT 1"
            }
            None => {
                // 排掉速记：外部拿来一个名为 2026-09-01.md 的文件时，宁可新建一条，
                // 也不能静默盖掉那天的速记（真正的速记往返靠 pastepanda_id 匹配，走不到这里）
                "SELECT id FROM notes WHERE title = ?1 AND folder_id IS NULL AND daily_date IS NULL
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
