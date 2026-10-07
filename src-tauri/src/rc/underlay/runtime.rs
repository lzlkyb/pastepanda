use std::{io, path::PathBuf, process::Stdio};
use tokio::process::{Child, Command};

pub(super) struct Runtime {
    children: Vec<Child>,
    dir: PathBuf,
    core: PathBuf,
}

impl Runtime {
    pub async fn new() -> Result<Self, String> {
        let root = super::APP_DIR.get().ok_or("备用承载目录未初始化")?.join("easytier-prototype");
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let core = core_path().await?;
        let dir = root.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
        Ok(Self { children: Vec::new(), dir, core })
    }

    pub fn spawn(&mut self, name: &str, cfg: &str, rpc: u16) -> Result<(), String> {
        let path = self.dir.join(format!("{name}.toml"));
        // 会话密钥不进参数/日志；配置只存在应用私有目录，收尾即删。
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        use std::io::Write;
        options.open(&path).and_then(|mut f| f.write_all(cfg.as_bytes())).map_err(|e| e.to_string())?;
        let mut cmd = command(&self.core);
        let timing = name != "seed";
        cmd.args(["-c"]).arg(path).args(["-r", &format!("127.0.0.1:{rpc}"), "--console-log-level", if timing { "info" } else { "off" }, "--file-log-level", "off"]);
        if timing {
            // Only allowlisted phase labels leave the pipe; native payloads stay out of rc.log.
            cmd.env("RUST_LOG", super::diagnostics::FILTER).stderr(Stdio::piped());
        }
        let start = std::time::Instant::now();
        let mut child = cmd.spawn().map_err(|e| format!("备用组件启动失败：{e}"))?;
        if let Some(stderr) = child.stderr.take() {
            tauri::async_runtime::spawn(super::diagnostics::drain(stderr, name.to_owned(), start));
        }
        self.children.push(child);
        Ok(())
    }

    pub async fn peers(&self, rpc: u16) -> Result<serde_json::Value, String> {
        let cli = super::fetch::desktop_binary("easytier-cli.exe").await?;
        let mut cmd = command(&cli);
        cmd.stdout(Stdio::piped()).args(["-p", &format!("127.0.0.1:{rpc}"), "-o", "json", "peer", "list"]);
        let out = tokio::time::timeout(std::time::Duration::from_secs(3), cmd.output()).await
            .map_err(|_| "备用链路状态查询超时")?.map_err(|e| e.to_string())?;
        if !out.status.success() { return Err("备用链路状态尚不可用".into()); }
        serde_json::from_slice(&out.stdout).map_err(|_| "备用链路状态格式错误".into())
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        let mut children = std::mem::take(&mut self.children);
        for child in &mut children { let _ = child.start_kill(); }
        let dir = self.dir.clone();
        tauri::async_runtime::spawn(async move {
            for mut child in children { let _ = child.wait().await; }
            // 只删本次 create_dir 的 UUID 目录中的三个固定配置文件，不递归删除。
            for name in ["seed.toml", "host.toml", "phone.toml"] { let _ = std::fs::remove_file(dir.join(name)); }
            let _ = std::fs::remove_dir(dir);
            log::info!("[RC-UNDERLAY] 子进程已退出，会话配置已释放");
        });
    }
}

fn command(path: &std::path::Path) -> Command {
    let mut cmd = Command::new(path);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)] cmd.creation_flags(0x08000000); // 后台组件不弹终端。
    cmd
}

async fn core_path() -> Result<PathBuf, String> {
    #[cfg(target_os = "android")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        tauri::wry::prelude::dispatch(move |env, activity, _| {
            let result = (|| -> Result<PathBuf, String> {
                let info = env.call_method(activity, "getApplicationInfo", "()Landroid/content/pm/ApplicationInfo;", &[])
                    .and_then(|v| v.l()).map_err(|e| e.to_string())?;
                let value = env.get_field(info, "nativeLibraryDir", "Ljava/lang/String;")
                    .and_then(|v| v.l()).map_err(|e| e.to_string())?;
                let dir: String = env.get_string(&value.into()).map_err(|e| e.to_string())?.into();
                Ok(PathBuf::from(dir).join("libeasytier.so"))
            })();
            let _ = tx.send(result);
        });
        return rx.await.map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "android"))]
    super::fetch::desktop_binary("easytier-core.exe").await
}

pub(super) fn tcp_port() -> io::Result<u16> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}
pub(super) fn udp_port() -> io::Result<u16> {
    Ok(std::net::UdpSocket::bind("127.0.0.1:0")?.local_addr()?.port())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bundled_coordinator_starts_and_drop_reaps_its_process_and_config() {
        let root = std::env::temp_dir().join(format!("pp-underlay-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        // 不改进程级 APP_DIR：完整测试集里其他 RcService 会初始化自己的目录。
        let dir = root.join("easytier-prototype").join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let mut runtime = Runtime {
            children: Vec::new(), dir,
            core: super::super::fetch::desktop_binary("easytier-core.exe").await.unwrap(),
        };
        let cfg = super::super::config::seed(tcp_port().unwrap());
        runtime.spawn("seed", &cfg, tcp_port().unwrap()).unwrap();
        let dir = runtime.dir.clone();
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        assert!(runtime.children[0].try_wait().unwrap().is_none(), "内置组件提前退出");
        drop(runtime);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while dir.exists() { tokio::time::sleep(std::time::Duration::from_millis(50)).await; }
        }).await.expect("必须先等待子进程退出，再删除会话配置");
        std::fs::remove_dir(root.join("easytier-prototype")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
