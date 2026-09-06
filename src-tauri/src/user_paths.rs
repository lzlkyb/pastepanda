//! 用户主目录相关的路径解析。
//!
//! 收在这里而不是各处再抄一遍：`commands/profile.rs` 里已经有两份一模一样的
//! `USERPROFILE / HOME` 查找（装技能包的两个命令各一份），一键接入是第三处（规则 #11）。

use std::path::{Path, PathBuf};

/// 用户主目录。
///
/// Windows 上是 `USERPROFILE`，回落到 `HOME`（Git Bash / WSL / 非 Windows 下才有）。
/// 两个都没有就报错而不是猜一个默认值——猜错的后果是往一个莫名其妙的地方写文件。
pub fn home_dir() -> Result<PathBuf, String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .map_err(|_| "无法定位用户主目录（USERPROFILE / HOME 均未设置）".to_string())
}

/// 把 `~/xxx` 展开成绝对路径；不以 `~/` 开头的原样返回。
///
/// ❗ 只认 `~/` 前缀，**不认单独一个 `~`，也不认 `~someuser`**。
/// 后者是 POSIX shell 的写法，Windows 上没有对应语义，装作支持只会解析出错路径。
pub fn expand_home(p: &str) -> Result<PathBuf, String> {
    // `~\` 也放行：注册表里写的是 `~/`，但用户手填自定义路径时很可能按 Windows 习惯敲反斜杠。
    let rest = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\"));
    match rest {
        Some(rest) => Ok(home_dir()?.join(rest)),
        None => Ok(Path::new(p).to_path_buf()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 非波浪号路径原样返回() {
        let p = expand_home("D:\\a\\b.json").unwrap();
        assert_eq!(p, PathBuf::from("D:\\a\\b.json"));
    }

    #[test]
    fn 波浪号展开到主目录下() {
        let home = home_dir().unwrap();
        assert_eq!(expand_home("~/.claude.json").unwrap(), home.join(".claude.json"));
        // 反斜杠写法要等价，否则用户手填 `~\.claude.json` 会被当成相对路径落到工作目录
        assert_eq!(expand_home("~\\.claude.json").unwrap(), home.join(".claude.json"));
    }

    #[test]
    fn 光秃秃的波浪号不当主目录展开() {
        // `~user` 是 POSIX 写法，Windows 无对应语义；装作支持只会解析出错路径
        assert_eq!(expand_home("~admin/x").unwrap(), PathBuf::from("~admin/x"));
    }
}
