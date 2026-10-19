//! Local storage inspection uses its own read-only connection, never the clipboard mutex.
mod database;
mod files;
#[cfg(test)]
mod tests;

use rusqlite::{Connection, InterruptHandle, OpenFlags};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::Duration;

pub use database::database_usage;
pub use files::overview;

#[derive(Default)]
pub struct ReadTask {
    cancelled: AtomicBool,
    interrupt: Mutex<Option<InterruptHandle>>,
}

impl ReadTask {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        if let Some(handle) = self
            .interrupt
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            handle.interrupt();
        }
    }
    pub fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Relaxed) {
            Err("统计已取消".into())
        } else {
            Ok(())
        }
    }
    pub(crate) fn connect(&self, path: &Path) -> Result<Connection, String> {
        self.check()?;
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| format!("无法读取数据库：{e}"))?;
        conn.busy_timeout(Duration::from_millis(500))
            .map_err(|e| e.to_string())?;
        *self.interrupt.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(conn.get_interrupt_handle());
        self.check()?;
        conn.execute_batch("PRAGMA query_only=ON; BEGIN DEFERRED;")
            .map_err(|e| e.to_string())?;
        Ok(conn)
    }
}

impl super::DataStore {
    pub fn storage_path(&self) -> PathBuf {
        PathBuf::from(&self.path)
    }
}

#[derive(Debug, Serialize)]
pub struct StorageFile {
    pub name: String,
    pub category: &'static str,
    pub bytes: u64,
    pub complete: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct StorageOverview {
    pub root_path: String,
    pub database_bytes: u64,
    pub total_bytes: u64,
    pub complete: bool,
    pub files: Vec<StorageFile>,
    pub measured_at: String,
}

#[derive(Debug, Serialize)]
pub struct TableUsage {
    pub name: String,
    pub table_bytes: Option<u64>,
    pub index_bytes: Option<u64>,
    pub internal_tables: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct DatabaseUsage {
    pub page_bytes: u64,
    pub free_bytes: u64,
    pub other_bytes: Option<u64>,
    pub size_supported: bool,
    pub tables: Vec<TableUsage>,
}
