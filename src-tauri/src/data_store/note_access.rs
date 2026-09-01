//! 笔记访问时间（B2 前置，为 §8.3 #7 重现准备数据）。
//!
//! 重现的选取口径是「**久未访问** × 当初信号强度」，而「久未访问」之前无数据源：
//! `updated_at` 是「最后一次被改」，不是「最后一次被看」——只读不改的笔记永远显得「很久没动」，
//! 而那恰好是重现最应该推的一类。
//!
//! **为什么不写在 `note_get` 里**：`note_get` 被 `note_ai` / `note_revision` 内部调用（校验存在性），
//! 那些不是用户在看。写入必须是一个**显式动作**，由前端在真正打开笔记时调。
//!
//! 🔴 红线：只存一个时间戳，不存任何内容；不出本机。

use super::*;

impl DataStore {
    /// 记一笔「这条笔记被打开阅读了」。
    ///
    /// 失败只记 warn 不往上报，同 `action_event_add` 的已有口径：
    /// 统计写不进去不应该卡住「打开笔记」这个动作本身。
    pub fn note_touch(&self, id: &str) {
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        // ❗ 只改 last_access_at，**不碰 updated_at**：
        //   看一眼不是改一次。沾上 updated_at 会把笔记列表（按 updated_at 排序）打乱：
        //   随便点开一条旧笔记就把它顶到最前，也会让版本快照与导出的时间全部失真。
        if let Err(e) = self.lock_conn().execute(
            "UPDATE notes SET last_access_at = ?1 WHERE id = ?2",
            params![now, id],
        ) {
            log::warn!("[NoteAccess] 记录笔记访问时间失败: {}", e);
        }
    }
}
