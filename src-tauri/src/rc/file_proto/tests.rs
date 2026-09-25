//! `file_proto.rs` 的单元测试（从原文件尾部的 mod tests 原样平移）。

use super::*;

// ── 文件名净化 ─────────────────────────────────────────────────────

#[test]
fn 正常名字原样通过() {
    assert_eq!(safe_file_name("报告.zip").unwrap(), "报告.zip");
    assert_eq!(safe_file_name("  a b.txt  ").unwrap(), "a b.txt");
    assert_eq!(safe_file_name(".gitignore").unwrap(), ".gitignore");
    assert_eq!(safe_file_name("a.b.c.tar.gz").unwrap(), "a.b.c.tar.gz");
}

#[test]
fn 带路径的名字只取最后一段() {
    // 兼容对端误带路径，但绝不重建目录结构（v1 扁平的硬约束）
    assert_eq!(
        safe_file_name("C:\\Users\\x\\报告.zip").unwrap(),
        "报告.zip"
    );
    assert_eq!(safe_file_name("/home/u/photo.png").unwrap(), "photo.png");
    // `..` 段被当路径剥掉——落到本机时只剩文件名
    assert_eq!(safe_file_name("../../etc/passwd").unwrap(), "passwd");
}

#[test]
fn 空名与纯跳转名被拒() {
    assert!(safe_file_name("").is_err());
    assert!(safe_file_name("   ").is_err());
    assert!(safe_file_name(".").is_err());
    assert!(safe_file_name("..").is_err());
    assert!(safe_file_name("C:\\Users\\x\\").is_err(), "剥完为空要拒");
    // 结尾点是 Windows 会静默剥的，剥完为空 ⇒ 拒
    assert!(safe_file_name("...").is_err());
}

#[test]
fn 结尾点与空格被剥掉() {
    // 不剥的话 `a.` 与 `a` 会撞同一个落点，而重名判据看到的却是两个名字
    assert_eq!(safe_file_name("a.").unwrap(), "a");
    assert_eq!(safe_file_name("a.  ").unwrap(), "a");
    assert_eq!(safe_file_name("a .txt").unwrap(), "a .txt", "中间的点不动");
}

#[test]
fn 非法字符被替换成下划线() {
    assert_eq!(safe_file_name("a:b*c?.txt").unwrap(), "a_b_c_.txt");
    assert_eq!(safe_file_name("a<b>c|d.txt").unwrap(), "a_b_c_d.txt");
    assert_eq!(safe_file_name("a\"b.txt").unwrap(), "a_b.txt");
    // 控制字符（含 NUL——它能让 C 侧 API 提前截断）
    assert_eq!(safe_file_name("a\u{0}b\tc.txt").unwrap(), "a_b_c.txt");
}

#[test]
fn windows保留名被前缀化() {
    assert_eq!(safe_file_name("CON").unwrap(), "_CON");
    assert_eq!(safe_file_name("nul").unwrap(), "_nul");
    assert_eq!(safe_file_name("NUL.txt").unwrap(), "_NUL.txt", "带扩展名同样是保留名");
    assert_eq!(safe_file_name("com1.log").unwrap(), "_com1.log");
    assert_eq!(safe_file_name("LPT9").unwrap(), "_LPT9");
    assert_eq!(safe_file_name("COM0").unwrap(), "_COM0");
    // D8：控制台输入/输出句柄同样是保留设备名（含带扩展名的形态）
    assert_eq!(safe_file_name("CONIN$").unwrap(), "_CONIN$");
    assert_eq!(safe_file_name("conout$").unwrap(), "_conout$");
    assert_eq!(safe_file_name("CONOUT$.txt").unwrap(), "_CONOUT$.txt");
    // 不是保留名的不能被误伤
    assert_eq!(safe_file_name("CONSOLE.txt").unwrap(), "CONSOLE.txt");
    assert_eq!(safe_file_name("com10.txt").unwrap(), "com10.txt");
    assert_eq!(safe_file_name("MYCON.txt").unwrap(), "MYCON.txt");
    assert_eq!(safe_file_name("a.com1.txt").unwrap(), "a.com1.txt", "主干是 a 不是 com1");
    assert_eq!(safe_file_name("CONIN2.txt").unwrap(), "CONIN2.txt", "CONIN2 不是设备名");
}

#[test]
fn 超长名字被截断且保留扩展名() {
    let long = format!("{}.zip", "字".repeat(500));
    let out = safe_file_name(&long).unwrap();
    assert!(out.encode_utf16().count() <= MAX_COMPONENT);
    assert!(out.ends_with(".zip"), "扩展名要留住：{}", out);
    assert!(out.len() <= MAX_NAME_BYTES);

    // 单字节名字走字节口径
    let ascii = format!("{}.txt", "a".repeat(2000));
    let out = safe_file_name(&ascii).unwrap();
    assert!(out.chars().count() <= MAX_COMPONENT);
    assert!(out.ends_with(".txt"));
}

/// 🔴 D8 回归钉：255 上限按 **UTF-16 码元**算。
///
/// 辅助平面字符（emoji 等）一个码点占 2 个码元。按 `chars().count()` 卡上限
/// 会放过最坏 510 码元的名字——落盘才失败，而那时用户已经在等传输了。
#[test]
fn 超长名字按utf16码元截断_emoji不吃两份预算() {
    let long = format!("{}.png", "😀".repeat(300));
    let out = safe_file_name(&long).unwrap();
    assert!(
        out.encode_utf16().count() <= MAX_COMPONENT,
        "码元数必须落在 255 以内，实得 {}",
        out.encode_utf16().count()
    );
    assert!(out.ends_with(".png"), "扩展名要留住：{}", out);
    // 255 码元 - ".png"（4）= 251 码元 → 125 个 emoji（每个 2 码元）
    assert_eq!(out, format!("{}.png", "😀".repeat(125)));
    // 边界：不超限就不该被动（125 个 emoji + ".png" = 254 码元，贴着 255 上限）
    let exact = format!("{}.png", "😀".repeat(125));
    assert_eq!(exact.encode_utf16().count(), 254);
    assert_eq!(safe_file_name(&exact).unwrap(), exact);
}

// ── 重名递增 ───────────────────────────────────────────────────────

#[test]
fn 重名递增不覆盖() {
    let taken = ["报告.zip", "报告 (1).zip"];
    let out = unique_name("报告.zip", |n| taken.contains(&n)).unwrap();
    assert_eq!(out, "报告 (2).zip");
    // 无冲突时原样返回
    assert_eq!(unique_name("新.zip", |_| false).unwrap(), "新.zip");
    // 没有扩展名
    assert_eq!(unique_name("README", |n| n == "README").unwrap(), "README (1)");
    // 隐藏文件（点开头）不会被拆成空主干
    assert_eq!(
        unique_name(".env", |n| n == ".env").unwrap(),
        ".env (1)"
    );
}

/// P1-4：同名 `.pppart` 存在时必须换名——只查最终名会撞上正在写的 part。
#[test]
fn 同名pppart占用时换名() {
    // 磁盘上只有 `.pppart`，没有最终名
    let out = unique_name("报告.zip", |n| {
        name_or_part_taken(n, |p| p == format!("报告.zip{}", PART_SUFFIX))
    })
    .unwrap();
    assert_eq!(out, "报告 (1).zip");
    // 最终名与 part 都空闲 → 原样
    assert_eq!(
        unique_name("新.zip", |n| name_or_part_taken(n, |_| false)).unwrap(),
        "新.zip"
    );
    // 只占最终名也仍要换名（回归 name_or_part_taken 的或语义）
    let out2 = unique_name("报告.zip", |n| name_or_part_taken(n, |p| p == "报告.zip")).unwrap();
    assert_eq!(out2, "报告 (1).zip");
}

/// 🔴 D8 同族回归钉：重名递增的预算也必须按 **UTF-16 码元**算。
///
/// 边缘用例是一个已经把 255 码元用满的 emoji 名字要加 `(1)`：按码点数算预算
/// 时截得不够长，`clamp_component` 会把刚拼上的 `(1)` 削掉 → 候选等于原名 →
/// 一直冲突到 9999 次才报错（同规则 15 的「点了没反应」）。
#[test]
fn 重名递增_emoji名字也能腾出后缀位置() {
    let base = format!("{}.png", "😀".repeat(125)); // 254 码元，贴着上限
    assert_eq!(base.encode_utf16().count(), 254);
    let out = unique_name(&base, |n| n == base).unwrap();
    assert!(out.ends_with(".png"), "扩展名要留住：{out}");
    assert!(out.contains(" (1)"), "要真的腾出后缀位置：{out}");
    assert!(
        out.encode_utf16().count() <= MAX_COMPONENT,
        "码元数仍要落回 255 以内：{}",
        out.encode_utf16().count()
    );
}

#[test]
fn 重名递增不会撑爆长度() {
    let long = format!("{}.zip", "字".repeat(250));
    // 只占原名，让 (1) 候选可用
    let out = unique_name(&long, |n| n == long).unwrap();
    assert!(out.chars().count() <= MAX_COMPONENT, "{}", out.chars().count());
    // 🔴 后缀必须还在：曾经的实现是「先拼后缀再截断」，于是把 `(1)` 截掉了，
    //    候选等于原名 ⇒ 永远冲突 ⇒ 空转到上限报错（下面这条断言就是那个 bug 的守卫）。
    assert!(out.contains("(1)"), "递增后缀被截掉了：{}", out);
    assert!(out.ends_with(".zip"), "扩展名要留住：{}", out);
    // 长名字连续冲突也不能挂
    let out2 = unique_name(&long, |n| n == long || n.contains("(1)")).unwrap();
    assert!(out2.contains("(2)"), "{}", out2);
}

// ── 线格式 ─────────────────────────────────────────────────────────

#[test]
fn 头帧往返() {
    let h = FileHead::Push {
        v: VERSION,
        name: "报告.zip".into(),
        size: 12_345_678,
    };
    let b = encode_head(&h).unwrap();
    assert_eq!(decode_head(&b).unwrap(), h);
    assert!(String::from_utf8(b.clone()).unwrap().contains("\"t\":\"push\""));

    let p = FileHead::PullReq {
        v: VERSION,
        resume: vec![],
    };
    let b = encode_head(&p).unwrap();
    assert_eq!(decode_head(&b).unwrap(), p);
    let s = String::from_utf8(b.clone()).unwrap();
    assert!(s.contains("\"t\":\"pull_req\""));
    assert!(!s.contains("resume"), "空提示不上线：{}", s);
    // 旧/简写形态（无 resume）要能解
    assert_eq!(
        decode_head(br#"{"t":"pull_req","v":1}"#).unwrap(),
        FileHead::PullReq {
            v: VERSION,
            resume: vec![]
        }
    );

    // 续传提示往返
    let p2 = FileHead::PullReq {
        v: VERSION,
        resume: vec![ResumeHint {
            name: "素材.mp4".into(),
            offset: 123_456,
        }],
    };
    assert_eq!(decode_head(&encode_head(&p2).unwrap()).unwrap(), p2);
}

#[test]
fn 头帧拒绝版本不符与超限() {
    let bad_v = br#"{"t":"push","v":9,"name":"a.txt","size":1}"#;
    let e = decode_head(bad_v).unwrap_err();
    assert_eq!(e.code, code::VERSION);

    let too_big = format!(
        r#"{{"t":"push","v":1,"name":"a.txt","size":{}}}"#,
        MAX_FILE_BYTES + 1
    );
    let e = decode_head(too_big.as_bytes()).unwrap_err();
    assert_eq!(e.code, code::SIZE_LIMIT);

    let bad_name = br#"{"t":"push","v":1,"name":"..","size":1}"#;
    let e = decode_head(bad_name).unwrap_err();
    assert_eq!(e.code, code::BAD_NAME);

    // 空 / 超长 / 垃圾
    assert_eq!(decode_head(b"").unwrap_err().code, code::BAD_HEAD);
    assert_eq!(decode_head(&vec![b'x'; MAX_HEAD_JSON + 1]).unwrap_err().code, code::BAD_HEAD);
    assert_eq!(decode_head(b"not json").unwrap_err().code, code::BAD_HEAD);
}

#[test]
fn 续传提示越界被拒() {
    let too_many = FileHead::PullReq {
        v: VERSION,
        resume: (0..MAX_RESUME_HINTS + 1)
            .map(|i| ResumeHint {
                name: format!("f{i}"),
                offset: 1,
            })
            .collect(),
    };
    assert_eq!(encode_head(&too_many).unwrap_err().code, code::BAD_HEAD);

    let too_big = FileHead::PullReq {
        v: VERSION,
        resume: vec![ResumeHint {
            name: "a".into(),
            offset: MAX_FILE_BYTES + 1,
        }],
    };
    assert_eq!(encode_head(&too_big).unwrap_err().code, code::BAD_HEAD);

    // 正常几条要能过
    let ok = FileHead::PullReq {
        v: VERSION,
        resume: vec![ResumeHint {
            name: "a.bin".into(),
            offset: 7,
        }],
    };
    assert!(encode_head(&ok).is_ok());
}

/// 🔴 B7（2026-09-25 审计）守卫：发送侧必须按**编码后总长**裁 hints。
///
/// 旧口径只逐条查名字长度，长中文名 ×[`MAX_RESUME_HINTS`] 条的 head 编码后
/// 远超 [`MAX_HEAD_JSON`]，接收侧按总长拒收——「发得出、收不进」，整次取回
/// 失败。修复后发送侧自己裁到塞得下为止（hints 是便利品不是必需品）。
#[test]
fn 续传提示按编码后总长裁剪_长中文名极端用例_b7() {
    // 每条名字 300 个汉字 ≈ 900 字节 UTF-8；8 条编码后 ≈7.4KB，远超 4096。
    let hints: Vec<ResumeHint> = (0..MAX_RESUME_HINTS)
        .map(|i| ResumeHint {
            name: format!("{}第{}部分.mp4", "很长的中文视频文件名字".repeat(20), i),
            offset: 123_456,
        })
        .collect();
    let raw_len = serde_json::to_vec(&hints).unwrap().len();
    assert!(raw_len > MAX_HEAD_JSON, "前置：用例本身必须超预算（{raw_len}）");

    let kept = clamp_resume_hints(hints);
    assert!(kept.len() < MAX_RESUME_HINTS, "超预算必须逐条丢弃，实际保留 {}", kept.len());
    assert!(!kept.is_empty(), "单条提示必然塞得下（名字 ≤ 1024 字节），不许裁到空");
    // 发出去的这条头，接收侧必须能原样收下——「发得出、收不进」不再成立
    let bytes = encode_head(&FileHead::PullReq {
        v: VERSION,
        resume: kept.clone(),
    })
    .unwrap();
    assert!(bytes.len() <= MAX_HEAD_JSON, "编码后 {} 字节仍超限", bytes.len());
    assert_eq!(
        decode_head(&bytes).unwrap(),
        FileHead::PullReq { v: VERSION, resume: kept },
        "接收侧解码必须成功"
    );

    // 正常长度的 8 条一条也不许丢（便利品不等于可以白丢）
    let small: Vec<ResumeHint> = (0..MAX_RESUME_HINTS)
        .map(|i| ResumeHint {
            name: format!("素材{i}.mp4"),
            offset: i as u64,
        })
        .collect();
    assert_eq!(clamp_resume_hints(small.clone()), small);
}

#[test]
fn 确认帧往返与缺字段() {
    let a = FileAck::Accept {
        name: None,
        size: None,
        offset: 0,
    };
    let b = encode_ack(&a).unwrap();
    let s = String::from_utf8(b.clone()).unwrap();
    assert!(!s.contains("offset"), "offset=0 时不上线（保持最小）");
    assert_eq!(decode_ack(&b).unwrap(), a);

    let r = FileAck::Accept {
        name: Some("a.bin".into()),
        size: Some(1024),
        offset: 512,
    };
    assert_eq!(decode_ack(&encode_ack(&r).unwrap()).unwrap(), r);

    let d = FileAck::Deny {
        reason: "不要".into(),
        code: Some(code::DENIED.into()),
    };
    assert_eq!(decode_ack(&encode_ack(&d).unwrap()).unwrap(), d);

    // 取回方向：对端没填 name/size ⇒ 落盘前就该拒（不能拿 None 去开文件）
    let incomplete: FileAck = decode_ack(br#"{"t":"accept","offset":0}"#).unwrap();
    match incomplete {
        FileAck::Accept { name, size, .. } => {
            let e = check_ack_accept(name.as_deref(), size).unwrap_err();
            assert_eq!(e.code, code::BAD_HEAD);
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn 确认帧的尺寸同样夹住() {
    let e = check_ack_accept(Some("a.bin"), Some(MAX_FILE_BYTES + 1)).unwrap_err();
    assert_eq!(e.code, code::SIZE_LIMIT);
    // 名字也要过净化（取回方向由对端给名，是最容易被忽略的入口）
    let (clean, size) = check_ack_accept(Some("..\\..\\x.exe"), Some(9)).unwrap();
    assert_eq!(clean, "x.exe");
    assert_eq!(size, 9);
    let e = check_ack_accept(Some(".."), Some(9)).unwrap_err();
    assert_eq!(e.code, code::BAD_NAME);
}

#[test]
fn 魔数识别() {
    assert!(is_magic(b"PPFIL1"));
    assert!(is_magic(b"PPFIL1xxxx"));
    assert!(!is_magic(b"PPAUD1"));
    assert!(!is_magic(b"PPFI"));
    assert!(!is_magic(b""));
}

#[test]
fn part文件命名往返() {
    assert_eq!(part_path("报告.zip"), "报告.zip.pppart");
    assert_eq!(final_from_part("报告.zip.pppart"), Some("报告.zip"));
    assert_eq!(final_from_part("报告.zip"), None);
}

/// P1-6：RTLO（U+202E）欺骗必须被净化——否则 `报价\u{202E}gpj.exe`
/// 在确认条/资源管理器里显示成「报价exe.jpg」，双击即执行。
#[test]
fn rtl混淆字符被替换() {
    let cleaned = safe_file_name("报价\u{202E}gpj.exe").expect("净化不该失败");
    assert!(!cleaned.contains('\u{202E}'), "U+202E 穿透了净化：{cleaned}");
    assert!(cleaned.ends_with(".exe"), "净化后真实扩展名必须还在：{cleaned}");
    // 其它 Cf 类一并拦
    assert!(!safe_file_name("a\u{200B}b.txt").unwrap().contains('\u{200B}'));
    assert!(!safe_file_name("a\u{2066}b.txt").unwrap().contains('\u{2066}'));
    // 正常名不受影响
    assert_eq!(safe_file_name("报价.txt").unwrap(), "报价.txt");
}
