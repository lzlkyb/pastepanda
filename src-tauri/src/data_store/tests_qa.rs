//! 问答雏形（B2 #10）的检索用例。
//!
//! 核心那条是 `test_qa_finds_what_plain_search_cannot`：它钉的是开工时摸到的一个
//! 会让整个功能失效的坑——把一整句问题丢给 `note_search`，`to_ngram` 切出
//! 「每个单字 + 每个相邻 bigram」再 `join(" ")`，而 **FTS5 的隐含运算符是 AND**，
//! 于是零命中是必然的。而零命中在问答里会被展示成「知识库中没有相关笔记」——
//! 一个**看不出来的错答案**。没这条用例，以后有人把检索改回 `note_search` 也不会有任何报错。

use super::tests::make_store;
use super::*;

/// 整句问题：旧搜索（AND）拿不到，问答检索（OR + BM25）拿得到。
#[test]
fn test_qa_finds_what_plain_search_cannot() {
    let store = make_store();
    store
        .note_create(None, "部署手册", "先发预发布环境，跑完冒烟再切正式。")
        .unwrap();

    let question = "这个项目的部署流程是什么？";

    // 旧路：整句切成十几个词全部 AND，要求笔记同时含「项目」「流程」「什么」…——拿不到
    let plain = store.note_search(question, "all", &[], 10).unwrap();
    assert!(
        plain.is_empty(),
        "前提变了：整句问题走 note_search 竟然能命中（{} 条）。\
         如果是 note_search 改成了 OR 语义，本功能就该回头重新评估是不是还需要独立检索",
        plain.len()
    );

    // 新路：命中「部署」就够了
    let hits = store
        .note_search_relevant(question, "all", &[], &NoteViewOpts::default(), 5)
        .unwrap();
    assert_eq!(hits.len(), 1, "问答检索应该能拿到那篇笔记");
    assert_eq!(hits[0].title, "部署手册");
}

/// 停用字 bigram 必须被丢掉，否则「这个」「的部」会把半个库拉进来。
#[test]
fn test_question_expr_is_or_and_drops_stopword_bigrams() {
    let expr = note::question_to_or_expr("这个项目的部署流程").unwrap();
    assert!(expr.contains(" OR "), "必须是 OR 语义，不能是 AND：{}", expr);
    assert!(expr.contains("部署"));
    assert!(expr.contains("流程"));
    // 含停用字的 bigram 一个都不能在
    for noise in ["这个", "个项", "目的", "的部"] {
        assert!(!expr.contains(noise), "噪声 bigram {} 不该进查询：{}", noise, expr);
    }
    // 限定列：pinyin 列不得参与（否则英文词会撞拼音首字母）
    assert!(expr.starts_with("{title content}"), "必须限定两列：{}", expr);
}

/// 没有可检索词时返 `None`，而不是拼一个空表达式扔给 FTS5（那会语法报错）。
#[test]
fn test_question_expr_none_when_nothing_searchable() {
    assert!(note::question_to_or_expr("？？！").is_none());
    assert!(note::question_to_or_expr("").is_none());
    // 单个中文字构不成 bigram；单字符英文也不收
    assert!(note::question_to_or_expr("啊").is_none());
    assert!(note::question_to_or_expr("a").is_none());
    // 而纯停用字的句子也该是 None（所有 bigram 都被丢）
    assert!(note::question_to_or_expr("这是什么呢").is_none());
}

/// 没可检索词时不能报错、也不能把全库拉回来，而是干净的零条。
#[test]
fn test_qa_empty_result_when_question_has_no_terms() {
    let store = make_store();
    store.note_create(None, "任意笔记", "正文").unwrap();
    let hits = store
        .note_search_relevant("？？？", "all", &[], &NoteViewOpts::default(), 5)
        .unwrap();
    assert!(hits.is_empty(), "没词可查时必须是零条，不能退成「返全库」");
}

/// 标题命中排在正文命中前面（bm25 的 title 权重 10 倍）。
///
/// 这条守的是「只能送 5 篇」下的选择质量：权重写反不会报错，
/// 只会让真正相关的那篇被挤出 top-5，然后回答变差——而你看不出原因。
#[test]
fn test_qa_ranks_title_hit_above_body_hit() {
    let store = make_store();
    // 正文里提一句的
    store
        .note_create(None, "杂记", "今天开了个会，顺口提到部署。其余与此无关。")
        .unwrap();
    // 标题就是主题的
    store
        .note_create(None, "部署流程", "预发布 → 冒烟 → 正式。")
        .unwrap();

    let hits = store
        .note_search_relevant("部署怎么做？", "all", &[], &NoteViewOpts::default(), 5)
        .unwrap();
    assert_eq!(hits.len(), 2, "两篇都含「部署」，都应命中");
    assert_eq!(hits[0].title, "部署流程", "标题命中的必须排在前面");
}

/// 筛选真的叠上了——否则「当前范围就是问答范围」这个口径是口号。
#[test]
fn test_qa_respects_view_filters() {
    let store = make_store();
    // note_create(None, ..) 建的笔记 history_id 为空，所以「来自卡片=是」该一条不剩
    store.note_create(None, "部署手册", "预发布…").unwrap();

    let all = store
        .note_search_relevant("部署", "all", &[], &NoteViewOpts::default(), 5)
        .unwrap();
    assert_eq!(all.len(), 1);

    let from_card = NoteViewOpts {
        from_card: "yes".to_string(),
        ..Default::default()
    };
    let filtered = store
        .note_search_relevant("部署", "all", &[], &from_card, 5)
        .unwrap();
    assert!(filtered.is_empty(), "三态筛选必须在问答检索里也生效");
}

/// 英文词走前缀匹配，且大小写不敏感。
#[test]
fn test_qa_ascii_term_prefix_match() {
    let store = make_store();
    store
        .note_create(None, "Docker 笔记", "docker compose up -d")
        .unwrap();
    let hits = store
        .note_search_relevant("docker 怎么启动？", "all", &[], &NoteViewOpts::default(), 5)
        .unwrap();
    assert_eq!(hits.len(), 1);
}
