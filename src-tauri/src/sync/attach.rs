//! 同步时的附件（图片）搬运与引用改写（W1，2026-09-07）。
//!
//! # 要补的那个洞
//!
//! 改之前同步清单**只搬 markdown**，而图片是内容寻址落在
//! `<app_data>/images/<md5>.<ext>`。于是带图的笔记同步过去是一段文字
//! 加一个断掉的图片引用——而且是**静默**的，用户会当成丢了数据。
//!
//! # 🔴 为何光搬字节不够
//!
//! 正文里存的是**绝对路径**：
//! `file:///C:/Users/19145/AppData/Roaming/com.pastepanda.app/images/<md5>.png`
//! （`src/lib/richContent.ts` 的 `pathToFileUrl`）。里面带着 **Windows 用户名**，
//! 对面那台路径不一样——字节搬过去了图也仍然是断的。
//! 所以必须同时做两件事：搬字节 + 引用便携化。
//!
//! # 便携形式为何用 `pp-asset:` 而不是相对路径
//!
//! 笔记在 vault 里按文件夹层级散在不同深度的子目录（`sync_folder_dir_map`），
//! 用相对路径就得按每篇的深度拼 `../`，多一层少一层都是错。
//! `pp-asset:<hash>.<ext>` 与深度无关，而且一眼就能认出来。
//!
//! ❗ 它**永远不会进数据库**：导入前已经在暂存目录里改写回本机绝对路径。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

/// 附件子目录名。
///
/// 🔴 **必须带前导点**：`note_import_dir` 的 `collect_md`（`note_vault.rs`）
/// 会跳过所有以 `.` 开头的目录。不带点的话它会被当成一个**笔记文件夹**，
/// 对端库里就会凭空多出一个叫 `images` 的文件夹。
pub const ASSETS_DIR: &str = ".pp-sync-assets";

/// 附件清单文件名。同样带前导点。
pub const ASSETS_MANIFEST: &str = ".pp-sync-assets-manifest";

/// 单个附件上限（字节）。2026-09-07 拍板 10MB。
///
/// 超过就不搬，但**进报告**（规则 #15.3）——静默跳过等于又造一个
/// 「图自己没了」的悬案。
pub const MAX_ASSET_BYTES: u64 = 10 * 1024 * 1024;

/// 便携引用的前缀。
pub const PORTABLE_SCHEME: &str = "pp-asset:";

/// 本机图片引用。
///
/// 匹配的是**尾部特征**而不是完整前缀：`…/images/<32位十六进制>.<短扩展名>`。
///
/// 🔴 为何不去匹配 `file:///<app_data>/images/`全路径：正文有两种形态
/// （富文本 HTML 的 `src="file:///…"` 与 markdown 的 `![](…)`），
/// 而且历史数据里斜杠方向、盘符大小写、有无 `file:///` 前缀都可能不一致。
/// 而「32 位 hex + 位于 images 目录下 + 短扩展名」这三个条件叠起来已经很窄，
/// 误伤普通文本的概率极低。
///
/// ❗ “只改写能认出的”是有意的保守：http(s) 引用、不在 images 目录下的
/// 本地路径、长得像但不是图的东西，一律不动。改写函数弄坏正文
/// 是这一项最大的风险面。
static LOCAL_REF_RE: LazyLock<Regex> = LazyLock::new(|| {
    // ❗ 用 `r#"…"#` 而不是 `r"…"`：字类里要排除双引号（HTML 的 src="…" 边界），
    //   而普通 raw 字符串里的 `\"` 不是转义，那个引号会直接把字符串截断。
    //
    // 🔴 `\b` 不是装饰，它堵住两个已经发生过的 bug：
    //   没它的时候，「盘符」`[A-Za-z]:[/\\]` 会拿 **scheme 的最后一个字母**当盘符：
    //   ① `https://host/images/<hash>.png` 里的 `s:/` → 远程图被错改写；
    //   ② `file:///C:/…` 里的 `e:/` → 从第 4 个字符起匹配，改写后留下
    //      `filpp-asset:…`，回程变成 `filfile:///…` —— 回环不再逐字相同，
    //      于是 `apply_delta` 的回声拦截永远比不相等，每轮再生一批冲突副本。
    //   加上 `\b` 后，`e`/`s` 前面都是字母（无边界），两条路一起堵死；
    //   而 `file:///` 后面的 `C` 前面是 `/`，边界成立，正常路径不受影响。
    Regex::new(
        r#"(?i)(?:file:/{2,3})?\b[A-Za-z]:[/\\][^\s"'()<>]*?[/\\]images[/\\]([0-9a-f]{32})\.([a-z0-9]{1,5})"#,
    )
    .expect("图片引用正则写错了")
});

/// 便携引用（`pp-asset:<hash>.<ext>`）。
static PORTABLE_REF_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)pp-asset:([0-9a-f]{32})\.([a-z0-9]{1,5})").expect("便携引用正则写错了")
});

/// 一个附件的身份。`hash` 就是内容 md5，所以跳机去重是天然的。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct AssetRef {
    pub hash: String,
    pub ext: String,
}

impl AssetRef {
    /// `<hash>.<ext>`——在附件目录里的文件名，也是在本机 images 目录里的文件名。
    pub fn file_name(&self) -> String {
        format!("{}.{}", self.hash, self.ext)
    }
}

/// 扫出正文里引用到的本机图片（已去重、有序）。
///
/// 用 `BTreeMap` 而不是 `Vec`：同一张图被一篇笔记引用多次很常见，
/// 而且有序输出让清单可重现（测试好写）。
pub fn scan_local_refs(content: &str) -> Vec<AssetRef> {
    let mut set: BTreeMap<String, AssetRef> = BTreeMap::new();
    for c in LOCAL_REF_RE.captures_iter(content) {
        let hash = c[1].to_ascii_lowercase();
        let ext = c[2].to_ascii_lowercase();
        set.insert(hash.clone(), AssetRef { hash, ext });
    }
    set.into_values().collect()
}

/// 扫出正文里的便携引用（已去重、有序）。
pub fn scan_portable_refs(content: &str) -> Vec<AssetRef> {
    let mut set: BTreeMap<String, AssetRef> = BTreeMap::new();
    for c in PORTABLE_REF_RE.captures_iter(content) {
        let hash = c[1].to_ascii_lowercase();
        let ext = c[2].to_ascii_lowercase();
        set.insert(hash.clone(), AssetRef { hash, ext });
    }
    set.into_values().collect()
}

/// 本机绝对路径 → 便携引用。导出时用。
pub fn to_portable(content: &str) -> String {
    LOCAL_REF_RE
        .replace_all(content, format!("{}$1.$2", PORTABLE_SCHEME).as_str())
        .into_owned()
}

/// 便携引用 → 本机绝对路径。导入前在暂存目录里用。
///
/// ❗ 路径形式必须与采集侧写入的一致（`file:///` + 正斜杠），
/// 否则前端的 `fileUrlToPath` 解不出来，图还是不显。
/// 参见 `src/lib/richContent.ts` 的 `pathToFileUrl`。
pub fn to_local(content: &str, images_dir: &Path) -> String {
    let base = images_dir.to_string_lossy().replace('\\', "/");
    let base = base.trim_end_matches('/').to_string();
    PORTABLE_REF_RE
        .replace_all(content, format!("file:///{}/$1.$2", base).as_str())
        .into_owned()
}

/// 把一张附件从本机 images 目录复制进导出目录。
///
/// 返回：`Ok(Some(size))` 已搬；`Ok(None)` 跳过（源文件不在或超限）。
///
/// ❗ 源文件不在不算错：用户可能手动清过 images 目录，而那不该让整次同步失败。
/// 但要让调用方能区分「搬了」与「跳了」，所以不用 `()`。
pub fn stage_asset(
    images_dir: &Path,
    out_assets: &Path,
    a: &AssetRef,
) -> Result<Option<u64>, String> {
    let src = images_dir.join(a.file_name());
    let meta = match std::fs::metadata(&src) {
        Ok(m) => m,
        Err(_) => return Ok(None), // 源图不在（被手动删过）
    };
    if meta.len() > MAX_ASSET_BYTES {
        return Ok(None);
    }
    std::fs::create_dir_all(out_assets).map_err(|e| format!("建附件目录失败: {e}"))?;
    let dst = out_assets.join(a.file_name());
    // 已经在暂存里了就不重复拷（多篇引用同一张图）。
    if dst.exists() {
        return Ok(Some(meta.len()));
    }
    std::fs::copy(&src, &dst).map_err(|e| format!("拷附件失败 {}: {e}", a.file_name()))?;
    Ok(Some(meta.len()))
}

/// 把暂存目录里的附件落到本机 images 目录。
///
/// 🔴 **同 hash 即同内容**（文件名就是内容 md5），所以已存在就直接跳过——
/// 这既是去重，也避开了「覆写一个正在被读的图」。
///
/// 返回（落盘数, 跳过数）。
pub fn adopt_assets(staged_assets: &Path, images_dir: &Path) -> Result<(usize, usize), String> {
    if !staged_assets.is_dir() {
        return Ok((0, 0));
    }
    std::fs::create_dir_all(images_dir).map_err(|e| format!("建图片目录失败: {e}"))?;
    let mut landed = 0usize;
    let mut skipped = 0usize;
    for entry in std::fs::read_dir(staged_assets)
        .map_err(|e| format!("读附件目录失败: {e}"))?
        .flatten()
    {
        let src = entry.path();
        if !src.is_file() {
            continue;
        }
        let name = entry.file_name();
        let dst = images_dir.join(&name);
        if dst.exists() {
            skipped += 1;
            continue;
        }
        // 先写临时再原子 rename，同 `commands/images.rs` 的落盘做法：
        // 写一半崩掉不该在 images 目录里留下一张残缺的图（而它的名字
        // 又是内容 hash，下次会被当成“已有”直接跳过——永久坏图）。
        let tmp = crate::atomic_write::unique_tmp_path(&dst);
        std::fs::copy(&src, &tmp).map_err(|e| format!("落附件失败 {:?}: {e}", name))?;
        crate::atomic_write::finish_rename(&tmp, &dst)
            .map_err(|e| format!("附件改名失败 {:?}: {e}", name))?;
        landed += 1;
    }
    Ok((landed, skipped))
}

/// 本机 images 目录（`<app_data>/images`）。
///
/// ❗ 与 `commands/images.rs` 的落盘位置必须一致，不然搬过来的图放错地方。
pub fn images_dir_of(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("images")
}
