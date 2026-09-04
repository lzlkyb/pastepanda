//! AM-5 基准自身的正确性测试。
//!
//! 🔴 **这些测试测的不是召回好不好，而是「量召回的尺子准不准」。**
//! 尺子错了，报告上的数看起来一样正常——所以每条指标都要有一个
//! 答案已知的构造用例把它钉住。

use super::*;
use crate::data_store::DataStore;

fn store() -> DataStore {
    DataStore::new(":memory:").expect("无法创建内存数据库")
}

/// 造一篇够长（> `BRIEF_CHARS * 2` = 400 字）的多节笔记。
///
/// 填充量按**单节**算够 450 字：只有一节的笔记也必须过阈值，
/// 否则它会掉进「短笔记」分支、整篇只剩一个引言节，测试就变成在测另一件事。
fn long_note(store: &DataStore, title: &str, sections: &[(&str, &str)]) -> String {
    let mut c = String::new();
    for (h, body) in sections {
        c.push_str(&format!("# {}\n\n{}\n{}\n\n", h, body, "填充。".repeat(150)));
    }
    store.note_create(None, title, &c).expect("建笔记失败").id
}

fn case(id: &str, kind: QueryType, query: &str, expect: &[(&str, &str)]) -> Case {
    Case {
        id: id.into(),
        kind,
        query: query.into(),
        expect: expect
            .iter()
            .map(|(n, h)| Label {
                note: (*n).into(),
                heading: (*h).into(),
            })
            .collect(),
        prefix: None,
    }
}

fn set(cases: Vec<Case>) -> CaseSet {
    CaseSet {
        labeler: "测试".into(),
        cases,
    }
}

// ===== 指标本身 =====

#[test]
fn test_期望节命中时给满分() {
    let s = store();
    long_note(
        &s,
        "同步设计",
        &[("墓碑传播", "墓碑靠 id 传播"), ("冲突解决", "按时间比大小")],
    );
    long_note(&s, "无关笔记", &[("别的", "完全没关系的内容")]);

    let cs = set(vec![case(
        "q1",
        QueryType::Keyword,
        "墓碑传播",
        &[("同步设计", "墓碑传播")],
    )]);
    let r = run(&s, &cs, &[5], "2026-09-04").expect("跑基准失败");
    let c = &r.by_limit[0].1[0];
    assert_eq!(c.note_recall, 1.0);
    assert_eq!(c.r_note_major, 1.0, "首位命中却不是满分，说明打分口径错了");
}

#[test]
fn test_篇级没召回时节级必然为零() {
    let s = store();
    long_note(&s, "同步设计", &[("墓碑传播", "墓碑靠 id 传播")]);

    // 查询词在库里根本不存在 → 一篇都返不回来。
    let cs = set(vec![case(
        "q1",
        QueryType::Keyword,
        "量子纠缠",
        &[("同步设计", "墓碑传播")],
    )]);
    let r = run(&s, &cs, &[5], "2026-09-04").expect("跑基准失败");
    let c = &r.by_limit[0].1[0];
    assert_eq!(c.note_recall, 0.0);
    assert_eq!(
        c.r_note_major, 0.0,
        "篇级没召回，节级绝不可能有分——有分说明记账串了"
    );
}

// ===== 标注解析：错了要炸，不能静默算 0 分 =====

#[test]
fn test_节标题写错要报错而不是算成没召回() {
    let s = store();
    long_note(&s, "同步设计", &[("墓碑传播", "墓碑靠 id 传播")]);

    let cs = set(vec![case(
        "q1",
        QueryType::Keyword,
        "墓碑",
        &[("同步设计", "根本没有这一节")],
    )]);
    let e = run(&s, &cs, &[5], "2026-09-04").expect_err("写错的标签必须让整份用例集跑不起来");
    assert!(e.contains("没有标题含"), "错误信息得说清哪儿错了：{}", e);
}

#[test]
fn test_标题片段有歧义也要报错() {
    let s = store();
    long_note(&s, "同步设计 A", &[("墓碑", "x")]);
    long_note(&s, "同步设计 B", &[("墓碑", "y")]);

    let cs = set(vec![case("q1", QueryType::Keyword, "墓碑", &[("同步设计", "墓碑")])]);
    let e = run(&s, &cs, &[5], "2026-09-04").expect_err("匹配到两篇时随便挑一篇是错的");
    assert!(e.contains("匹配到 2 篇"), "{}", e);
}

#[test]
fn test_一题标错就整份不跑() {
    let s = store();
    long_note(&s, "同步设计", &[("墓碑传播", "墓碑靠 id 传播")]);

    let cs = set(vec![
        case("好题", QueryType::Keyword, "墓碑", &[("同步设计", "墓碑传播")]),
        case("坏题", QueryType::Keyword, "墓碑", &[("同步设计", "不存在")]),
    ]);
    let e = run(&s, &cs, &[5], "2026-09-04").expect_err("跑到一半才炸会留下半份报告");
    assert!(e.contains("坏题"), "{}", e);
}

#[test]
fn test_没标注期望的题要报错() {
    let s = store();
    long_note(&s, "同步设计", &[("墓碑传播", "x")]);
    let cs = set(vec![case("q1", QueryType::Keyword, "墓碑", &[])]);
    let e = run(&s, &cs, &[5], "2026-09-04").expect_err("空标注的题分母是 0，必须拦下");
    assert!(e.contains("没有标注"), "{}", e);
}

#[test]
fn test_开头就是标题的笔记不能把heading留空() {
    let s = store();
    // long_note 造出来的正文以 `# ` 开头，没有引言节。
    long_note(&s, "同步设计", &[("墓碑传播", "x")]);
    let cs = set(vec![case("q1", QueryType::Keyword, "墓碑", &[("同步设计", "")])]);
    let e = run(&s, &cs, &[5], "2026-09-04")
        .expect_err("标一个永远不可能命中的引言节，是标注错误不是召回失败");
    assert!(e.contains("没有引言节"), "{}", e);
}

// ===== 短笔记 =====

#[test]
fn test_短笔记按引言节记账() {
    let s = store();
    // 远低于 400 字 → 出货时不做节级定位，只给 200 字摘要。
    s.note_create(None, "便签", "墓碑传播的一句话备忘").unwrap();

    let cs = set(vec![case("q1", QueryType::Keyword, "墓碑传播", &[("便签", "")])]);
    let r = run(&s, &cs, &[5], "2026-09-04").expect("跑基准失败");
    assert_eq!(
        r.by_limit[0].1[0].r_note_major, 1.0,
        "短笔记那 200 字摘要就是正文开头，输出里确实覆盖到了，不能记成漏召回"
    );
}

// ===== 两种节序 =====

#[test]
fn test_篇序会把靠后那篇的好节挤出前十而分数序不会() {
    let s = store();
    // 前四篇各贡献 3 节（共 12 节）都排在第五篇前面，
    // 而正确答案在第五篇里、且它的节分最高。
    for i in 1..=4 {
        long_note(
            &s,
            &format!("陪跑{}", i),
            &[
                ("墓碑闲谈一", "墓碑"),
                ("墓碑闲谈二", "墓碑"),
                ("墓碑闲谈三", "墓碑"),
            ],
        );
    }
    long_note(
        &s,
        "正解",
        &[("墓碑墓碑墓碑传播机制", "墓碑 墓碑 墓碑 墓碑 墓碑")],
    );

    let cs = set(vec![case(
        "q1",
        QueryType::Keyword,
        "墓碑",
        &[("正解", "传播机制")],
    )]);
    let r = run(&s, &cs, &[5], "2026-09-04").expect("跑基准失败");
    let c = &r.by_limit[0].1[0];
    assert_eq!(c.note_recall, 1.0, "五篇都该返回来");
    assert!(
        c.r_score_major >= c.r_note_major,
        "分数序是「排序收口到一处」的上界，不该低于篇序：篇序 {} / 分数序 {}",
        c.r_note_major,
        c.r_score_major
    );
}

// ===== 污染查询 =====

#[test]
fn test_污染用例成对跑并给出掉幅() {
    let s = store();
    long_note(&s, "同步设计", &[("墓碑传播", "墓碑靠 id 传播")]);

    let mut c = case("q1", QueryType::Keyword, "墓碑传播", &[("同步设计", "墓碑传播")]);
    c.prefix = Some("你是一个乐于助人的助手 请始终使用中文回答 不要编造事实 ".repeat(20));
    let r = run(&s, &set(vec![c]), &[5], "2026-09-04").expect("跑基准失败");
    let got = r.by_limit[0].1[0].r_contaminated;
    assert!(got.is_some(), "带 prefix 的用例必须跑第二遍，否则掉幅无从谈起");

    let md = r.to_markdown();
    assert!(md.contains("系统提示污染"), "报告里得有验收项①这一节");
}

// ===== 报告 =====

#[test]
fn test_报告头部钉住方法与库规模() {
    let s = store();
    long_note(&s, "同步设计", &[("墓碑传播", "墓碑靠 id 传播")]);
    let cs = set(vec![case(
        "q1",
        QueryType::Semantic,
        "墓碑",
        &[("同步设计", "墓碑传播")],
    )]);
    let md = run(&s, &cs, &[5], "2026-09-04").unwrap().to_markdown();

    for want in [
        "节级 Recall@10", // 口径
        "标注人 **测试**", // 谁标的
        "1 篇",            // 库规模
        "2026-09-04",      // 日期
        "只归档、不作决策依据", // <100 篇的安全阀
        "AM-10 向量层的唯一判据", // 验收项③
        "不要单独引用",    // 平均值的警告
    ] {
        assert!(md.contains(want), "报告缺了「{}」：\n{}", want, md);
    }
}

#[test]
fn test_库满一百篇后不再打归档警告() {
    let s = store();
    // 标题写成「笔记-0-号」而不是「笔记0」：后者是「笔记00…笔记09」的前缀，
    // 会被歧义拦截拦下——那是拦截生效，不是本测试要测的东西。
    for i in 0..100 {
        long_note(&s, &format!("笔记-{}-号", i), &[("墓碑传播", "墓碑")]);
    }
    let cs = set(vec![case(
        "q1",
        QueryType::Keyword,
        "墓碑",
        &[("笔记-0-号", "墓碑传播")],
    )]);
    let md = run(&s, &cs, &[5], "2026-09-04").expect("跑基准失败").to_markdown();
    assert!(md.contains("100 篇 /"));
    assert!(
        !md.contains("只归档、不作决策依据"),
        "库够大了就不该再挂安全阀"
    );
}

// ===== 对真库跑 =====

/// 对着**真库副本**跑一轮，把 Markdown 报告写到 `PP_BENCH_OUT`。
///
/// ```text
/// PP_BENCH_DB=/tmp/pp-copy.db \
/// PP_BENCH_CASES=docs/am5-cases.json \
/// PP_BENCH_DATE=2026-09-04 \
/// PP_BENCH_OUT=docs/AM-5-召回基准-2026-09-04.md \
/// cargo test --lib bench::tests::bench_real_library -- --ignored --nocapture
/// ```
///
/// 🔴 **`PP_BENCH_DB` 必须是副本。** `DataStore::new` 会跑迁移——那是**写操作**。
/// 拿活库跑基准等于用测试改用户的数据，下面直接拦掉 AppData 路径。
#[test]
#[ignore = "需要真库副本 + 已标注的用例集，见函数文档"]
fn bench_real_library() {
    let db = std::env::var("PP_BENCH_DB").expect("要设 PP_BENCH_DB（真库的副本路径）");
    let cases = std::env::var("PP_BENCH_CASES").expect("要设 PP_BENCH_CASES（用例集 JSON）");
    let date = std::env::var("PP_BENCH_DATE").expect("要设 PP_BENCH_DATE（跑的日期，从上下文取）");

    // 拦活库。判据用应用的数据目录名而不是「是不是副本」——后者判不了，前者判得死。
    let low = db.replace('\\', "/").to_lowercase();
    assert!(
        !low.contains("com.pastepanda.app"),
        "PP_BENCH_DB 指向了应用数据目录。DataStore::new 会跑迁移（写操作），\
         必须先把库拷出来再跑：{}",
        db
    );

    let raw = std::fs::read_to_string(&cases).unwrap_or_else(|e| panic!("读不到 {}：{}", cases, e));
    let set: CaseSet = serde_json::from_str(&raw).unwrap_or_else(|e| panic!("用例集解析失败：{}", e));

    let store = DataStore::new(&db).expect("打不开库副本");
    // 5 是 kb_search 的默认 limit，20 是它的上限。扫这三档就能看出
    // 「节排得不好」还是「一次只取 5 篇太紧」。
    let report = run(&store, &set, &[5, 10, 20], &date).expect("跑基准失败");
    let md = report.to_markdown();

    println!("{}", md);
    if let Ok(out) = std::env::var("PP_BENCH_OUT") {
        std::fs::write(&out, &md).unwrap_or_else(|e| panic!("写不了 {}：{}", out, e));
        println!("报告已写入 {}", out);
    }
}

/// 把库里的**标题与节标题**导出成一份可勾选的清单，供人标注时照着挑。
///
/// ```text
/// PP_BENCH_DB=/tmp/pp-copy.db PP_BENCH_OUT=/tmp/outline.md \
/// cargo test --lib bench::tests::bench_dump_outline -- --ignored --nocapture
/// ```
///
/// 标注最大的摩擦是「记不清库里有哪些节」。有这份清单，`note` / `heading`
/// 两个字段就是照抄，不是回忆。
///
/// 🔴 只导出**标题**，不导出正文——这份清单是给标注人用的工作纸，
/// 不是把库倒出来的通道。
#[test]
#[ignore = "工具：导出标注用的节清单"]
fn bench_dump_outline() {
    let db = std::env::var("PP_BENCH_DB").expect("要设 PP_BENCH_DB（真库的副本路径）");
    let low = db.replace('\\', "/").to_lowercase();
    assert!(
        !low.contains("com.pastepanda.app"),
        "PP_BENCH_DB 指向了应用数据目录（DataStore::new 会跑迁移）：{}",
        db
    );
    let store = DataStore::new(&db).expect("打不开库副本");
    let idx = index_all(&store).expect("建索引失败");

    let mut s = String::from("# 标注用节清单\n\n");
    for n in &idx {
        s.push_str(&format!("## {}\n\n", n.title));
        for (i, h) in &n.sections {
            let label = if h.is_empty() { "（引言）" } else { h.as_str() };
            s.push_str(&format!("- `[{}]` {}\n", i, label));
        }
        s.push('\n');
    }
    println!("{} 篇 / {} 节", idx.len(), idx.iter().map(|n| n.sections.len()).sum::<usize>());
    match std::env::var("PP_BENCH_OUT") {
        Ok(out) => {
            std::fs::write(&out, &s).unwrap_or_else(|e| panic!("写不了 {}：{}", out, e));
            println!("清单已写入 {}", out);
        }
        Err(_) => println!("{}", s),
    }
}

// ===== 冒烟夹具 =====

/// 造一个**合成库**，供端到端冒烟用。
///
/// ```text
/// PP_BENCH_DB=/tmp/smoke.db \
///   cargo test --lib bench::tests::bench_seed_fixture -- --ignored --nocapture
/// ```
///
/// 🔴 **为什么不拿真库冒烟**：题目若照着真笔记写，用词自然落在原文上，
/// BM25 必然满分——那验证的是「我抄得准不准」，不是量具准不准。
/// 合成库可以**预先埋进已知的失败**（语义型两题必然 0 分），
/// 这样一眼就能看出指标确实有区分度，而不是恒等于 1。
#[test]
#[ignore = "工具：造冒烟用的合成库"]
fn bench_seed_fixture() {
    let db = std::env::var("PP_BENCH_DB").expect("要设 PP_BENCH_DB（要造的库路径）");
    let _ = std::fs::remove_file(&db);
    let store = DataStore::new(&db).expect("建库失败");

    // 每节都写够长度：整篇低于 400 字会掉进短笔记分支，那就测不到节级定位了。
    //
    // 用「补到 260 字为止」而不是固定重复几遍：固定倍数会跟着正文长短走，
    // 第一版就因为「月度回顾」两节都写得短而整篇掉进了短笔记分支。
    let pad = |s: &str| {
        let mut out = String::from(s);
        while out.chars().count() < 260 {
            out.push('\n');
            out.push_str(s);
        }
        out
    };

    let mk = |title: &str, secs: &[(&str, &str)]| {
        let mut c = String::new();
        for (h, body) in secs {
            c.push_str(&format!("# {}\n\n{}\n", h, pad(body)));
        }
        store.note_create(None, title, &c).expect("建笔记失败");
    };

    mk("同步设计", &[
        ("墓碑传播", "墓碑靠 id 传播，删除也要能同步出去。"),
        ("冲突解决", "两端各改一次时按后写胜，靠时间戳比大小判胜负。"),
        ("时钟偏斜", "跨机时钟不齐要用混合逻辑钟兜住。"),
    ]);
    mk("检索排序", &[
        ("BM25 权重", "标题列给十倍权重，正文列给一倍。"),
        ("破同分", "分数完全相等时用修改时间兜底，避免顺序随机。"),
        ("节级定位", "命中一篇之后还要在篇内指到最相关的那几节。"),
    ]);
    mk("构建环境", &[
        ("LIBCLANG 路径", "环境变量要在命令里内联导出，不能只在配置里写。"),
        ("产物体积", "发布版二进制目前二十多兆，模型不打进安装包。"),
    ]);
    // 🔴 语义型埋点一：查询用「压缩方案」，而这篇里压缩、方案两个词一次都不出现。
    mk("存储瘦身", &[
        ("AAAK 方言", "用一套自定义字典把重复片段折起来，落盘前先折。"),
        ("字典训练", "拿历史样本训一份共享字典，之后每条只存差异。"),
    ]);
    // 🔴 语义型埋点二：查询用「怎么防止提示词注入」，这篇里一个词都不沾。
    mk("外部输入的信任边界", &[
        ("数据不是指令", "外面来的文字只当材料看，不当命令执行。"),
        ("白名单校验", "范围参数只认已知名字，认不出就报错而不是放行全库。"),
    ]);
    mk("月度回顾", &[
        ("2026-08 进展", "知识库主体落地，MCP 只读查询上线。"),
        ("下阶段", "同步与召回基准。"),
    ]);
    // 短笔记：走「不做节级定位、按引言节记账」那条分支。
    store
        .note_create(None, "便签", "记一句：破同分要先做，它零风险。")
        .expect("建便签失败");

    println!("合成库已写入 {}", db);
}
