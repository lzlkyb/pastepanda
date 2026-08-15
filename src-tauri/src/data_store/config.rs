use super::*;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 审查 backlog：#11 备份限频 —— 1 分钟内至多备份一次配置（AI 设置保存会连发多次 save_config）
///
/// **`None` = 本进程还没备份过，下次必备**。
///
/// 原先写的是 `Instant::now() - Duration::from_secs(3600)`（拿“一小时前”当初值来保证首次必备），
/// 那是个**真 bug**：`Instant` 在 Windows 上从系统启动开始计时，开机不足 1 小时时
/// 这个减法会 underflow 并 panic（"overflow when subtracting duration from instant"）。
/// 而它在 `LazyLock` 里——一旦 panic 就中毒，**后续所有碰配置缓存的地方全挂**。
/// 用户开机后一小时内启动（开机自启动场景几乎必然）就会踩到。
///
/// 改成 `Option` 后根本不做时间减法：语义更直白，也不可能溢出。
/// （`ai/cache.rs:204` 已经用 `checked_sub` 避开了同一个坑，这处当时漏了。）
static LAST_BACKUP: LazyLock<Mutex<Option<Instant>>> = LazyLock::new(|| Mutex::new(None));
const BACKUP_INTERVAL: Duration = Duration::from_secs(60);

impl DataStore {
    pub fn get_stats(&self, workspace: &str) -> Result<Stats, String> {
        let conn = self.lock_conn();

        let total: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1",
                params![workspace],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let pinned: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1 AND pinned = 1",
                params![workspace],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let today_str = chrono::Local::now().format("%Y-%m-%d").to_string();
        let today: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1 AND time LIKE ?2",
                params![workspace, format!("{}%", today_str)],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let text_count: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1 AND type = 'text'",
                params![workspace],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        // 口径必须与 get_history 的「图片」筛选一致（type IN image/rich），
        // 否则标签页上的数字会小于实际筛出来的条数
        let image_count: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1 AND type IN ('image', 'rich')",
                params![workspace],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let file_count: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1 AND type = 'file'",
                params![workspace],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let earliest_time: Option<String> = conn
            .query_row(
                "SELECT MIN(time) FROM history WHERE workspace = ?1",
                params![workspace],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        // 估算数据库文件大小 (KB)
        let db_size_bytes = std::fs::metadata(self.path.clone())
            .map(|m| m.len())
            .unwrap_or(0);
        let db_size_kb = db_size_bytes as f64 / 1024.0;

        Ok(Stats {
            total,
            pinned,
            today,
            text_count,
            image_count,
            file_count,
            earliest_time,
            db_size_kb,
        })
    }

    /// 设置页「数据仪表盘」详细统计：一次返回总/置顶/今日/昨日、近 7 天按天聚合
    /// （缺日补 0）、24 小时时段分布、类型计数、来源 Top 5、最早记录与数据库大小。
    /// time 列格式为 "YYYY-MM-DD HH:MM:SS" 且有 idx_history_time 索引，
    /// substr 分组（1,10 取日期、12,2 取小时）可走索引扫描；全部查询共用单把连接锁。
    pub fn get_stats_detail(&self, workspace: &str) -> Result<StatsDetail, String> {
        let conn = self.lock_conn();
        let now = chrono::Local::now();

        let total: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1",
                params![workspace],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let pinned: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1 AND pinned = 1",
                params![workspace],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let today_str = now.format("%Y-%m-%d").to_string();
        let yesterday_str = (now - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();

        let today: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1 AND time LIKE ?2",
                params![workspace, format!("{}%", today_str)],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let yesterday: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1 AND time LIKE ?2",
                params![workspace, format!("{}%", yesterday_str)],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        // 近 7 天（含今天）按天聚合：SQL 只返回有数据的日期，Rust 侧按连续日期补 0
        let week_start = (now - chrono::Duration::days(6)).format("%Y-%m-%d").to_string();
        let mut day_map: std::collections::HashMap<String, u32> =
            std::collections::HashMap::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT substr(time, 1, 10) AS d, COUNT(*)
                     FROM history WHERE workspace = ?1 AND time >= ?2
                     GROUP BY d",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(
                    params![workspace, format!("{} 00:00:00", week_start)],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?)),
                )
                .map_err(|e| e.to_string())?;
            for row in rows {
                if let Ok((d, c)) = row {
                    day_map.insert(d, c);
                }
            }
        }
        let daily: Vec<DailyCount> = (0..7)
            .map(|i| {
                let date = (now - chrono::Duration::days(6 - i))
                    .format("%Y-%m-%d")
                    .to_string();
                let count = day_map.get(&date).copied().unwrap_or(0);
                DailyCount { date, count }
            })
            .collect();

        // 24 小时时段分布：substr(time, 12, 2) 取 "00".."23"，解析越界时忽略
        let mut hours = vec![0u32; 24];
        {
            let mut stmt = conn
                .prepare(
                    "SELECT substr(time, 12, 2) AS h, COUNT(*)
                     FROM history WHERE workspace = ?1
                     GROUP BY h",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![workspace], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                if let Ok((h, c)) = row {
                    if let Ok(idx) = h.parse::<usize>() {
                        if idx < 24 {
                            hours[idx] = c;
                        }
                    }
                }
            }
        }

        // 类型计数（参数化，避免三份重复 SQL）
        let type_count = |t: &str| -> Result<u32, String> {
            conn.query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1 AND type = ?2",
                params![workspace, t],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())
        };
        let text_count = type_count("text")?;
        // 同上：图文混排计入「图片」，与筛选口径保持一致
        let image_count: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1 AND type IN ('image', 'rich')",
                params![workspace],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let file_count = type_count("file")?;

        // 来源 Top 5（按计数降序）：与 get_sidebar_counts 同源聚合，取代表性图标文件名
        let sources: Vec<SourceCountEntry> = {
            let mut stmt = conn
                .prepare(
                    "SELECT source, COUNT(*), MAX(source_icon)
                     FROM history WHERE workspace = ?1 AND source != ''
                     GROUP BY source
                     ORDER BY COUNT(*) DESC
                     LIMIT 5",
                )
                .map_err(|e| e.to_string())?;
            let result = stmt
                .query_map(params![workspace], |row| {
                    Ok(SourceCountEntry {
                        source: row.get(0)?,
                        count: row.get(1)?,
                        source_icon: row.get(2)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            drop(stmt);
            result
        };

        let earliest_time: Option<String> = conn
            .query_row(
                "SELECT MIN(time) FROM history WHERE workspace = ?1",
                params![workspace],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let db_size_bytes = std::fs::metadata(self.path.clone())
            .map(|m| m.len())
            .unwrap_or(0);
        let db_size_kb = db_size_bytes as f64 / 1024.0;

        Ok(StatsDetail {
            total,
            pinned,
            today,
            yesterday,
            daily,
            hours,
            text_count,
            image_count,
            file_count,
            sources,
            earliest_time,
            db_size_kb,
        })
    }

    /// 侧边栏聚合计数：单把连接锁内完成全部 GROUP BY 统计。
    /// 前端侧边栏分组（全部/收藏/未分组/用户分组/来源/智能分类）直接消费该结果，
    /// 不再 filter 内存分页窗口（初始 50 条、上限 500 条），计数精确且与 TopBar 一致。
    pub fn get_sidebar_counts(&self, workspace: &str) -> Result<SidebarCounts, String> {
        let conn = self.lock_conn();

        let total: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1",
                params![workspace],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let pinned: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1 AND pinned = 1",
                params![workspace],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let ungrouped: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE workspace = ?1 AND group_id IS NULL",
                params![workspace],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        // 来源聚合：MAX(source_icon) 取代表性图标文件名（NULL 被忽略，全 NULL 时为 None）
        let mut sources: Vec<SourceCountEntry> = {
            let mut stmt = conn
                .prepare(
                    "SELECT source, COUNT(*), MAX(source_icon)
                     FROM history WHERE workspace = ?1 AND source != ''
                     GROUP BY source",
                )
                .map_err(|e| e.to_string())?;
            let result = stmt
                .query_map(params![workspace], |row| {
                    Ok(SourceCountEntry {
                        source: row.get(0)?,
                        count: row.get(1)?,
                        source_icon: row.get(2)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            drop(stmt);
            result
        };
        // 与前端原展示顺序一致：按计数降序
        sources.sort_by(|a, b| b.count.cmp(&a.count));

        let mut groups: std::collections::HashMap<String, u32> =
            std::collections::HashMap::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT group_id, COUNT(*)
                     FROM history WHERE workspace = ?1 AND group_id IS NOT NULL
                     GROUP BY group_id",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![workspace], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                if let Ok((gid, count)) = row {
                    groups.insert(gid, count);
                }
            }
        }

        let mut tags: std::collections::HashMap<String, u32> =
            std::collections::HashMap::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT ht.tag_id, COUNT(*)
                     FROM history_tags ht
                     JOIN history h ON h.id = ht.history_id
                     WHERE h.workspace = ?1
                     GROUP BY ht.tag_id",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![workspace], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                if let Ok((tid, count)) = row {
                    tags.insert(tid, count);
                }
            }
        }

        Ok(SidebarCounts {
            total,
            pinned,
            ungrouped,
            sources,
            groups,
            tags,
        })
    }

    pub fn get_config(&self) -> Result<serde_json::Value, String> {
        let conn = self.lock_conn();
        let mut stmt = conn
            .prepare("SELECT key, value FROM config")
            .map_err(|e| e.to_string())?;

        let mut map = serde_json::Map::new();
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;

        for row in rows {
            if let Ok((key, value)) = row {
                // 尝试解析 JSON 值，否则作为字符串
                let json_val =
                    serde_json::from_str(&value).unwrap_or(serde_json::Value::String(value));
                map.insert(key, json_val);
            }
        }

        Ok(serde_json::Value::Object(map))
    }

    pub fn save_config(&self, config: &serde_json::Value) -> Result<(), String> {
        // 审查 backlog：#11 备份限频 —— AI 设置保存会触发多次 save_config
        // （配置/密钥/自动启用等），每次都全表读+写备份+轮换太浪费；1 分钟内至多备份一次，
        // 配置本体照常写入。
        {
            let mut last = LAST_BACKUP.lock().unwrap_or_else(|e| e.into_inner());
            // None（本进程首次）一律备；elapsed() 是“现在 − 过去”，永远不会溢出。
            if last.is_none_or(|t| t.elapsed() >= BACKUP_INTERVAL) {
                let _ = self.backup_config();
                *last = Some(Instant::now());
            }
        }

        let mut conn = self.lock_conn();
        if let serde_json::Value::Object(map) = config {
            // 修复 M15：事务包裹全部配置键写入，保证 all-or-nothing，
            // 避免中途失败时配置处于半写状态
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            for (key, value) in map {
                let value_str = match value {
                    serde_json::Value::String(s) => s.clone(),
                    _ => serde_json::to_string(value).unwrap_or_default(),
                };
                tx.execute(
                    "INSERT OR REPLACE INTO config (key, value) VALUES (?1, ?2)",
                    params![key, value_str],
                )
                .map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// 备份当前配置到备份文件（自动轮换，保留最近 10 个备份）
    fn backup_config(&self) -> Result<(), String> {
        let backup_dir = std::path::Path::new(&self.path)
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("config_backups");

        // 创建备份目录
        if !backup_dir.exists() {
            std::fs::create_dir_all(&backup_dir)
                .map_err(|e| format!("无法创建配置备份目录: {}", e))?;
        }

        // 序列化当前配置
        let config = self.get_config()?;
        let backup_json = serde_json::to_string_pretty(&config)
            .map_err(|e| format!("序列化配置失败: {}", e))?;

        // 写入临时文件 + 原子 rename（防止写入中途崩溃损坏备份）
        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
        let backup_name = format!("config_{}.json", timestamp);
        let backup_path = backup_dir.join(&backup_name);
        let tmp_path = backup_dir.join(format!(".{}.tmp", backup_name));

        std::fs::write(&tmp_path, &backup_json)
            .map_err(|e| format!("写入配置备份临时文件失败: {}", e))?;
        std::fs::rename(&tmp_path, &backup_path)
            .map_err(|e| format!("重命名配置备份文件失败: {}", e))?;

        // 轮换：删除超过 10 个的旧备份
        if let Ok(entries) = std::fs::read_dir(&backup_dir) {
            let mut backups: Vec<_> = entries
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .starts_with("config_")
                        && e.file_name().to_string_lossy().ends_with(".json")
                })
                .filter_map(|e| {
                    let modified = e.metadata().ok()?.modified().ok()?;
                    Some((e.path(), modified))
                })
                .collect();
            // 按修改时间降序排列，保留最新的 10 个
            backups.sort_by(|a, b| b.1.cmp(&a.1));
            for (path, _) in backups.iter().skip(10) {
                let _ = std::fs::remove_file(path);
            }
        }

        log::info!("[DataStore] 配置已备份: {}", backup_path.display());
        Ok(())
    }
}
