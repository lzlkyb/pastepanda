//! `note_library_pulse` 的用例——L2 信号那条查询。
//!
//! # 为什么单独一个文件
//!
//! 与 `tests_view` / `tests_qa` / `tests_health` 同一个理由：`tests.rs` 已经 6000+ 行。
//!
//! # 为什么必须有用例
//!
//! 这条查询在 MCP 层是被 `FakeKb` 挡住的——`mcp/tests.rs` 验的是
//! 「拿到脉搏数字之后**怎么说话**」，而**这条 SQL 本身从来跑不到**。
//! 于是它写错了不会有任何东西报警：`kb_folders` 只是少说一句话，
//! 而「少说一句话」在模型那边与「库里没什么可说的」**完全同形**。
//!
//! 三处最会写错的地方，各有一条：
//!
//! - `deleted_at IS NULL`：漏了会把回收站里的也算进「未分类堆积」，
//!   于是那句「未分类堆了 N 篇」永远在喊，模型去数才发现对不上；
//! - `MAX(...)` 在空集/全人工库上是 `NULL` ⇒ `None`：写成 `COALESCE(..., 0)`
//!   就会把「**从来没写过**」说成「**1970 年写的**」，
//!   下游那句「已经 20000 天没有新东西进来了」比不说更糟；
//! - 判据是 `source_agent != '' OR last_agent != ''`（**建的或改过的**）：
//!   只认 `source_agent` 就会漏掉「AI 一直在追加、但从没新建过」的库——
//!   那正是 `instructions` 让模型优先 `kb_append` 的后果（§7.1 那个坑）。
//!
//! 第四个数 `total`（2026-09-15 冷启动）：用来区分「空库」与「有内容但 AI 从没写入」。
//! 写成「含回收站」或「含已删除」都会让冷启动在清库后幽灵般复现。

use super::tests::make_store;

#[test]
fn test_pulse_empty_library_has_no_last_write() {
    let store = make_store();
    let (unfiled, last, total) = store.note_library_pulse().unwrap();
    assert_eq!(unfiled, 0);
    assert_eq!(last, None, "空库是「从来没写过」，不是「很久以前写过」");
    assert_eq!(total, 0);
}

#[test]
fn test_pulse_human_only_library_has_no_last_write() {
    let store = make_store();
    store.note_create(None, "我写的", "正文").unwrap();
    let (unfiled, last, total) = store.note_library_pulse().unwrap();
    assert_eq!(unfiled, 1, "人写的也占未分类");
    assert_eq!(
        last, None,
        "全是人写的库 = AI 从没写过。给它报「你好久没更新了」是在催一件没发生过的事"
    );
    assert_eq!(total, 1, "冷启动靠它区分空库与「有内容但从没 AI 写入」");
}

#[test]
fn test_pulse_counts_only_alive_notes() {
    let store = make_store();
    let f = store.folder_create("工程", None).unwrap();
    let a = store.note_create(None, "未分类甲", "正文").unwrap();
    let _b = store.note_create(None, "未分类乙", "正文").unwrap();
    let c = store.note_create(None, "已归类", "正文").unwrap();
    store.note_set_folder(&c.id, Some(&f.id)).unwrap();

    let (unfiled, _, total) = store.note_library_pulse().unwrap();
    assert_eq!(unfiled, 2);
    assert_eq!(total, 3, "已归类的也算进总数——冷启动看的是「库在不在用」");

    // 回收站里的不算：否则「未分类堆了 N 篇」会一直在喊，而模型数不出那么多
    store.note_delete(&a.id).unwrap();
    let (unfiled, _, total) = store.note_library_pulse().unwrap();
    assert_eq!(unfiled, 1);
    assert_eq!(total, 2, "回收站不该让冷启动幽灵复现");
}

#[test]
fn test_pulse_ai_edit_alone_counts_as_ai_write() {
    let store = make_store();
    let n = store.note_create(None, "我建的", "正文").unwrap();
    assert_eq!(store.note_library_pulse().unwrap().1, None);

    // AI 追加了一段：source_agent 仍为空，last_agent 变成 agent:test。
    // 漏掉 `last_agent` 就会认为「AI 这个库从没碰过」——而它明明刚写过。
    store
        .note_update_from(&n.id, "我建的", "正文 + AI 补的一段", "agent:test")
        .unwrap();
    assert!(
        store.note_library_pulse().unwrap().1.is_some(),
        "改过也算「与 AI 有关」：只认 source_agent 会漏掉整类库"
    );
}

#[test]
fn test_pulse_takes_the_latest_not_the_earliest() {
    let store = make_store();
    for t in ["第一篇", "第二篇", "第三篇"] {
        store
            .note_create_from(None, t, "正文", "agent:test")
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    let (_, last, total) = store.note_library_pulse().unwrap();
    let last = last.expect("写过就有时间");
    assert_eq!(total, 3);
    let now = chrono::Local::now().timestamp_millis();
    // 取的是最近那次：它必须离现在很近，而不是第一帧的时间。
    // （取最小值会让「多久没写」永远是个大数，提示天天喊。）
    assert!(
        now - last < 60_000,
        "拿到的 last={} 距今 {} ms，像是取成了最早那次",
        last,
        now - last
    );
}
