//! 库体检（N3）的用例。单独一个文件：`tests.rs` 已经 6000+ 行。
//!
//! 这批用例里最要紧的是 `test_kb_health_tag_dups_only_counts_tags_used_by_notes`——
//! 它钉的是开工前核查里实测出来的那个坑：`tags` 是剪贴板与知识库**共用表**，
//! 真库 38 个标签里只有 6 个被笔记用到，而唯一那组重名（`Java`/`java`）两个都没笔记在用。
//! 拿全库标签算，体检就会把剪贴板的问题报成知识库的，而用户点进去也修不了任何东西。

use super::tests::make_store;

/// 给笔记打一个标签（建标签 + 关联）。
fn tag_note(store: &super::DataStore, note_id: &str, tag_name: &str) {
    let t = store.create_tag(tag_name, "#888888").unwrap();
    store.note_tags_edit(note_id, &[t.id], &[]).unwrap();
}

#[test]
fn test_kb_health_empty_library_is_all_clear() {
    let store = make_store();
    let h = store.kb_health().unwrap();
    assert!(h.broken_links.is_empty());
    assert!(h.tag_dups.is_empty());
    assert!(h.title_dups.is_empty());
    assert!(h.tiny_notes.is_empty());
    assert!(h.unfiled_ai.is_empty());
    assert_eq!(h.unfiled_ai_count, 0);
    assert_eq!(h.stats.note_count, 0);
    assert_eq!(h.stats.unfiled_count, 0);
}

// ============================================================
// 断链
// ============================================================

#[test]
fn test_kb_health_reports_broken_link() {
    let store = make_store();
    store
        .note_create(None, "甲", "参见 [[乙]] 和 [[丢了的那篇]]。下面是正文，写够五十个字免得被当成极短笔记，这句话就是用来凑长度的。")
        .unwrap();
    store
        .note_create(None, "乙", "我是被指向的那一篇，同样要写够五十个字，否则会被极短笔记那一档顺走，干扰本用例的断言。")
        .unwrap();

    let h = store.kb_health().unwrap();
    assert_eq!(
        h.broken_links.len(),
        1,
        "只有「丢了的那篇」算断链，[[乙]] 解析得到"
    );
    assert_eq!(h.broken_links[0].from_title, "甲");
    assert_eq!(h.broken_links[0].to_title, "丢了的那篇");
}

#[test]
fn test_kb_health_broken_link_counts_trashed_target() {
    let store = make_store();
    let b = store
        .note_create(
            None,
            "乙",
            "被指向的那一篇，写够五十个字以免被当成极短笔记，这句话纯粹是用来凑长度的填充内容。",
        )
        .unwrap();
    store
        .note_create(
            None,
            "甲",
            "参见 [[乙]]。同样要写够五十个字以免被当成极短笔记，这句话纯粹是用来凑长度的填充内容。",
        )
        .unwrap();
    assert!(store.kb_health().unwrap().broken_links.is_empty());

    // 乙丢进回收站：用户看不到它了，这条链就算断了
    // （口径与 `note_broken_links` 一致，不另定一套）
    store.note_delete(&b.id).unwrap();
    let h = store.kb_health().unwrap();
    assert_eq!(h.broken_links.len(), 1);
    assert_eq!(h.broken_links[0].to_title, "乙");
}

// ============================================================
// 极短笔记
// ============================================================

#[test]
fn test_kb_health_tiny_notes_threshold() {
    let store = make_store();
    store.note_create(None, "空的", "").unwrap();
    store
        .note_create(None, "差一个字", &"字".repeat(49))
        .unwrap();
    // 正好 50 不算：门槛是「不足 50」，边界必须说死，否则改实现时没人拦得住
    store
        .note_create(None, "刚好五十", &"字".repeat(50))
        .unwrap();

    let h = store.kb_health().unwrap();
    let titles: Vec<&str> = h.tiny_notes.iter().map(|t| t.title.as_str()).collect();
    assert_eq!(titles.len(), 2, "实际拿到：{:?}", titles);
    assert!(titles.contains(&"空的"));
    assert!(titles.contains(&"差一个字"));
    assert!(!titles.contains(&"刚好五十"));
}

#[test]
fn test_kb_health_tiny_notes_measured_in_chars_not_bytes() {
    let store = make_store();
    // 20 个汉字 = 60 字节。按字节算会认为它不短，漏报；
    // 中文库里这一档全靠它，错了等于这个体检项对中文用户彻底失效。
    store
        .note_create(None, "二十个汉字", &"字".repeat(20))
        .unwrap();
    assert_eq!(store.kb_health().unwrap().tiny_notes.len(), 1);
}

#[test]
fn test_kb_health_tiny_notes_ignores_trashed() {
    let store = make_store();
    let n = store.note_create(None, "空的", "").unwrap();
    store.note_delete(&n.id).unwrap();
    assert!(store.kb_health().unwrap().tiny_notes.is_empty());
}

// ============================================================
// 标签重名：口径是整个体检里最容易做错的一项
// ============================================================

#[test]
fn test_kb_health_tag_dups_only_counts_tags_used_by_notes() {
    let store = make_store();
    // 库里存在 Java / java 两个标签，但都是剪贴板那边用的，没任何笔记在用。
    // 这正是真库 2026-09-05 的实际状态。
    store.create_tag("Java", "#888888").unwrap();
    store.create_tag("java", "#888888").unwrap();
    let n = store
        .note_create(
            None,
            "一篇笔记",
            "正文要写够五十个字，否则它会落进极短笔记那一档，干扰本用例想断言的标签口径。",
        )
        .unwrap();

    assert!(
        store.kb_health().unwrap().tag_dups.is_empty(),
        "没笔记在用的标签不归知识库体检管——`tags` 是与剪贴板共用的表"
    );

    // 把两个都打到笔记上，它们才真成了知识库的问题
    tag_note(&store, &n.id, "Python");
    let java = store.get_tags().unwrap();
    let ids: Vec<String> = java
        .iter()
        .filter(|t| t.name.eq_ignore_ascii_case("java"))
        .map(|t| t.id.clone())
        .collect();
    assert_eq!(ids.len(), 2, "前提：库里确实有两个只差大小写的标签");
    store.note_tags_edit(&n.id, &ids, &[]).unwrap();

    let dups = store.kb_health().unwrap().tag_dups;
    assert_eq!(dups.len(), 1, "实际：{:?}", dups);
    assert!(dups[0].strong, "归一化后完全相等 = 强候选");
}

#[test]
fn test_kb_health_tag_dups_ignores_tags_only_on_trashed_notes() {
    let store = make_store();
    let n = store
        .note_create(
            None,
            "要删的",
            "正文要写够五十个字，否则它会落进极短笔记那一档，干扰本用例想断言的标签口径。",
        )
        .unwrap();
    tag_note(&store, &n.id, "Java");
    tag_note(&store, &n.id, "java");
    assert_eq!(store.kb_health().unwrap().tag_dups.len(), 1);

    // 唯一在用它们的笔记进了回收站 → 不再是活库的问题
    store.note_delete(&n.id).unwrap();
    assert!(store.kb_health().unwrap().tag_dups.is_empty());
}

// ============================================================
// note_tag_names：两个消费方共用的那条查询
// ============================================================
//
// 它同时被库体检（标签重名）与 MCP 的 `kb_folders`（给模型报有哪些标签）用。
// 历史上 `kb_folders` 用的是 `get_tags()`（全库），于是对模型报了
// 38 个标签与一条「Java/java 重复」——而那两个标签下一篇笔记都没有。
// 收口成一条查询就是为了不再漂出第二套口径。

#[test]
fn test_note_tag_names_excludes_tags_no_note_uses() {
    let store = make_store();
    store.create_tag("没人用的", "#888888").unwrap();
    let n = store
        .note_create(None, "一篇", "正文随便写点什么，长度在本用例里不重要。")
        .unwrap();
    tag_note(&store, &n.id, "用上了的");

    let names = store.note_tag_names().unwrap();
    assert_eq!(names, vec!["用上了的".to_string()]);
}

#[test]
fn test_note_tag_names_excludes_trashed_notes_tags() {
    let store = make_store();
    let n = store
        .note_create(None, "要删的", "正文随便写点什么，长度在本用例里不重要。")
        .unwrap();
    tag_note(&store, &n.id, "只在已删笔记上");
    assert_eq!(store.note_tag_names().unwrap().len(), 1);

    store.note_delete(&n.id).unwrap();
    assert!(store.note_tag_names().unwrap().is_empty());
}

#[test]
fn test_note_tag_names_dedups_and_sorts() {
    let store = make_store();
    let a = store.note_create(None, "甲", "正文").unwrap();
    let b = store.note_create(None, "乙", "正文").unwrap();
    let t = store.create_tag("Rust", "#888888").unwrap();
    // 同一个标签打在两篇上，只能出现一次——否则 find_dups 会把它自己跟自己归成一组重复
    store.note_tags_edit(&a.id, &[t.id.clone()], &[]).unwrap();
    store.note_tags_edit(&b.id, &[t.id], &[]).unwrap();
    tag_note(&store, &a.id, "Axum");

    assert_eq!(
        store.note_tag_names().unwrap(),
        vec!["Axum".to_string(), "Rust".to_string()],
        "去重 + 按名排序"
    );
}

// ============================================================
// 标题重名
// ============================================================

#[test]
fn test_kb_health_title_dups() {
    let store = make_store();
    store
        .note_create(
            None,
            "Java 笔记",
            "正文要写够五十个字，否则会落进极短笔记那一档，干扰本用例想断言的标题重名。",
        )
        .unwrap();
    store
        .note_create(
            None,
            "java 笔记",
            "正文要写够五十个字，否则会落进极短笔记那一档，干扰本用例想断言的标题重名。",
        )
        .unwrap();
    let dups = store.kb_health().unwrap().title_dups;
    assert_eq!(dups.len(), 1);
    assert!(dups[0].strong);
}

// ============================================================
// 中性统计（展开面板底部那一行）
// ============================================================

#[test]
fn test_kb_health_stats() {
    let store = make_store();
    let a = store.note_create(None, "甲", &"字".repeat(100)).unwrap();
    store
        .note_create(None, "乙", &format!("[[甲]]{}", "字".repeat(200)))
        .unwrap();
    tag_note(&store, &a.id, "Rust");

    let s = store.kb_health().unwrap().stats;
    assert_eq!(s.note_count, 2);
    assert_eq!(
        s.max_len, 205,
        "`[[甲]]` 是 5 个字符（2 个左括号 + 甲 + 2 个右括号）+ 200"
    );
    assert_eq!(s.avg_len, 152, "(100 + 205) / 2 = 152.5，取整为 152");
    assert_eq!(s.tag_count, 1, "只数笔记用到的标签");
    assert_eq!(s.link_count, 1);
}

#[test]
fn test_kb_health_stats_ignores_trashed() {
    let store = make_store();
    let n = store
        .note_create(None, "要删的", &"字".repeat(9999))
        .unwrap();
    store
        .note_create(None, "留下的", &"字".repeat(100))
        .unwrap();
    store.note_delete(&n.id).unwrap();

    let s = store.kb_health().unwrap().stats;
    assert_eq!(s.note_count, 1);
    assert_eq!(s.max_len, 100, "回收站里那篇 9999 字的不能抬高最大值");
}

// ============================================================
// 上限：面板只展示前几条，但计数要是真的
// ============================================================

// ============================================================
// 未分类：总量是统计，只有「AI 自己写的」那半才是问题
// ============================================================
//
// 这一批钉的是 2026-09-15 那次拆分：文档里早就写死「无文件夹 96% 不是缺陷」，
// 但 AI 维护的库里「AI 建了却没归类」确实是活儿没干完。两者差别不在**数量**，
// 而在**是谁写的**——所以判据必须落在 `source_agent` 上，不能落在 `folder_id` 上。

/// 人写的笔记全堆在未分类里 → 只进统计，一条问题都不报。
#[test]
fn test_kb_health_unfiled_total_is_a_stat_not_an_issue() {
    let store = make_store();
    for i in 0..5 {
        store
            .note_create(None, &format!("我写的{}", i), &"字".repeat(100))
            .unwrap();
    }
    let h = store.kb_health().unwrap();
    assert_eq!(h.stats.unfiled_count, 5, "总量要照实报，它只是统计");
    assert_eq!(h.unfiled_ai_count, 0);
    assert!(
        h.unfiled_ai.is_empty(),
        "人自己没归类是「没用这个功能」，不是缺陷——这条判据 2026-09-05 就定死了"
    );
}

/// AI 写的留在未分类 → 报出来，并且给出可点进去的明细。
#[test]
fn test_kb_health_reports_ai_notes_stuck_in_unfiled() {
    let store = make_store();
    store
        .note_create_from(None, "AI 甲", &"字".repeat(100), "agent:test")
        .unwrap();
    store
        .note_create_from(None, "AI 乙", &"字".repeat(100), "agent:test")
        .unwrap();
    // 一篇已归类的 AI 笔记：它不是问题，不能把计数抬到 3
    let f = store.folder_create_by_ai("工程", None).unwrap();
    let filed = store
        .note_create_from(None, "AI 丙", &"字".repeat(100), "agent:test")
        .unwrap();
    store.note_set_folder(&filed.id, Some(&f.id)).unwrap();
    // 一篇人写的也在未分类：它要计入总量、不计入这一项
    store
        .note_create(None, "我写的", &"字".repeat(100))
        .unwrap();

    let h = store.kb_health().unwrap();
    assert_eq!(h.unfiled_ai_count, 2);
    let titles: Vec<&str> = h.unfiled_ai.iter().map(|t| t.title.as_str()).collect();
    assert_eq!(titles.len(), 2, "实际拿到：{:?}", titles);
    assert!(titles.contains(&"AI 甲") && titles.contains(&"AI 乙"));
    assert_eq!(h.stats.unfiled_count, 3, "总量 = 2 篇 AI + 1 篇人写的");
}

/// 🔴 判据只认「谁建的」，不认「谁改过」。
///
/// 人亲手写、只是被 AI 追加过一段的笔记，`last_agent` 非空但 `source_agent` 为空。
/// 把它算进「AI 没归类」，等于叫 AI 去动用户的笔记——那正是全局边界禁止的事。
#[test]
fn test_kb_health_unfiled_ai_ignores_notes_ai_only_edited() {
    let store = make_store();
    let n = store
        .note_create(None, "我写的", &"字".repeat(100))
        .unwrap();
    // AI 改了正文（不是新建）：source_agent 仍为空、last_agent 变成 agent:test
    store
        .note_update_from(&n.id, "我写的", &"字".repeat(120), "agent:test")
        .unwrap();

    let h = store.kb_health().unwrap();
    assert_eq!(h.unfiled_ai_count, 0, "AI 改过 ≠ AI 建的，不能算在它头上");
    assert_eq!(h.stats.unfiled_count, 1, "但它仍是未分类，总量照算");
}

#[test]
fn test_kb_health_unfiled_ai_ignores_trashed() {
    let store = make_store();
    let n = store
        .note_create_from(None, "AI 写的", &"字".repeat(100), "agent:test")
        .unwrap();
    assert_eq!(store.kb_health().unwrap().unfiled_ai_count, 1);
    store.note_delete(&n.id).unwrap();
    assert_eq!(store.kb_health().unwrap().unfiled_ai_count, 0);
    assert_eq!(store.kb_health().unwrap().stats.unfiled_count, 0);
}

/// 堆得最久的排前面——它躺在门口最久，最该先收。
#[test]
fn test_kb_health_unfiled_ai_oldest_first() {
    let store = make_store();
    for t in ["最早的", "中间的", "最新的"] {
        store
            .note_create_from(None, t, &"字".repeat(100), "agent:test")
            .unwrap();
    }
    let titles: Vec<String> = store
        .kb_health()
        .unwrap()
        .unfiled_ai
        .into_iter()
        .map(|t| t.title)
        .collect();
    assert_eq!(titles, vec!["最早的", "中间的", "最新的"]);
}

#[test]
fn test_kb_health_unfiled_ai_detail_capped_but_count_is_real() {
    let store = make_store();
    for i in 0..(super::note_health::HEALTH_DETAIL_CAP + 4) {
        store
            .note_create_from(None, &format!("AI{}", i), &"字".repeat(100), "agent:test")
            .unwrap();
    }
    let h = store.kb_health().unwrap();
    assert_eq!(
        h.unfiled_ai.len(),
        super::note_health::HEALTH_DETAIL_CAP,
        "明细封顶"
    );
    assert_eq!(
        h.unfiled_ai_count,
        super::note_health::HEALTH_DETAIL_CAP + 4,
        "计数不封顶——「还有 N 条」靠它"
    );
}

#[test]
fn test_kb_health_detail_capped_but_count_is_real() {
    let store = make_store();
    for i in 0..(super::note_health::HEALTH_DETAIL_CAP + 5) {
        store.note_create(None, &format!("空{}", i), "").unwrap();
    }
    let h = store.kb_health().unwrap();
    assert_eq!(
        h.tiny_notes.len(),
        super::note_health::HEALTH_DETAIL_CAP,
        "明细封顶"
    );
    assert_eq!(
        h.tiny_count,
        super::note_health::HEALTH_DETAIL_CAP + 5,
        "计数不封顶——界面上那句「还有 N 条」靠它，封了就变成静默截断"
    );
}
