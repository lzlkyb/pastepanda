//! 「库的脉搏」——把「该写 / 该整理」的信号搭在模型必经之路上。
//!
//! # 为什么信号挂在返回文本上，而不是加进描述
//!
//! 起因是 2026-09-15 读 `mcp_audit` 那张表（14 天、去掉手工探针）：
//! 真实客户端只有**两次会话开局**来过这里（`kb_folders` + `kb_list`，
//! 每次相隔 0–9 秒），此后整场会话再也不碰。**判据没问题，是触发断了。**
//!
//! 而 `kb_folders` 恰好是模型每次开局**必经**的那一步 —— 于是把信号挂在这里：
//!
//! - **零描述字节**（`tools/list` 实测只剩 220，`instructions` 只剩 133 —— 都不是能再塞东西的地方）；
//! - **零新工具**（§7.7 已否决 `kb_lint`：需要人主动点的检查最后不会有人点）；
//! - **不依赖任何未验证假设**（不像 `instructions` 那样有投递率问题）。
//!
//! 这是 §7.7「AM-6 的教训」的第二次应用：**在模型已经要看的地方，加一句它该看的话。**
//!
//! # 为什么是纯函数
//!
//! 时间与开关都由调用方传进来，读数据不在这里（同 `gate.rs` 的分工）。
//! 这样「阈值边界」可以在没有数据库、没有应用的情况下逐条钉住。

/// 未分类开始算「堆起来」的阈值。
///
/// 取 5 而不是 1：一两篇散着是正常状态，逢数就喊会让这句提示变成噪音 ——
/// 而噪音的下场是被忽略，那还不如不喊。
pub const UNFILED_HINT_MIN: i64 = 5;

/// 多久没有新东西进来算「久未回写」。
pub const STALE_DAYS: i64 = 3;

/// 冷启动信号的门槛：库里至少要有这么多篇活笔记，才说「还没 AI 写入过」。
///
/// 取 1 而不是 0：**空库**（total=0）不上这条。理由有二：
/// ① 用户可能压根还没开始用笔记，对空库喊「开始写」是推销；
/// ② `FakeKb` 默认 `LibraryPulse::default()` 就是空库——若空库也喊，
///    每一条拿 `kb_folders` 全文做断言的老测试都会被污染。
///
/// 只要库里有 1 篇人写的，就说明知识库在被使用——那才是
/// 「装上 MCP 该开始自动记」的真实场景。
pub const COLD_START_MIN: i64 = 1;

/// `kb_folders` 要用的实数。
///
/// 🔴 一起返回、不拆成多个 trait 方法：理由同 `KbSource::write_switches`
/// —— 多一个方法就多一份要在 `FakeKb` 里搭的假实现。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LibraryPulse {
    /// 未分类（`folder_id IS NULL`）的笔记数，不含回收站。
    pub unfiled: i64,
    /// 库里最近一次「与 AI 有关」的写入时间（epoch 毫秒）。
    ///
    /// `None` = 从来没有过（新库，或 AI 一篇都没写过）。
    /// 🔴 空库时**不能**说「最近 N 天没有新东西」——那是句废话；
    /// 但**有笔记、AI 从没写过**时必须说（冷启动），见 `pulse_hint`。
    pub last_ai_ms: Option<i64>,
    /// 活笔记总数（不含回收站）。用来区分「空库」与「有内容但 AI 从没写入」。
    pub total: i64,
}

/// 「推不推」的闸门。三条都过，对应那句话才有意义。
///
/// 🔴 这个结构体存在的唯一理由：**只推模型做得到的事。**
/// 推一段它执行不了的指令，除了白搭一轮往返，还会把它逼去找别的路 ——
/// 那正是写开关要拦的行为（`protocol.rs` 里有同一条取舍的注释）。
///
/// 三个字段都不是「保守起见」，各自对应一种真会发生的配置：
///
/// | 字段 | 关掉它意味着 |
/// |---|---|
/// | `can_move` | 用户在设置里关了「移动文件夹」|
/// | `can_create` | 关了「新建笔记」|
/// | `move_targets == 0` | 授权范围里**一个可写的夹子都没有**（最常见的形态：只勾了「未分类」）|
///
/// 最后一条最容易漏：那时 `kb_move` 唯一的合法目的地就是未分类自己 ——
/// 等于是原地不动，「收进合适的夹子」纯属空话。
///
/// ❗ 三条是**分开**作用的，不是三个「全都要」。把它们合起来的后果是
/// 一处关闭会连坐另一条信号：第一版就把「久未回写」也挂在 `can_move` 上，
/// 于是「关了移动、留着新建」的用户会**静默失去**那条主动写入提醒。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PulseGates {
    /// `WriteKind::Move`（管 `kb_move`）开着吗。
    pub can_move: bool,
    /// `WriteKind::Create`（管 `kb_create`）开着吗。
    pub can_create: bool,
    /// 授权范围里可写入的夹子数（不含未分类）。口径见
    /// [`crate::mcp::gate::WriteScope::writable_folder_count`]。
    pub move_targets: usize,
}

/// 拼信号。空串 = 什么都不说（调用方直接拼上，不需要判）。
pub fn pulse_hint(p: &LibraryPulse, now_ms: i64, gates: &PulseGates) -> String {
    let mut out = String::new();

    // 未分类堆积：解决它要 `kb_list` + `kb_move`，所以两个条件都得满足 ——
    // 开关关着（模型搬不动），或者一个可写目的地都没有（搬了等于没搬），
    // 这句话都只是一句做不到的指令。
    if gates.can_move && gates.move_targets > 0 && p.unfiled >= UNFILED_HINT_MIN {
        // 边界写进文案里：「只动你自己写的」。这句不是客套 ——
        // 未分类里完全可能有用户自己写的笔记，而模型的默认理解会是
        // 「这一堆都归我管」。同 `kb_move` 描述里的那条边界。
        out.push_str(&format!(
            "📥 未分类里堆了 {} 篇。用 kb_list(author=\"me\") 一次找出你自己写的那些，\
             再用 kb_move 收进合适的夹子 —— **只动你自己写的**，\
             用户亲手写的一律不要碰。\n",
            p.unfiled
        ));
    }

    // 写入类信号：靠 `kb_create` 解决，与移动档**无关**。
    if gates.can_create {
        match p.last_ai_ms {
            // 冷启动：库里有笔记，但 AI 一篇都没写过。
            //
            // 🔴 这是审计实证出来的最大空洞（2026-09-15）：模型每次开局
            // `kb_folders + kb_list` 摸底就走，写入 0 次。原先 `None` 分支
            // 整段沉默——「从来没写过」反而没有任何提醒，比「三天没写」更该喊。
            //
            // 「用户不会提醒你」是责任归属：模型默认等指令，没人要求它写它就不写。
            // 这也是 `instructions`（WorkBuddy 不投递）之后，那句契约在 L2 上的落点。
            None => {
                if p.total >= COLD_START_MIN {
                    out.push_str(&format!(
                        "🌱 库里有 {} 篇笔记，但还没有 AI 写入过。\
                         本次会话若得出会被下次重新推导的结论、踩到项目特有的坑，\
                         或写出了项目说明（手册），**当轮就 kb_create 记进去**——\
                         用户不会提醒你。\n",
                        p.total
                    ));
                }
            }
            Some(ms) => {
                // 时钟回拨 / 未来时间戳时不报负数天：脏数据不该变出一句「-3 天没写」。
                let days = (now_ms - ms).max(0) / 86_400_000;
                if days >= STALE_DAYS {
                    out.push_str(&format!(
                        "⏳ 这个库已经 {} 天没有新东西进来了 —— 这次会话若有值得留下的结论，\
                         别等用户开口。\n",
                        days
                    ));
                }
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400_000;

    fn pulse(unfiled: i64, last_ai_days_ago: Option<i64>) -> (LibraryPulse, i64) {
        let now = 1_700_000_000_000;
        (
            LibraryPulse {
                unfiled,
                last_ai_ms: last_ai_days_ago.map(|d| now - d * DAY),
                // 有笔记：冷启动那条只在 `last_ai_ms == None` 时看 total。
                // 带上 Some 的用例不受 total 影响。
                total: 10,
            },
            now,
        )
    }

    /// 一切都开、也有地方可归。
    fn ok() -> PulseGates {
        PulseGates {
            can_move: true,
            can_create: true,
            move_targets: 1,
        }
    }

    #[test]
    fn test_未分类不够阈值时不提这件事() {
        let (p, now) = pulse(UNFILED_HINT_MIN - 1, Some(0));
        assert!(!pulse_hint(&p, now, &ok()).contains("未分类里堆了"));
    }

    #[test]
    fn test_未分类刚好到阈值就提() {
        let (p, now) = pulse(UNFILED_HINT_MIN, Some(0));
        let got = pulse_hint(&p, now, &ok());
        assert!(got.contains("未分类里堆了 5 篇"), "{}", got);
    }

    /// 边界必须写在文案里：未分类里可能有用户自己写的笔记，
    /// 而模型的默认理解会是「这一堆都归我管」。
    #[test]
    fn test_归类提示必须写明只动自己写的() {
        let (p, now) = pulse(9, Some(0));
        let got = pulse_hint(&p, now, &ok());
        assert!(got.contains("只动你自己写的"), "{}", got);
        assert!(got.contains("用户亲手写的一律不要碰"), "{}", got);
    }

    #[test]
    fn test_久未回写按天算且刚好到阈值才提() {
        let (p, now) = pulse(0, Some(STALE_DAYS - 1));
        assert!(!pulse_hint(&p, now, &ok()).contains("天没有新东西"));
        let (p, now) = pulse(0, Some(STALE_DAYS));
        assert!(pulse_hint(&p, now, &ok()).contains("已经 3 天没有新东西"));
        let (p, now) = pulse(0, Some(10));
        assert!(pulse_hint(&p, now, &ok()).contains("已经 10 天没有新东西"));
    }

    /// 空库（从来没写过、也一篇没有）不该被说成「N 天没写」——那是句废话。
    /// 也不该喊冷启动：对空库推销「开始写」是噪音，且会污染 FakeKb 默认路径。
    #[test]
    fn test_空库且从没有过_ai_写入时一句都不说() {
        let (mut p, now) = pulse(0, None);
        p.total = 0;
        assert_eq!(pulse_hint(&p, now, &ok()), "");
    }

    /// 🔴 冷启动：有笔记、AI 从没写过 —— 这是审计里最大的空洞。
    /// 原先 `None` 整段沉默，模型摸底完就走，写入永远是 0。
    #[test]
    fn test_有笔记但_ai_从没写过时推冷启动() {
        let (p, now) = pulse(2, None);
        let got = pulse_hint(&p, now, &ok());
        assert!(got.contains("还没有 AI 写入过"), "{}", got);
        assert!(got.contains("10 篇笔记"), "{}", got);
        assert!(got.contains("当轮就"), "{}", got);
        assert!(got.contains("用户不会提醒你"), "{}", got);
        // 不能说成「N 天没写」——那对从没写过是假话。
        assert!(!got.contains("天没有新东西"), "{}", got);
    }

    /// 冷启动也要守「只推做得到的事」：新建关着就闭嘴。
    #[test]
    fn test_新建关着时不推冷启动() {
        let (p, now) = pulse(2, None);
        let gates = PulseGates {
            can_move: true,
            can_create: false,
            move_targets: 3,
        };
        let got = pulse_hint(&p, now, &gates);
        assert!(!got.contains("还没有 AI 写入过"), "{}", got);
    }

    /// 🔴 只读模式下推「你该去归类」= 叫模型做一件它做不到的事。
    #[test]
    fn test_全关时一句都不推() {
        let (p, now) = pulse(20, Some(30));
        let off = PulseGates::default();
        assert_eq!(pulse_hint(&p, now, &off), "");
    }

    /// 🔴 授权范围里一个可写的夹子都没有（只勾了「未分类」）：`kb_move` 唯一的
    /// 合法目的地是未分类自己，等于原地不动 —— 那句话是空话，别推。
    ///
    /// 这是 2026-09-15 收紧范围闸之后**新出现**的形态：以前 AI 可以自建一个夹
    /// 再搬进去，所以「有地方可归」看着总成立；现在那个旁路封了，就必须显式数。
    #[test]
    fn test_没有可写的目的地时不推归类() {
        // 5 天前写过：这样「久未回写」那条**该**出现，才能验它没被连坐。
        let (p, now) = pulse(9, Some(5));
        let gates = PulseGates {
            can_move: true,
            can_create: true,
            move_targets: 0,
        };
        let got = pulse_hint(&p, now, &gates);
        assert!(!got.contains("未分类里堆了"), "叫它搬去一个不存在的地方：{}", got);
        // 另一条不受影响 —— 它与「有没有地方可归」无关。
        assert!(got.contains("已经 5 天没有新东西"), "被连坐了：{}", got);
    }

    /// 🔴 两条信号各有各的闸门，不能连坐。
    ///
    /// 第一版把「久未回写」也挂在 `can_move` 上：一个只关了「移动文件夹」、
    /// 留着「新建笔记」的用户会**静默失去**那条主动写入提醒 —— 而它是
    /// `instructions`（在 WorkBuddy 上不投递）之后，那条契约唯一的落点。
    #[test]
    fn test_关掉移动档不会连坐久未回写() {
        let (p, now) = pulse(9, Some(5));
        let gates = PulseGates {
            can_move: false,
            can_create: true,
            move_targets: 3,
        };
        let got = pulse_hint(&p, now, &gates);
        assert!(!got.contains("未分类里堆了"), "移动关着还推归类：{}", got);
        assert!(got.contains("已经 5 天没有新东西"), "被连坐掉了：{}", got);
    }

    /// 反过来：关了「新建笔记」就不能再叫它写东西。
    #[test]
    fn test_关掉新建档不会连坐归类提示() {
        let (p, now) = pulse(9, Some(30));
        let gates = PulseGates {
            can_move: true,
            can_create: false,
            move_targets: 3,
        };
        let got = pulse_hint(&p, now, &gates);
        assert!(got.contains("未分类里堆了"), "{}", got);
        assert!(!got.contains("天没有新东西"), "新建关着还叫它写：{}", got);
    }

    /// 脏数据（时间戳在未来）不该变出一句「-3 天没写」。
    #[test]
    fn test_时钟回拨时不报负数天() {
        let now = 1_700_000_000_000;
        let p = LibraryPulse {
            unfiled: 0,
            last_ai_ms: Some(now + 5 * DAY),
            total: 10,
        };
        assert_eq!(pulse_hint(&p, now, &ok()), "");
    }

    #[test]
    fn test_两条信号可以同时出现且各自独立() {
        let (p, now) = pulse(6, Some(4));
        let got = pulse_hint(&p, now, &ok());
        assert!(got.contains("未分类里堆了 6 篇"), "{}", got);
        assert!(got.contains("已经 4 天没有新东西"), "{}", got);
    }
}
