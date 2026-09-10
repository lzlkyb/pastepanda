//! MCP 的 HTTPS 证书。**默认关闭，由用户手动打开。**
//!
//! # 先说清楚它不解决什么
//!
//! 回环地址上的 HTTPS 几乎不产生安全收益：流量从没离开过这台机器，
//! 而威胁是同机的其他进程——它们照样连得上 `127.0.0.1`，需要的是令牌，
//! 而令牌本来就是那道门（见 `auth.rs`）。
//!
//! 这个模块存在只为一件事：**有些客户端或安全扫描不收明文 http**。
//! 所以 http 监听始终保留，https 是并存的第二条路，不替换第一条。
//!
//! # 🔴 CA 私钥用完即弃
//!
//! 往用户的信任库里装一个根证书，是本软件对用户机器做过的最重的一件事：
//! 那把 CA 私钥一旦泄露，任何人都能对这个用户做中间人——
//! **对所有网站，不只是我们**。
//!
//! 所以这里的 CA 私钥只在内存里活到签完那一张叶证书为止，**从不落盘**。
//! 落盘的只有三样：CA 证书（公开信息）、叶证书（公开信息）、
//! 叶私钥（DPAPI 加密，跟 MCP 令牌同一套）。
//!
//! 代价是**不能续签**：证书过期或要重置时只能整套重生成、让用户重装一次 CA。
//! 这个代价换掉的是「一把能冒充任意网站的私钥长期躺在用户磁盘上」，值。
//!
//! 另一道限制：叶证书的 SAN 只有 `127.0.0.1` / `localhost` / `::1`。
//! 就算 CA 私钥真泄了，那张已签发的叶证书本身也只能冒充回环。

use std::path::{Path, PathBuf};

use rcgen::{
    date_time_ymd, BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa,
    Issuer, KeyPair, KeyUsagePurpose,
};

/// DPAPI 的额外熵。跟令牌那份刻意不同：一个文件的密文拿到另一个地方也解不开。
const ENTROPY: &[u8] = b"pastepanda-mcp-tls-v1";

/// 证书有效期（年）。私有根不受公共 CA 那套 398 天上限约束；
/// 但也不用 rcgen 默认的 4096 年——一张两千年的证书只会让人觉得这东西不靠谱。
const VALID_YEARS: i32 = 10;

/// 一套可以直接交给 TLS 监听的材料。**只在内存里传，不过前端。**
pub struct TlsMaterial {
    /// 叶证书 + CA 证书（拼在一起的 PEM 链）。
    pub cert_chain_pem: String,
    /// 叶私钥 PEM。
    pub key_pem: String,
}

fn ca_path(app_dir: &Path) -> PathBuf {
    app_dir.join("mcp-tls-ca.pem")
}

fn cert_path(app_dir: &Path) -> PathBuf {
    app_dir.join("mcp-tls-cert.pem")
}

fn key_path(app_dir: &Path) -> PathBuf {
    app_dir.join("mcp-tls-key.bin")
}

/// CA 证书文件的路径。装信任库时要把它交给系统，界面上也要原样显示出来。
pub fn ca_file(app_dir: &Path) -> PathBuf {
    ca_path(app_dir)
}

/// 这台机器上已经生成过一套了吗。
pub fn exists(app_dir: &Path) -> bool {
    ca_path(app_dir).exists() && cert_path(app_dir).exists() && key_path(app_dir).exists()
}

/// 把三个文件都删掉。下次 [`ensure`] 会重生成一套全新的。
///
/// ❗ 用户那边已经装进信任库的旧 CA **不会**因为这个操作消失，
///   调用方得自己先把旧的从信任库里移除，否则会在那里积一堆废根证书。
pub fn reset(app_dir: &Path) -> Result<(), String> {
    for p in [ca_path(app_dir), cert_path(app_dir), key_path(app_dir)] {
        if p.exists() {
            std::fs::remove_file(&p).map_err(|e| format!("删不掉 {}：{}", p.display(), e))?;
        }
    }
    Ok(())
}

/// 读现有的；没有就生成一套。
pub fn ensure(app_dir: &Path) -> Result<TlsMaterial, String> {
    if exists(app_dir) {
        match load(app_dir) {
            Ok(m) => return Ok(m),
            // 读不动（比如换了 Windows 用户导致 DPAPI 解不开）就重生成。
            // 不能在这里直接报错：那会让 HTTPS 永远启不了，而用户无从下手。
            Err(e) => log::warn!("[MCP] 旧的 TLS 材料读不动，重新生成：{}", e),
        }
    }
    generate(app_dir)
}

fn load(app_dir: &Path) -> Result<TlsMaterial, String> {
    let cert_chain_pem = std::fs::read_to_string(cert_path(app_dir))
        .map_err(|e| format!("读不了证书：{}", e))?;
    let cipher =
        std::fs::read(key_path(app_dir)).map_err(|e| format!("读不了私钥：{}", e))?;
    let plain = crate::dpapi::unprotect(&cipher, ENTROPY)?;
    let key_pem = String::from_utf8(plain).map_err(|_| "私钥不是合法文本".to_string())?;
    Ok(TlsMaterial {
        cert_chain_pem,
        key_pem,
    })
}

/// 证书从哪一年的 1 月 1 日算起。
///
/// ❗ 返回年份而不是直接返回两个时间点：那两个点是 `time::OffsetDateTime`，
///   而 `time` 只是 rcgen 的传递依赖——为了写一个返回类型而把它声明成直接依赖
///   不划算。用今年 1 月 1 日做起点还顺带容下了客户端时钟偏快的情况。
fn base_year() -> i32 {
    chrono::Local::now()
        .format("%Y")
        .to_string()
        .parse()
        .unwrap_or(2026)
}

fn generate(app_dir: &Path) -> Result<TlsMaterial, String> {
    let year = base_year();
    let not_before = date_time_ymd(year, 1, 1);
    let not_after = date_time_ymd(year + VALID_YEARS, 1, 1);

    // ---- CA（私钥只在这个函数里活着）----
    let ca_key = KeyPair::generate().map_err(|e| format!("生成 CA 密钥失败：{}", e))?;
    let mut ca_params = CertificateParams::new(Vec::<String>::new())
        .map_err(|e| format!("构造 CA 参数失败：{}", e))?;
    // pathlen 0：它能签叶证书，但签不了下级 CA。
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    ca_params.not_before = not_before;
    ca_params.not_after = not_after;
    ca_params.distinguished_name.push(
        DnType::CommonName,
        "PastePanda Local CA (127.0.0.1 only)",
    );
    let ca_cert = ca_params
        .self_signed(&ca_key)
        .map_err(|e| format!("签发 CA 证书失败：{}", e))?;

    // ---- 叶证书：SAN 只有回环 ----
    let leaf_key = KeyPair::generate().map_err(|e| format!("生成服务密钥失败：{}", e))?;
    let mut leaf_params = CertificateParams::new(vec![
        "127.0.0.1".to_string(),
        "localhost".to_string(),
        "::1".to_string(),
    ])
    .map_err(|e| format!("构造证书参数失败：{}", e))?;
    leaf_params.not_before = not_before;
    leaf_params.not_after = not_after;
    leaf_params.use_authority_key_identifier_extension = true;
    leaf_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    leaf_params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyEncipherment,
    ];
    leaf_params
        .distinguished_name
        .push(DnType::CommonName, "PastePanda MCP");

    let issuer = Issuer::from_params(&ca_params, &ca_key);
    let leaf_cert = leaf_params
        .signed_by(&leaf_key, &issuer)
        .map_err(|e| format!("签发服务证书失败：{}", e))?;

    // 🔴 到这里 CA 私钥的使命就结束了。下面只写三样东西，
    //    `ca_key` 会随本函数作用域析构——它从未、也永远不会落盘。
    let ca_pem = ca_cert.pem();
    let cert_chain_pem = format!("{}{}", leaf_cert.pem(), ca_pem);
    let key_pem = leaf_key.serialize_pem();

    std::fs::create_dir_all(app_dir)
        .map_err(|e| format!("创建目录 {} 失败：{}", app_dir.display(), e))?;
    std::fs::write(ca_path(app_dir), &ca_pem).map_err(|e| format!("写 CA 证书失败：{}", e))?;
    std::fs::write(cert_path(app_dir), &cert_chain_pem)
        .map_err(|e| format!("写证书失败：{}", e))?;
    let cipher = crate::dpapi::protect(key_pem.as_bytes(), ENTROPY)?;
    std::fs::write(key_path(app_dir), &cipher).map_err(|e| format!("写私钥失败：{}", e))?;

    log::info!("[MCP] 已生成本机 HTTPS 证书（仅 127.0.0.1 / localhost）");
    Ok(TlsMaterial {
        cert_chain_pem,
        key_pem,
    })
}

/// 装 rustls 的 crypto provider。
///
/// ❗ axum-server 选的是 `tls-rustls-no-provider`，而 rustls 0.23 不再自己选一个——
///   不装就会在建 TLS 配置时挂。重复调用是安全的：既然有人装过了（比如
///   reqwest 或 iroh），这里拿到 Err 就忽略。
pub fn ensure_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pp_tls_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn 生成后三个文件都在且可重复读() {
        let d = temp_dir("basic");
        assert!(!exists(&d));
        let a = ensure(&d).unwrap();
        assert!(exists(&d));
        // 第二次要读回同一套，不能每次重生成——否则用户装进信任库的 CA 马上就失效了。
        let b = ensure(&d).unwrap();
        assert_eq!(a.cert_chain_pem, b.cert_chain_pem);
        assert_eq!(a.key_pem, b.key_pem);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 🔴 这一条守的是整个模块最要紧的一个决定：**CA 私钥从不落盘**。
    /// 它泄露等于任何人都能对这个用户冒充**任意网站**。
    #[test]
    fn 磁盘上不能有明文私钥() {
        let d = temp_dir("nokey");
        ensure(&d).unwrap();

        // CA 文件里只能有证书，不能有任何私钥
        let ca = std::fs::read_to_string(ca_path(&d)).unwrap();
        assert!(ca.contains("BEGIN CERTIFICATE"));
        assert!(!ca.contains("PRIVATE KEY"), "CA 文件里竟然有私钥");

        // 证书链同理
        let chain = std::fs::read_to_string(cert_path(&d)).unwrap();
        assert!(!chain.contains("PRIVATE KEY"), "证书链里竟然有私钥");
        // 叶 + CA 两段
        assert_eq!(chain.matches("BEGIN CERTIFICATE").count(), 2, "证书链应该是叶+CA");

        // 叶私钥文件必须是 DPAPI 密文，不是明文 PEM
        let key_raw = std::fs::read(key_path(&d)).unwrap();
        let as_text = String::from_utf8_lossy(&key_raw);
        assert!(!as_text.contains("PRIVATE KEY"), "私钥是明文落盘的");

        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn 重置后会换一套全新的() {
        let d = temp_dir("reset");
        let a = ensure(&d).unwrap();
        reset(&d).unwrap();
        assert!(!exists(&d));
        let b = ensure(&d).unwrap();
        assert_ne!(a.cert_chain_pem, b.cert_chain_pem, "重置后还是老证书");
        // 幂等：没文件时 reset 不能报错
        reset(&d).unwrap();
        reset(&d).unwrap();
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 证书与私钥对不上的话，https 会在启动那一刻才挂——那时候很难查。
    /// 这里直接拿它们建一遍真的 TLS 配置，把问题提前到构建期。
    #[test]
    fn 生成的材料能真的建起tls配置() {
        let d = temp_dir("tlscfg");
        let m = ensure(&d).unwrap();
        ensure_crypto_provider();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let cfg = rt.block_on(axum_server::tls_rustls::RustlsConfig::from_pem(
            m.cert_chain_pem.into_bytes(),
            m.key_pem.into_bytes(),
        ));
        assert!(cfg.is_ok(), "证书跟私钥对不上：{:?}", cfg.err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
