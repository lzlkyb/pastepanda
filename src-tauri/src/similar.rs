//! 近重复判定（AM-8）。**纯函数，不碰数据库、不碰界面。**
//!
//! # 它解决的问题
//!
//! 标签只 `trim()`，不折大小写也不查近似（`tag.rs`）。
//! 于是 `Java` 和 `java` 是两个标签——真库里就有这一组（2026-09-04 实测 38 个标签）。
//!
//! 对人是「标签越用越乱」；对 AI 更糟：它靠 `[[标题]]` 建链、靠标签收窄检索，
//! **标题分叉的后果是链断了但没有任何人收到通知**。
//!
//! # 两档，而不是一个阈值
//!
//! | 档 | 判据 | 含义 |
//! |---|---|---|
//! | 强候选 | 归一化后**完全相等** | 几乎一定是同一个 |
//! | 弱候选 | 归一化后编辑距离 1~2，且**两串都长于 4 字** | 可能是同一个，交给人看 |
//!
//! 🔴 **长度门槛不是保守，是必需**。真库实测：不加它有 **73 对**弱候选，
//! 加了之后 **0 对**——那 73 对全是噪声，因为 30/37 个标签不超过 4 个字，
//! 而两个毫不相干的 2 字串（`go` 与 `密钥`）编辑距离就是 2。
//! `NC65` 与 `NC66` 是同一个道理：距离 1，但是两回事。
//!
//! # 三条边界
//!
//! - **折全半角，不折简繁**。「纪要」与「紀要」可能是用户有意区分的，
//!   而全角 `Ｊａｖａ` 与 `Java` 不可能是。
//! - **绝不在写入路径拦截**。写笔记时冒出一句「你是不是想用另一个标签」
//!   = 把一个建议变成一次失败（同红线③）。
//! - 合并动作**不在本模块**：它要复用 AM-3 的「遇同名跳过并告警」守卫，
//!   裸调 O-9 的标题级全库 `REPLACE` 会把指向另一篇同名笔记的链接一起改坏。

/// 短到不适用编辑距离的长度（字符）。见模块文档。
pub const SHORT_LEN: usize = 4;

/// 归一化：全角转半角 → 去首尾空白 → ASCII 小写。
///
/// ❗ **不做 NFKC**：那会顺带拆开合字、兼容字符等一大堆东西，
/// 比「全半角」这个需求宽得多，而多折的每一样都是一次潜在误合并。
/// 这里只处理两件确定要处理的事：全角 ASCII 区（`Ｊ` → `J`）与全角空格。
pub fn normalize(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            // 全角 ASCII：Ｕ+FF01..=U+FF5E 与半角 U+0021..=U+007E 差 0xFEE0
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
            '\u{3000}' => ' ',
            _ => c,
        })
        .collect::<String>()
        .trim()
        .to_lowercase()
}

/// 编辑距离（Levenshtein），**按字符算不按字节**。
///
/// 按字节算的话「纪要」与「记要」会得出 3 而不是 1，中文全废。
///
/// `max` 是提前退出上限：超过它就直接返 `max + 1`，不再算下去。
pub fn distance_within(a: &str, b: &str, max: usize) -> usize {
    let av: Vec<char> = a.chars().collect();
    let bv: Vec<char> = b.chars().collect();
    if av.len().abs_diff(bv.len()) > max {
        return max + 1;
    }
    let mut prev: Vec<usize> = (0..=bv.len()).collect();
    let mut cur = vec![0usize; bv.len() + 1];
    for (i, ca) in av.iter().enumerate() {
        cur[0] = i + 1;
        let mut row_min = cur[0];
        for (j, cb) in bv.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur[j + 1] = (prev[j + 1] + 1).min(cur[j] + 1).min(prev[j] + cost);
            row_min = row_min.min(cur[j + 1]);
        }
        // 整行都超上限了，后面只会更大。
        if row_min > max {
            return max + 1;
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[bv.len()]
}

/// 一组疑似重复。
///
/// 带 `Serialize` 是为了库体检（N3）能直接把它送到前端，
/// 不必另拄一个字段一模一样的 DTO（两份结构早晚会漂移）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct DupGroup {
    /// 组里的原始名字，保持传入顺序。
    pub names: Vec<String>,
    /// 强候选（归一化后相等）还是弱候选（距离 1~2）。
    pub strong: bool,
    /// 弱候选的距离；强候选为 0。
    pub distance: usize,
}

/// 距离上限。超过 2 就不是「写岔了」，是两个词。
const MAX_DISTANCE: usize = 2;

/// 找出一批名字里的疑似重复。**强候选排在前面**。
///
/// 只报告，不做任何合并——合并是另一件事，见模块文档。
pub fn find_dups(items: &[String]) -> Vec<DupGroup> {
    // 一、强候选：归一化后撞了。保持首次出现顺序，便于人核对。
    let mut keys: Vec<String> = Vec::new();
    let mut buckets: Vec<Vec<String>> = Vec::new();
    for it in items {
        let k = normalize(it);
        if k.is_empty() {
            continue;
        }
        match keys.iter().position(|x| *x == k) {
            Some(i) => {
                // 原名完全一样就不重复列（同一个名字出现两次是调用方的事）
                if !buckets[i].contains(it) {
                    buckets[i].push(it.clone());
                }
            }
            None => {
                keys.push(k);
                buckets.push(vec![it.clone()]);
            }
        }
    }

    let mut out: Vec<DupGroup> = buckets
        .iter()
        .filter(|b| b.len() > 1)
        .map(|b| DupGroup {
            names: b.clone(),
            strong: true,
            distance: 0,
        })
        .collect();

    // 二、弱候选：不同的归一化键之间距离 1~2，且两边都长于 SHORT_LEN。
    for i in 0..keys.len() {
        for j in (i + 1)..keys.len() {
            let (a, b) = (&keys[i], &keys[j]);
            // 🔴 长度门槛在算距离**之前**判：短串上这个距离没有意义，
            //    算出来也只会变成噪声（真库实测 73 对全是噪声）。
            if a.chars().count() <= SHORT_LEN || b.chars().count() <= SHORT_LEN {
                continue;
            }
            let d = distance_within(a, b, MAX_DISTANCE);
            if (1..=MAX_DISTANCE).contains(&d) {
                out.push(DupGroup {
                    names: vec![buckets[i][0].clone(), buckets[j][0].clone()],
                    strong: false,
                    distance: d,
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_归一化折大小写与全半角但不折简繁() {
        assert_eq!(normalize("  Java "), "java");
        assert_eq!(normalize("Ｊａｖａ"), "java", "全角字母要折成半角");
        assert_eq!(normalize("A　B"), "a b", "全角空格要变半角");
        assert_ne!(
            normalize("纪要"),
            normalize("紀要"),
            "简繁不折——那可能是用户有意区分的"
        );
    }

    #[test]
    fn test_编辑距离按字符不按字节() {
        assert_eq!(distance_within("纪要", "记要", 2), 1, "中文按字节算会得 3，全废");
        assert_eq!(distance_within("abc", "abc", 2), 0);
        assert_eq!(distance_within("abc", "abd", 2), 1);
    }

    #[test]
    fn test_距离超上限时提前退出() {
        // 只要不 panic 且返回 > max 即可；具体值不承诺。
        assert!(distance_within("完全不一样的一串字", "another string", 2) > 2);
    }

    #[test]
    fn test_强候选_大小写不同的同一个标签() {
        let dups = find_dups(&["Java".into(), "java".into(), "Rust".into()]);
        assert_eq!(dups.len(), 1, "{:?}", dups);
        assert!(dups[0].strong);
        assert_eq!(dups[0].names, vec!["Java", "java"]);
    }

    /// 🔴 真库实测逼出来的那条：短串上的编辑距离是纯噪声。
    ///
    /// 不加长度门槛时，本机 38 个标签会报出 **73 对**弱候选；
    /// 加了之后是 **0 对**。下面这三组正是那 73 对里的典型。
    #[test]
    fn test_短串不报弱候选() {
        for pair in [
            ["go", "密钥"],   // 两个 2 字串，毫不相干，距离却是 2
            ["NC65", "NC66"], // 距离 1，但是两回事
            ["env", "ini"],
            ["css", "nsis"],
        ] {
            let dups = find_dups(&[pair[0].into(), pair[1].into()]);
            assert!(
                dups.is_empty(),
                "{:?} 不该被报成近重复（短串距离没有意义）",
                pair
            );
        }
    }

    #[test]
    fn test_长串才报弱候选() {
        let dups = find_dups(&["会议纪要模板".into(), "会议记要模板".into()]);
        assert_eq!(dups.len(), 1, "{:?}", dups);
        assert!(!dups[0].strong, "这是弱候选，不能报成强的");
        assert_eq!(dups[0].distance, 1);
    }

    #[test]
    fn test_强候选排在弱候选前面() {
        let dups = find_dups(&[
            "会议纪要模板".into(),
            "会议记要模板".into(),
            "Java".into(),
            "java".into(),
        ]);
        assert_eq!(dups.len(), 2);
        assert!(dups[0].strong, "强候选必须在前：人先看确定的那些");
        assert!(!dups[1].strong);
    }

    #[test]
    fn test_距离3以上不算() {
        assert!(find_dups(&["会议纪要模板".into(), "季度总结报告".into()]).is_empty());
    }

    #[test]
    fn test_空名与完全同名不产生噪声() {
        // 空串跳过；两个一模一样的原名不该被列成「两个近似」。
        let dups = find_dups(&["".into(), "  ".into(), "Java".into(), "Java".into()]);
        assert!(dups.is_empty(), "{:?}", dups);
    }
}
