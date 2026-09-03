//! `markdown` 模块的单测。
//!
//! 这一层是精准编辑的地基：**大纲解析错一个行号，上面四层全跟着错**，
//! 而错的表现是「AI 改完看着像对的、实际把别的节改了」——那种错很难从现象倒推。
//! 所以这里的用例以**脏输入**为主，而不是干净的教科书 Markdown。

use super::edit::{apply, ContentEdit, InsertAt};
use super::sections::{locate, outline, slice, LocateError, SectionRef};

// ===== 大纲解析 =====

#[test]
fn test_no_heading_gives_one_preamble_section() {
    // 纯剪贴板文本（没任何标题）占比不小。`outline` 承诺永不返空，
    // 调用方就不用为「空大纲」写一条特例分支。
    let o = outline("第一行\n第二行");
    assert_eq!(o.len(), 1);
    assert_eq!(o[0].index, 0);
    assert_eq!(o[0].level, 0);
    assert!(o[0].heading.is_empty());
    assert_eq!(o[0].body_start, 0);
    assert_eq!(o[0].body_end, 2);
}

#[test]
fn test_empty_content_still_has_a_section() {
    let o = outline("");
    assert_eq!(o.len(), 1);
    assert_eq!(o[0].index, 0);
}

#[test]
fn test_heading_first_has_no_preamble() {
    // 开头就是标题的笔记很多。大纲里多一个空的 [0] 只是噪声。
    let o = outline("# A\n正文");
    assert_eq!(o.len(), 1);
    assert_eq!(o[0].index, 1);
    assert_eq!(o[0].heading, "A");
    assert_eq!(o[0].heading_line, Some(0));
    assert_eq!(o[0].body_start, 1);
}

#[test]
fn test_preamble_then_heading() {
    let o = outline("引言\n\n# A\n正文");
    assert_eq!(o.len(), 2);
    assert_eq!(o[0].index, 0);
    assert_eq!(o[0].body_end, 2, "引言节到第一个标题为止");
    assert_eq!(o[1].heading, "A");
}

#[test]
fn test_blank_only_preamble_is_not_a_section() {
    // 标题前只有空行时不给 [0]。
    let o = outline("\n\n# A\n正文");
    assert_eq!(o.len(), 1);
    assert_eq!(o[0].index, 1);
}

#[test]
fn test_hash_inside_code_fence_is_not_a_heading() {
    // 技术笔记里真会碰到：Markdown 教程、shell 注释、配置片段。
    let o = outline("# A\n\n```\n# 假标题\n```\n\n# B");
    let heads: Vec<&str> = o.iter().map(|s| s.heading.as_str()).collect();
    assert_eq!(heads, vec!["A", "B"], "代码块里的 # 被当成标题了");
}

#[test]
fn test_tilde_fence_also_counts() {
    let o = outline("# A\n\n~~~\n# 假标题\n~~~\n\n# B");
    let heads: Vec<&str> = o.iter().map(|s| s.heading.as_str()).collect();
    assert_eq!(heads, vec!["A", "B"]);
}

#[test]
fn test_longer_fence_wraps_shorter_one() {
    // ```` 里嵌 ``` 是合法内容（展示 Markdown 代码时就这么写）。
    // 若闭合不看长度，内层的 ``` 会提前关闭围栏，里面的 # 就漏出来了。
    let o = outline("````\n```\n# 里面\n```\n````\n\n# 真标题");
    let heads: Vec<&str> = o.iter().map(|s| s.heading.as_str()).collect();
    // 围栏块本身就是第一个标题之前的内容，所以应当有一个引言节。
    assert_eq!(heads, vec!["", "真标题"]);
    assert!(
        !heads.contains(&"里面"),
        "内层的 ``` 提前关闭了围栏，里面的 # 漏成标题了：{:?}",
        heads
    );
}

#[test]
fn test_setext_equals_is_a_heading() {
    let o = outline("标题一\n===\n\n正文");
    assert_eq!(o.len(), 1);
    assert_eq!(o[0].heading, "标题一");
    assert_eq!(o[0].level, 1);
    assert_eq!(o[0].heading_line, Some(0), "标题行指的是文字行而不是 === 行");
    assert_eq!(o[0].body_start, 2, "setext 占两行，正文从第三行起");
}

#[test]
fn test_dashes_are_a_rule_not_a_heading() {
    // 🔴 与 CommonMark 的有意偏离（见 sections.rs 头部）。
    // 剪贴板内容里 `---` 绝大多数是分割线；误识别会把上一句正文凭空造成标题。
    let o = outline("文字\n---\n\n更多");
    assert_eq!(o.len(), 1);
    assert_eq!(o[0].index, 0, "--- 不得被当成 setext 二级标题");
}

#[test]
fn test_frontmatter_is_skipped() {
    // 导入/导出（A-57）写出的文件开头就是 frontmatter。
    let o = outline("---\ntitle: x\n---\n\n# A\n正文");
    assert_eq!(o.len(), 1);
    assert_eq!(o[0].heading, "A");
    assert_eq!(o[0].heading_line, Some(4));
}

#[test]
fn test_unclosed_frontmatter_is_not_frontmatter() {
    // 一篇以 --- 开头的普通笔记不能被整篇吞掉。
    let o = outline("---\n只有一行");
    assert_eq!(o.len(), 1);
    assert_eq!(o[0].body_start, 0);
    assert_eq!(o[0].body_end, 2);
}

#[test]
fn test_level_jump_does_not_invent_middle_level() {
    // `#` 直接到 `###`。凭空补一个不存在的二级标题才是真的误导。
    let o = outline("# 一\n\n### 三\n正文");
    assert_eq!(o.len(), 2);
    assert_eq!(o[0].path, vec!["一".to_string()]);
    assert_eq!(o[1].path, vec!["一".to_string(), "三".to_string()]);
    assert_eq!(o[1].level, 3);
}

#[test]
fn test_child_count_counts_the_whole_subtree() {
    // child_count 存在的意义：`kb_update_section` 不动子节，
    // 不告知的话 AI 以为自己重写了整棵子树。
    let o = outline("# 一\n\n## 二 a\n\n### 三\n\n## 二 b\n\n# 另一个一");
    assert_eq!(o[0].heading, "一");
    assert_eq!(o[0].child_count, 3, "二 a / 三 / 二 b 都是它的子节");
    assert_eq!(o[1].heading, "二 a");
    assert_eq!(o[1].child_count, 1);
    let last = o.last().unwrap();
    assert_eq!(last.heading, "另一个一");
    assert_eq!(last.child_count, 0);
}

#[test]
fn test_indented_four_spaces_is_code_not_heading() {
    let o = outline("    # 不是标题\n\n# 是");
    let heads: Vec<&str> = o.iter().map(|s| s.heading.as_str()).collect();
    assert_eq!(heads, vec!["", "是"], "第一项是引言节（无标题）");
}

#[test]
fn test_hash_without_space_is_not_heading() {
    // `#tag` 这种标签写法得以幸免。
    let o = outline("#没空格\n正文");
    assert_eq!(o.len(), 1);
    assert_eq!(o[0].index, 0);
}

#[test]
fn test_closing_hashes_are_stripped() {
    let o = outline("## 标题 ##\n正文");
    assert_eq!(o[0].heading, "标题");
}

#[test]
fn test_seven_hashes_is_not_a_heading() {
    let o = outline("####### 七个\n正文");
    assert_eq!(o[0].index, 0, "标题最多六级");
}

#[test]
fn test_crlf_input_parses_and_keeps_carriage_returns() {
    // 🔴 剪贴板内容在 Windows 上大量是 CRLF。
    let c = "# A\r\n\r\n正文\r\n";
    let o = outline(c);
    assert_eq!(o.len(), 1);
    assert_eq!(o[0].heading, "A", "行尾的 \\r 不能跟进标题文字");
    let body = slice(c, &o[0], false);
    assert!(body.contains("\r\n"), "取出的原文要保留 CRLF：{:?}", body);
}

#[test]
fn test_slice_with_and_without_heading() {
    let c = "# A\n正文一\n正文二\n# B\nB";
    let o = outline(c);
    let a = &o[0];
    assert_eq!(slice(c, a, false), "正文一\n正文二");
    assert_eq!(slice(c, a, true), "# A\n正文一\n正文二");
}

#[test]
fn test_slice_of_empty_section_is_empty() {
    let c = "# A\n# B";
    let o = outline(c);
    assert_eq!(slice(c, &o[0], false), "", "A 没有正文");
}

// ===== 定位 =====

#[test]
fn test_locate_by_index() {
    let c = "# A\n\n## B\n正文";
    let s = locate(c, &SectionRef::Index(2)).unwrap();
    assert_eq!(s.heading, "B");
}

#[test]
fn test_locate_missing_index_reports_the_outline() {
    // 把大纲一并报回去，省 AI 一轮往返。
    let err = locate("# A", &SectionRef::Index(5)).unwrap_err();
    match &err {
        LocateError::NotFound { available } => {
            assert_eq!(available.len(), 1);
            assert!(available[0].contains("A"));
        }
        other => panic!("应该是 NotFound，实际：{:?}", other),
    }
    assert!(err.to_string().contains("当前大纲"));
}

#[test]
fn test_locate_by_path_suffix() {
    // AI 往往只知道自己要改哪个小标题，不知道它的完整路径。
    let c = "# 架构\n\n## 数据流\n正文";
    let s = locate(c, &SectionRef::Path("数据流".into())).unwrap();
    assert_eq!(s.index, 2);
    let s2 = locate(c, &SectionRef::Path("架构 / 数据流".into())).unwrap();
    assert_eq!(s2.index, 2, "完整路径也要能命中");
}

#[test]
fn test_duplicate_heading_path_is_ambiguous_not_guessed() {
    // 🔴 已拍板：歧义时报错而不猜。猜错了就是静默改坏另一节。
    let c = "# A\n\n## 细节\n\n# B\n\n## 细节";
    let err = locate(c, &SectionRef::Path("细节".into())).unwrap_err();
    match &err {
        LocateError::Ambiguous { candidates } => assert_eq!(candidates.len(), 2),
        other => panic!("应该是 Ambiguous，实际：{:?}", other),
    }
    // 加长路径就能定位。
    let s = locate(c, &SectionRef::Path("B / 细节".into())).unwrap();
    assert_eq!(s.index, 4);
}

#[test]
fn test_locate_in_note_without_headings_says_use_index_zero() {
    let err = locate("纯文本", &SectionRef::Path("任何".into())).unwrap_err();
    // 这篇只有引言节，所以 available 非空，文案该指向大纲。
    assert!(matches!(err, LocateError::NotFound { .. }));
}

// ===== 编辑 =====

#[test]
fn test_update_section_replaces_only_that_body() {
    let c = "# A\n旧正文\n# B\nB正文";
    let (out, rep) = apply(
        c,
        &ContentEdit::UpdateSection {
            locator: SectionRef::Index(1),
            body: "新正文".into(),
        },
    )
    .unwrap();
    assert!(out.contains("新正文"));
    assert!(!out.contains("旧正文"));
    assert!(out.contains("# B\nB正文"), "B 节不得被动：{:?}", out);
    assert_eq!(rep.untouched_children, 0);
}

#[test]
fn test_update_section_keeps_blank_line_before_next_heading() {
    // 🔴 没空行隔开时 Markdown 会渲染成同一段，
    // 那是「改完看着像对的、实际坏了」那一类。
    let c = "# A\n旧\n# B\nB";
    let (out, _) = apply(
        c,
        &ContentEdit::UpdateSection {
            locator: SectionRef::Index(1),
            body: "新".into(),
        },
    )
    .unwrap();
    assert_eq!(out, "# A\n\n新\n\n# B\nB");
}

#[test]
fn test_update_section_with_empty_body_clears_it() {
    let c = "# A\n旧\n\n# B\n";
    let (out, _) = apply(
        c,
        &ContentEdit::UpdateSection {
            locator: SectionRef::Index(1),
            body: String::new(),
        },
    )
    .unwrap();
    assert_eq!(out, "# A\n\n# B\n", "清空后标题之间仍要有空行");
}

#[test]
fn test_update_section_reports_untouched_children() {
    let c = "# 一\n正文\n\n## 二\n子节正文";
    let (out, rep) = apply(
        c,
        &ContentEdit::UpdateSection {
            locator: SectionRef::Index(1),
            body: "改了".into(),
        },
    )
    .unwrap();
    assert_eq!(rep.untouched_children, 1, "必须告知子节没被动");
    assert!(out.contains("子节正文"), "子节真的不能被动");
}

#[test]
fn test_insert_before_heading() {
    let c = "# A\n正文\n# B\nB";
    let (out, _) = apply(
        c,
        &ContentEdit::InsertAtSection {
            locator: SectionRef::Index(2),
            text: "新段".into(),
            at: InsertAt::BeforeHeading,
        },
    )
    .unwrap();
    assert_eq!(out, "# A\n正文\n\n新段\n\n# B\nB");
}

#[test]
fn test_insert_at_body_start_and_end() {
    let c = "# A\n一\n二";
    let (start, _) = apply(
        c,
        &ContentEdit::InsertAtSection {
            locator: SectionRef::Index(1),
            text: "顶部".into(),
            at: InsertAt::BodyStart,
        },
    )
    .unwrap();
    assert_eq!(start, "# A\n\n顶部\n\n一\n二");

    let (end, _) = apply(
        c,
        &ContentEdit::InsertAtSection {
            locator: SectionRef::Index(1),
            text: "尾部".into(),
            at: InsertAt::BodyEnd,
        },
    )
    .unwrap();
    assert_eq!(end, "# A\n一\n二\n\n尾部");
}

#[test]
fn test_insert_empty_text_is_an_error_not_a_silent_noop() {
    // 规则 #15.3：空插入当成功会让模型以为它写进去了。
    let err = apply(
        "# A\n正文",
        &ContentEdit::InsertAtSection {
            locator: SectionRef::Index(1),
            text: "   \n  ".into(),
            at: InsertAt::BodyEnd,
        },
    )
    .unwrap_err();
    assert!(err.contains("没有执行任何修改"));
}

#[test]
fn test_insert_strips_its_own_padding_blank_lines() {
    // 插入块自带首尾空行时不能攒出一堆空行。
    let c = "# A\n正文";
    let (out, _) = apply(
        c,
        &ContentEdit::InsertAtSection {
            locator: SectionRef::Index(1),
            text: "\n\n新段\n\n".into(),
            at: InsertAt::BodyEnd,
        },
    )
    .unwrap();
    assert_eq!(out, "# A\n正文\n\n新段");
}

#[test]
fn test_replace_text_unique_hit() {
    let (out, rep) = apply(
        "一二三四",
        &ContentEdit::ReplaceText {
            find: "二三".into(),
            replace: "XY".into(),
        },
    )
    .unwrap();
    assert_eq!(out, "一XY四");
    assert_eq!(rep.summary, "已替换 1 处。");
}

#[test]
fn test_replace_text_zero_hits_changes_nothing() {
    let err = apply(
        "正文",
        &ContentEdit::ReplaceText {
            find: "不存在的".into(),
            replace: "X".into(),
        },
    )
    .unwrap_err();
    assert!(err.contains("找不到"));
    assert!(err.contains("没有执行任何修改"));
}

#[test]
fn test_replace_text_multiple_hits_refuses_and_says_how_many() {
    // 🔴 两种默认（全换 / 只换第一处）都是静默的错。
    let err = apply(
        "abc\nabc",
        &ContentEdit::ReplaceText {
            find: "abc".into(),
            replace: "X".into(),
        },
    )
    .unwrap_err();
    assert!(err.contains("2 处"), "要告知实际几处：{}", err);
    assert!(err.contains("一处也没改"));
}

#[test]
fn test_replace_text_matches_lf_find_against_crlf_content() {
    // 🔴 本批最容易静默坏掉的一条：剪贴板内容是 CRLF，AI 发来的 find 是 LF。
    // 直接匹配会报「找不到」——而那段原文就在那里、AI 刚刚还读过。
    let (out, _) = apply(
        "第一行\r\n第二行\r\n",
        &ContentEdit::ReplaceText {
            find: "第一行\n第二行".into(),
            replace: "已改".into(),
        },
    )
    .unwrap();
    assert_eq!(out, "已改\r\n");
}

#[test]
fn test_replace_text_empty_find_is_rejected() {
    let err = apply(
        "正文",
        &ContentEdit::ReplaceText {
            find: String::new(),
            replace: "X".into(),
        },
    )
    .unwrap_err();
    assert!(err.contains("不能为空"));
}

#[test]
fn test_prepend_goes_after_frontmatter() {
    // 插在第 0 行会把 frontmatter 撑坏。
    let c = "---\ntitle: x\n---\n\n# A\n正文";
    let (out, _) = apply(c, &ContentEdit::Prepend { text: "新开头".into() }).unwrap();
    assert!(
        out.starts_with("---\ntitle: x\n---\n"),
        "frontmatter 被动了：{:?}",
        out
    );
    assert!(out.contains("新开头"));
    assert!(out.contains("# A"));
    // 新内容要在标题前面。
    let i_new = out.find("新开头").unwrap();
    let i_head = out.find("# A").unwrap();
    assert!(i_new < i_head);
}

#[test]
fn test_prepend_on_plain_note() {
    let (out, _) = apply("原有内容", &ContentEdit::Prepend { text: "新的".into() }).unwrap();
    assert_eq!(out, "新的\n\n原有内容");
}

#[test]
fn test_prepend_empty_is_an_error() {
    let err = apply("正文", &ContentEdit::Prepend { text: " ".into() }).unwrap_err();
    assert!(err.contains("没有执行任何修改"));
}

#[test]
fn test_edit_on_missing_section_reports_locate_error() {
    let err = apply(
        "# A\n正文",
        &ContentEdit::UpdateSection {
            locator: SectionRef::Path("没这节".into()),
            body: "X".into(),
        },
    )
    .unwrap_err();
    assert!(err.contains("找不到这一节"));
}

#[test]
fn test_editing_a_crlf_note_keeps_crlf_elsewhere() {
    // 改一节不能把全文的行尾改成 LF——那相当于整篇重写，
    // 一下子把「只改了一节」变成了整篇 diff。
    let c = "# A\r\n旧\r\n\r\n# B\r\nB正文\r\n";
    let (out, _) = apply(
        c,
        &ContentEdit::UpdateSection {
            locator: SectionRef::Index(1),
            body: "新".into(),
        },
    )
    .unwrap();
    assert!(out.contains("# B\r\nB正文\r\n"), "B 节的 CRLF 丢了：{:?}", out);
}
