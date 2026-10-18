use super::{ReadTask, StorageFile, StorageOverview};
use std::{fs, path::Path};

fn category(name: &str, database: &str) -> &'static str {
    if [
        database.to_owned(),
        format!("{database}-wal"),
        format!("{database}-shm"),
        format!("{database}-journal"),
    ]
    .iter()
    .any(|n| n == name)
    {
        "database"
    } else if matches!(name, "images" | "screenshots") {
        "images"
    } else if matches!(name, "thumbnails" | "source-icons" | "cache") {
        "cache"
    } else {
        "other"
    }
}

fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions can escape app_data_dir even when file_type().is_symlink() is false.
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

fn measure(
    path: &Path,
    task: &ReadTask,
    scan: bool,
) -> Result<(u64, bool, Option<String>), String> {
    task.check()?;
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) => return Ok((0, false, Some(format!("无法读取：{e}")))),
    };
    if is_link(&meta) {
        return Ok((0, false, Some("已跳过文件链接或目录联接".into())));
    }
    if meta.is_file() {
        return Ok((meta.len(), true, None));
    }
    if !meta.is_dir() {
        return Ok((0, false, Some("不支持的文件类型".into())));
    }
    if !scan {
        return Ok((0, false, None));
    }
    let mut bytes = 0;
    let mut error = None;
    let mut stack = vec![match fs::read_dir(path) {
        Ok(dir) => dir,
        Err(e) => return Ok((0, false, Some(format!("无法读取目录：{e}")))),
    }];
    // ReadDir stack keeps memory proportional to depth, rather than the number of files.
    while let Some(dir) = stack.last_mut() {
        task.check()?;
        let entry = match dir.next() {
            None => {
                stack.pop();
                continue;
            }
            Some(Ok(entry)) => entry,
            Some(Err(e)) => {
                error.get_or_insert_with(|| format!("部分文件无法读取：{e}"));
                continue;
            }
        };
        let meta = match fs::symlink_metadata(entry.path()) {
            Ok(meta) => meta,
            Err(e) => {
                error.get_or_insert_with(|| format!("部分文件无法读取：{e}"));
                continue;
            }
        };
        if is_link(&meta) {
            error.get_or_insert_with(|| "已跳过文件链接或目录联接".into());
        } else if meta.is_file() {
            bytes += meta.len();
        } else if meta.is_dir() {
            match fs::read_dir(entry.path()) {
                Ok(dir) => stack.push(dir),
                Err(e) => {
                    error.get_or_insert_with(|| format!("部分目录无法读取：{e}"));
                }
            }
        }
    }
    Ok((bytes, error.is_none(), error))
}

pub fn overview(db_path: &Path, task: &ReadTask, scan: bool) -> Result<StorageOverview, String> {
    // Missing/unreadable main database is a failure, never a plausible zero-byte result.
    fs::metadata(db_path).map_err(|e| format!("无法读取主数据库：{e}"))?;
    let root = db_path.parent().ok_or("无法确定数据目录")?;
    let database = db_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("数据库路径无效")?;
    let mut files = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| format!("无法读取数据目录：{e}"))? {
        task.check()?;
        let entry = entry.map_err(|e| format!("无法列出数据目录：{e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let (bytes, complete, error) = measure(&entry.path(), task, scan)?;
        files.push(StorageFile {
            category: category(&name, database),
            name,
            bytes,
            complete,
            error,
        });
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(StorageOverview {
        root_path: root.to_string_lossy().into_owned(),
        database_bytes: files
            .iter()
            .filter(|f| f.category == "database")
            .map(|f| f.bytes)
            .sum(),
        total_bytes: files.iter().map(|f| f.bytes).sum(),
        complete: files.iter().all(|f| f.complete),
        files,
        measured_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
    })
}
