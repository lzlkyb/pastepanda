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
    let cert_chain_pem =
        std::fs::read_to_string(cert_path(app_dir)).map_err(|e| format!("读不了证书：{}", e))?;
    let cipher = std::fs::read(key_path(app_dir)).map_err(|e| format!("读不了私钥：{}", e))?;
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

// ─── 系统信任库（TLS-1，certutil -user）───
//
// 走「当前用户」信任库，不需要管理员。装/卸都是用户可见的一次性动作，
// 子进程开销可忽略；系统还会弹原生确认框，比我们自己画一个更可信。

/// 我们 CA 的 CN。卸载时按它定位——同名不可能，名字里带了「仅本机」约束。
const CA_CN: &str = "PastePanda Local CA (127.0.0.1 only)";

/// CA 是否已生成 + 是否已装进当前用户信任库。
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CaStatus {
    /// `mcp-tls-ca.pem` 等三个文件在不在（`exists()`）。
    pub generated: bool,
    /// 当前用户信任库里有没有我们的 CA。
    pub installed: bool,
    /// 证书文件路径，装/卸时确认框要显示；未生成时为空串。
    pub ca_path: String,
    /// 装进信任库后的 SHA1（hex，无分隔）；未装时为空串。
    pub thumbprint: String,
}

fn run_certutil(args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("certutil")
        .args(args)
        .output()
        .map_err(|e| format!("调用 certutil 失败：{}", e))?;
    // certutil 成功时 exit=0，失败时 stdout/stderr 里有原因。
    // 两边都拼上：有的错误只进 stdout，有的只进 stderr。
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if !out.status.success() {
        let msg = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else {
            stdout.trim().to_string()
        };
        return Err(format!("certutil 失败：{}", msg));
    }
    Ok(format!("{}{}", stdout, stderr))
}

/// 从 `certutil -user -store Root` 的输出里找出我们的 CA，返回 SHA1。
///
/// 🔴 **不依赖英文字段名**：中文 Windows 上 certutil 输出「使用者:」「证书哈希(sha1):」，
///   不是 `Subject:` / `Cert Hash(sha1):`。`from_utf8_lossy` 也救不了——那会把 GBK
///   字节变成 U+FFFD，但 **ASCII 部分（我们的 CN、十六进制哈希）原样活着**。
///   所以策略是：任何一行含我们的 CN → 进入「本张证书」态；后续行里抓 40 位 hex。
fn find_our_ca_in_store(dump: &str) -> Option<String> {
    let mut current_is_ours = false;
    for line in dump.lines() {
        let t = line.trim();
        // 分隔线。中英文都长这样：`==== ... ====`；不要求里面出现 "Certificate"。
        if t.starts_with("====") {
            current_is_ours = false;
            continue;
        }
        // 我们的 CN 是纯 ASCII，编码乱码不影响匹配。
        if t.contains(CA_CN) {
            current_is_ours = true;
            continue;
        }
        if current_is_ours {
            // SHA1 是 40 位十六进制。允许空格/冒号分隔（`certutil` 有时会这么打）。
            let compact: String = t.chars().filter(|c| c.is_ascii_hexdigit()).collect();
            if compact.len() >= 40 {
                // 取最后 40 位：前面可能粘着「证书哈希」的乱码字节被当成 hex 的情况极少，
                // 但取尾部比取头部稳（真正的 hash 一定在行尾）。
                return Some(compact[compact.len() - 40..].to_uppercase());
            }
        }
    }
    None
}

/// 查当前状态。**不生成证书**——生成是打开 HTTPS 开关时的事。
pub fn ca_status(app_dir: &Path) -> CaStatus {
    let generated = exists(app_dir);
    let ca_file_path = ca_path(app_dir);
    let ca_path_str = if ca_file_path.exists() {
        ca_file_path.display().to_string()
    } else {
        String::new()
    };
    let (installed, thumbprint) = match run_certutil(&["-user", "-store", "Root"]) {
        Ok(dump) => match find_our_ca_in_store(&dump) {
            Some(h) => (true, h),
            None => (false, String::new()),
        },
        Err(e) => {
            // 查不到不等于没装：certutil 本身可能坏了。
            // 这里只记日志，状态按「未装」返回——界面还能手动装一次，装失败会给出真实原因。
            log::warn!("[MCP] 查询信任库失败：{}", e);
            (false, String::new())
        }
    };
    CaStatus {
        generated,
        installed,
        ca_path: ca_path_str,
        thumbprint,
    }
}

/// 把 CA 装进**当前用户**的信任根证书库。
///
/// 必须先有证书文件。`certutil` 会弹系统确认框——那比我们自己画一个更可信，
/// 且用户已经习惯对它做判断。
pub fn install_ca(app_dir: &Path) -> Result<CaStatus, String> {
    if !exists(app_dir) {
        return Err("本机还没有 HTTPS 证书，请先打开 HTTPS 开关".to_string());
    }
    let path = ca_path(app_dir);
    run_certutil(&["-user", "-addstore", "Root", &path.display().to_string()])?;
    log::info!("[MCP] CA 已装入当前用户信任库：{}", path.display());
    Ok(ca_status(app_dir))
}

/// 从**当前用户**的信任根证书库移除我们的 CA。
///
/// 按 SHA1 精确定位，不怕同名。没装就直接返回当前状态（幂等），
/// 不报「找不到」——用户点「移除」时可能已经卸过了。
pub fn remove_ca(app_dir: &Path) -> Result<CaStatus, String> {
    let dump = run_certutil(&["-user", "-store", "Root"])?;
    let Some(hash) = find_our_ca_in_store(&dump) else {
        return Ok(ca_status(app_dir));
    };
    run_certutil(&["-user", "-delstore", "Root", &hash])?;
    log::info!("[MCP] CA 已从当前用户信任库移除：{}", hash);
    Ok(ca_status(app_dir))
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
    ca_params
        .distinguished_name
        .push(DnType::CommonName, "PastePanda Local CA (127.0.0.1 only)");
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

/// 拿生成好的材料建一份 TLS 配置。**同步**。
///
/// ❗ 不用 axum-server 自带的 `RustlsConfig::from_pem`：那是 async 的，
///   而 `McpServer::start` 必须是同步函数——只有同步才能把「端口被占」
///   当场变成返回值里的错误（见 `server.rs` 里那段注释）。
///   在同步上下文里 `block_on` 一个可能已在运行时线程上的调用是自找麻烦。
///
/// ALPN 跟 axum-server 自己那条路保持一致（h2 + http/1.1），
/// 免得两条路建出来的服务器行为不一样。
pub fn tls_config(m: &TlsMaterial) -> Result<axum_server::tls_rustls::RustlsConfig, String> {
    use rustls::pki_types::pem::PemObject;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};

    ensure_crypto_provider();
    let certs: Vec<CertificateDer<'static>> =
        CertificateDer::pem_slice_iter(m.cert_chain_pem.as_bytes())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("证书解析失败：{}", e))?;
    let key = PrivateKeyDer::from_pem_slice(m.key_pem.as_bytes())
        .map_err(|e| format!("私钥解析失败：{}", e))?;
    let mut cfg = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("证书与私钥对不上：{}", e))?;
    cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(axum_server::tls_rustls::RustlsConfig::from_config(
        std::sync::Arc::new(cfg),
    ))
}

#[cfg(test)]
mod tests {
    // 测试名有意用中文（守卫/回归钉的业务语义直接写在名字里）。
    #![allow(non_snake_case)]

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
        assert_eq!(
            chain.matches("BEGIN CERTIFICATE").count(),
            2,
            "证书链应该是叶+CA"
        );

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
        // 走的就是服务启动时的那条路（同步的 `tls_config`）。
        let cfg = tls_config(&m);
        assert!(cfg.is_ok(), "证书跟私钥对不上：{:?}", cfg.err());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 解析 certutil 输出。真实格式的片段，不是自己编的理想化文本。
    #[test]
    fn 能从certutil输出里解析出我们的CA() {
        let dump = r#"
================ Certificate 0 ================
Serial Number: 1111111111111111
Issuer: CN=Some Other CA
 NotBefore: 2024/1/1 0:00
 NotAfter: 2034/1/1 0:00
Subject: CN=Some Other CA
Cert Hash(sha1): aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111
================ Certificate 1 ================
Serial Number: 2222222222222222
Issuer: CN=PastePanda Local CA (127.0.0.1 only)
Subject: CN=PastePanda Local CA (127.0.0.1 only)
Cert Hash(sha1): bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222
================ Certificate 2 ================
Serial Number: 3333333333333333
Subject: CN=Yet Another
Cert Hash(sha1): cccc3333cccc3333cccc3333cccc3333cccc3333
"#;
        let hash = find_our_ca_in_store(dump);
        assert_eq!(
            hash.as_deref(),
            Some("BBBB2222BBBB2222BBBB2222BBBB2222BBBB2222"),
            "应该拿到我们那张的 SHA1，且大写"
        );
    }

    #[test]
    fn 信任库里没有我们的CA时返回None() {
        let dump = r#"
================ Certificate 0 ================
Subject: CN=Unrelated Root
Cert Hash(sha1): deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
"#;
        assert!(find_our_ca_in_store(dump).is_none());
    }

    /// 🔴 中文 Windows 的 certutil 输出「使用者:」「证书哈希(sha1):」，
    ///   不是英文的 `Subject:` / `Cert Hash(sha1):`。这条守的是那次真机踩坑。
    #[test]
    fn 中文certutil输出也能解析() {
        let dump = r#"
Root "受信任的根证书颁发机构"
================ 证书 0 ================
序列号: 26852d425e6be778ba78e9a791f79d68f6ecaec6
颁发者: CN=PastePanda Local CA (127.0.0.1 only)
 NotBefore: 2026/1/1 8:00
 NotAfter: 2036/1/1 8:00
使用者: CN=PastePanda Local CA (127.0.0.1 only)
签名匹配公钥
根证书: 使用者与颁发者匹配
证书哈希(sha1): a46eabd860a41a09b7d9a0e9212d5129c646782a
"#;
        let hash = find_our_ca_in_store(dump);
        assert_eq!(
            hash.as_deref(),
            Some("A46EABD860A41A09B7D9A0E9212D5129C646782A"),
            "中文 certutil 输出应能解析出 SHA1"
        );
    }
}
