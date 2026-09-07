//! `sync::attach` 的行为钉子（W1）。
//!
//! 重点不是「能不能改写」，而是**不该改的一律不改**：
//! 改写函数弄坏正文是这一项最大的风险面，而弄坏了不会报错。

use super::attach::*;
use std::path::Path;

/// 实际形态：富文本 HTML 里那种（采集侧 `pathToFileUrl` 写的）。
const HASH: &str = "0039a52c11e99d4c9faeba55f9d1d1a2";

fn local_url() -> String {
    format!(
        "file:///C:/Users/19145/AppData/Roaming/com.pastepanda.app/images/{}.png",
        HASH
    )
}

#[test]
fn test_能认出富文本里的图片引用() {
    let html = format!("<p>看图</p><img src=\"{}\" alt=\"x\">", local_url());
    let refs = scan_local_refs(&html);
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].hash, HASH);
    assert_eq!(refs[0].ext, "png");
}

#[test]
fn test能认出_markdown_里的图片引用() {
    let md = format!("# 标题\n\n![截图]({})\n", local_url());
    assert_eq!(scan_local_refs(&md).len(), 1);
}

/// 同一张图被引用多次只算一份（否则会重复拷文件、清单也会重）。
#[test]
fn test_同一张图多次引用只算一份() {
    let md = format!("![a]({})\n\n![b]({})\n", local_url(), local_url());
    assert_eq!(scan_local_refs(&md).len(), 1);
}

// 🔴 下面这组是这个模块真正要钉的东西：不该改的别动。

#[test]
fn test_不动远程图片() {
    let md = "![x](https://example.com/images/0039a52c11e99d4c9faeba55f9d1d1a2.png)";
    assert!(scan_local_refs(md).is_empty(), "http 引用不属于本机附件");
    assert_eq!(to_portable(md), md, "不该改写远程引用");
}

#[test]
fn test_不动不在images目录下的本地路径() {
    let md = format!("![x](file:///C:/tmp/downloads/{}.png)", HASH);
    assert!(scan_local_refs(&md).is_empty());
    assert_eq!(to_portable(&md), md);
}

#[test]
fn test_不动长度不对的哈希() {
    // 31 位与 33 位都不是 md5，不能认
    let short = "file:///C:/x/images/0039a52c11e99d4c9faeba55f9d1d1a.png";
    let long = "file:///C:/x/images/0039a52c11e99d4c9faeba55f9d1d1a2b.png";
    assert!(scan_local_refs(short).is_empty(), "31 位不该认");
    assert!(scan_local_refs(long).is_empty(), "33 位不该认");
}

#[test]
fn test_不动普通文本里的十六进制串() {
    let md = format!("这是一个 md5：{}。不是图。", HASH);
    assert!(scan_local_refs(&md).is_empty());
    assert_eq!(to_portable(&md), md);
}

/// 🔴 回环不变式：本机 → 便携 → 本机 必须回到原样。
///
/// 这条守的是 `apply_delta` 里那条回声拦截（`identical`）：
/// 它拿文件里的文本与本地笔记比内容，回环不一致就永远比不相等，
/// 于是回声那一批每篇都满足 `both_changed` → **每轮再生一批冲突副本**。
#[test]
fn test_回环后与原文逐字相同() {
    let images = Path::new("C:/Users/19145/AppData/Roaming/com.pastepanda.app/images");
    let original = format!("<img src=\"{}\">\n正文。", local_url());

    let portable = to_portable(&original);
    assert!(portable.contains(PORTABLE_SCHEME), "应该已经便携化");
    assert!(!portable.contains("19145"), "便携形式里不得再带用户名");

    let back = to_local(&portable, images);
    assert_eq!(back, original, "回环必须逐字回到原样");
}

/// 🔴 便携化必须把整个 `file:///` 前缀一起吃掉。
///
/// 曾经从第 4 个字符起匹配（`e:/` 被当成盘符），留下 `filpp-asset:…`，
/// 回程就变成 `filfile:///…`。详见 `LOCAL_REF_RE` 上的注释。
#[test]
fn test_便携化时整个scheme前缀一起替掉() {
    let portable = to_portable(&local_url());
    assert_eq!(
        portable,
        format!("{}{}.png", PORTABLE_SCHEME, HASH),
        "scheme 前缀没被完整吃掉"
    );
}

/// 对面那台的用户名不一样——这正是“光搬字节没用”的原因。
#[test]
fn test_落到对端时用对端自己的路径() {
    let portable = to_portable(&local_url());
    let peer_images = Path::new("D:/Data/com.pastepanda.app/images");
    let landed = to_local(&portable, peer_images);
    assert!(landed.contains("D:/Data/com.pastepanda.app/images"));
    assert!(!landed.contains("19145"));
    assert!(landed.starts_with("file:///"), "必须与采集侧同格式，否则前端解不出来");
}

/// 附件目录**必须**带前导点：`collect_md` 跳过点目录，
/// 不带点的话它会被当成一个笔记文件夹，对端会凭空多出一个文件夹。
#[test]
fn test_附件目录名带前导点() {
    assert!(ASSETS_DIR.starts_with('.'));
    assert!(ASSETS_MANIFEST.starts_with('.'));
}

#[test]
fn test_超过上限的附件不搬() {
    let dir = std::env::temp_dir().join(format!("pp_attach_cap_{}", std::process::id()));
    let images = dir.join("images");
    let out = dir.join("out");
    std::fs::create_dir_all(&images).unwrap();
    let a = AssetRef {
        hash: HASH.to_string(),
        ext: "png".to_string(),
    };
    // 写一个比上限大 1 字节的文件
    std::fs::write(
        images.join(a.file_name()),
        vec![0u8; (MAX_ASSET_BYTES + 1) as usize],
    )
    .unwrap();
    assert_eq!(
        stage_asset(&images, &out, &a).unwrap(),
        None,
        "超限应该跳过（且由调用方报出来）"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_本机已有同名附件时不覆写() {
    let dir = std::env::temp_dir().join(format!("pp_attach_dedup_{}", std::process::id()));
    let staged = dir.join(ASSETS_DIR);
    let images = dir.join("images");
    std::fs::create_dir_all(&staged).unwrap();
    std::fs::create_dir_all(&images).unwrap();
    let name = format!("{}.png", HASH);
    std::fs::write(staged.join(&name), "对端的字节".as_bytes()).unwrap();
    std::fs::write(images.join(&name), "本机早就有的字节".as_bytes()).unwrap();

    let (landed, deduped) = adopt_assets(&staged, &images).unwrap();
    assert_eq!((landed, deduped), (0, 1));
    // 🔴 名字就是内容 hash，同名即同内容，所以不覆写——也避开了
    //    “覆写一个正在被读的图”。
    assert_eq!(
        std::fs::read(images.join(&name)).unwrap(),
        "本机早就有的字节".as_bytes()
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_附件落盘后字节一致() {
    let dir = std::env::temp_dir().join(format!("pp_attach_land_{}", std::process::id()));
    let staged = dir.join(ASSETS_DIR);
    let images = dir.join("images");
    std::fs::create_dir_all(&staged).unwrap();
    let name = format!("{}.png", HASH);
    // 字节串字面量只能装 ASCII，所以 PNG 魔数与中文要分开拼
    let raw: Vec<u8> = [b"\x89PNG\r\n\x1a\n".as_slice(), "假装是图".as_bytes()].concat();
    std::fs::write(staged.join(&name), &raw).unwrap();

    let (landed, deduped) = adopt_assets(&staged, &images).unwrap();
    assert_eq!((landed, deduped), (1, 0));
    assert_eq!(std::fs::read(images.join(&name)).unwrap(), raw);
    let _ = std::fs::remove_dir_all(&dir);
}

/// 🔴 只落盘「`<32位hex>.<扩展名>`」形状的文件。
///
/// 这不是一条安全校验（名字已经过了 `safe_rel`，穿越不了），
/// 而是「不可能有用的东西不要落盘」：`to_local()` 只会产出
/// `file:///{images}/{32hex}.{ext}` 这一种引用，其它形状的文件
/// **永远不会被任何笔记引用到**，只会占着磁盘。
#[test]
fn test_只落盘形状对的附件名() {
    let dir = std::env::temp_dir().join(format!("pp_attach_shape_{}", std::process::id()));
    let staged = dir.join(ASSETS_DIR);
    let images = dir.join("images");
    std::fs::create_dir_all(&staged).unwrap();

    let good = format!("{}.png", HASH);
    std::fs::write(staged.join(&good), "真附件".as_bytes()).unwrap();

    // ❗ 大小写变体必须用**不同的 hash**：Windows 文件名大小写不敏感，
    //   拿同一个 hash 的话 `xxx.PNG` 与 `xxx.png` 会落成**同一个文件**，
    //   把上面那个真附件的内容覆成「垃圾」，测试就假绿了。
    const H_EXT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const H_HASH: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    // 全部应该被挡下
    let bad = [
        "evil.exe".to_string(),
        "README.md".to_string(),
        format!("{}.PNG", H_EXT),           // 大写扩展名：扫描侧已统一转小写，不可能出现
        format!("{}.png", H_HASH.to_uppercase()), // 大写 hash，同上
        format!("{}.png", &HASH[..30]),     // hash 短了
        format!("{}x.png", HASH),           // hash 长了
        format!("{}.png.exe", HASH),        // 双扩展名
        format!("{}.toolongext", HASH),     // 扩展名超长
        HASH.to_string(),                   // 没扩展名
    ];
    for b in &bad {
        std::fs::write(staged.join(b), "垃圾".as_bytes()).unwrap();
    }

    let (landed, deduped) = adopt_assets(&staged, &images).unwrap();
    assert_eq!((landed, deduped), (1, 0), "只该落盘那一个真附件");
    assert!(images.join(&good).is_file());
    for b in &bad {
        assert!(
            !images.join(b).exists(),
            "形状不对的文件被落盘了：{}",
            b
        );
    }

    let _ = std::fs::remove_dir_all(&dir);
}

// ===== 引擎层端到端（不联网）=====

use crate::data_store::DataStore;
use crate::sync::engine::{apply_delta, compute_delta, write_delta};

/// 两台机器，各自一个落盘库 + 一个 images 目录。
///
/// 🔴 必须用**落盘库**，不能用 `:memory:`：`images_dir()` 是从库文件路径
/// 推出来的，内存库返 `None`，于是 W1 的导出与导入两条通路会被整段跳过——
/// `sync::tests` 里那批用内存库的引擎测试，一条都盖不到这里。
struct Pair {
    root: std::path::PathBuf,
    a: DataStore,
    b: DataStore,
    a_images: std::path::PathBuf,
    b_images: std::path::PathBuf,
}

fn pair(tag: &str) -> Pair {
    let root = std::env::temp_dir().join(format!("pp_w1_{}_{}", tag, uuid::Uuid::new_v4()));
    let (da, db) = (root.join("A"), root.join("B"));
    let (a_images, b_images) = (da.join("images"), db.join("images"));
    std::fs::create_dir_all(&a_images).unwrap();
    std::fs::create_dir_all(&b_images).unwrap();
    let a = DataStore::new(&da.join("pp.db").to_string_lossy()).unwrap();
    let b = DataStore::new(&db.join("pp.db").to_string_lossy()).unwrap();
    Pair {
        root,
        a,
        b,
        a_images,
        b_images,
    }
}

/// 采集侧写入正文的引用形式（`file:///` + 正斜杠，见 `richContent.ts`）。
fn url_in(images: &Path, name: &str) -> String {
    format!(
        "file:///{}/{}",
        images.to_string_lossy().replace('\\', "/"),
        name
    )
}

fn png_bytes() -> Vec<u8> {
    // 字节串字面量只能装 ASCII，所以魔数与中文分开拼
    [b"\x89PNG\r\n\x1a\n".as_slice(), "假装是一张图".as_bytes()].concat()
}

/// 导出一次到一个新目录。
///
/// ❗ 每次用**新目录**：`apply_delta` 会就地删掉暂存里不该导入的文件，
/// 拿同一个目录重放测的就不是真实行为了（真实情况是下一轮重新导出）。
fn export(p: &Pair, tag: &str) -> std::path::PathBuf {
    let out = p.root.join(tag);
    std::fs::create_dir_all(&out).unwrap();
    let delta = compute_delta(&p.a, 0).unwrap();
    write_delta(&p.a, &delta, &out).unwrap();
    out
}

#[test]
fn test_w1_带图笔记同步后对端能打开这张图() {
    let p = pair("e2e");
    let name = format!("{}.png", HASH);
    let raw = png_bytes();
    std::fs::write(p.a_images.join(&name), &raw).unwrap();

    let n = p
        .a
        .note_create(
            None,
            "带图的",
            &format!(
                "<p>看图</p><img src=\"{}\">",
                url_in(&p.a_images, &name)
            ),
        )
        .unwrap();

    let out = export(&p, "delta1");
    // 导出目录里：md 已便携化，字节在附件目录下
    let staged_md = std::fs::read_to_string(out.join(format!("{}.md", n.id))).unwrap();
    assert!(
        staged_md.contains(&format!("{}{}", PORTABLE_SCHEME, name)),
        "导出的 md 该已便携化：{}",
        staged_md
    );
    assert!(
        !staged_md.contains(&p.a_images.to_string_lossy().replace('\\', "/")),
        "导出的 md 里还残留着 A 的本机路径：{}",
        staged_md
    );
    assert_eq!(
        std::fs::read(out.join(ASSETS_DIR).join(&name)).unwrap(),
        raw,
        "附件字节没搬进导出目录"
    );

    let rep = apply_delta(&p.b, &out, 0).unwrap();
    assert_eq!(rep.created, 1, "对端该新建一篇");
    assert_eq!((rep.assets_landed, rep.assets_deduped), (1, 0));
    assert_eq!(rep.missing_files, 0, "附件清单对不上");

    // ① 字节真的落到了 B 自己的 images
    assert_eq!(std::fs::read(p.b_images.join(&name)).unwrap(), raw);
    // ② B 的正文指向 B 的路径，不是 A 的
    let got = p.b.note_get(&n.id).unwrap().expect("对端该有这一篇");
    assert!(
        got.content.contains(&url_in(&p.b_images, &name)),
        "引用没改成本机路径：{}",
        got.content
    );
    assert!(
        !got.content.contains(PORTABLE_SCHEME),
        "正文里残留了便携引用（前端渲染不了）：{}",
        got.content
    );

    let _ = std::fs::remove_dir_all(&p.root);
}

/// 🔴 这条钉的是 `apply_delta` 里那个**顺序**不变式：
/// 附件落盘 + 引用改写必须在逐篇循环**之前**跑完。
///
/// 若把改写挪进循环（或干脆不改写），暂存文件里留着 `pp-asset:`，
/// 而本地笔记存的是绝对路径 → 回声拦截（`identical`）永远不成立 →
/// 重放同一批增量时每篇都满足「两边都改过」→ **每轮再生一批冲突副本**。
/// 与 `705d6af` 修掉的是同一类事，只是换了个门进来。
#[test]
fn test_w1_同一批增量重放不生冲突副本() {
    let p = pair("echo");
    let name = format!("{}.png", HASH);
    std::fs::write(p.a_images.join(&name), png_bytes()).unwrap();
    p.a.note_create(
        None,
        "带图的",
        &format!("<img src=\"{}\">", url_in(&p.a_images, &name)),
    )
    .unwrap();

    let first = apply_delta(&p.b, &export(&p, "delta1"), 0).unwrap();
    assert_eq!(first.created, 1);

    // 第二轮：A 什么都没改，从同一个游标又发了一遍
    let again = apply_delta(&p.b, &export(&p, "delta2"), 0).unwrap();
    assert_eq!(again.identical, 1, "回声没被拦下来 —— 顺序不变式破了");
    assert_eq!(again.conflicts, 0, "重放同一批增量却生了冲突副本");
    assert_eq!(again.created + again.updated, 0, "回声不应再写库");
    // 同名即同内容，第二遍该计入去重而不是重新落盘
    assert_eq!((again.assets_landed, again.assets_deduped), (0, 1));

    let _ = std::fs::remove_dir_all(&p.root);
}
