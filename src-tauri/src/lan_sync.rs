use crate::data_store::{compute_pinyin_initials, DataStore, HistoryItem};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const MULTICAST_ADDR: &str = "224.1.1.1:5007";
/// 图片通过 LAN 同步的最大文件大小 (2MB)
const MAX_IMAGE_SIZE_LAN: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LanMessage {
    #[serde(rename = "type")]
    msg_type: String,
    /// 剪贴板条目类型: "text" / "image" / "file"
    item_type: String,
    text: String,
    /// 图片 base64 数据（仅 image 类型）
    #[serde(default, skip_serializing_if = "String::is_empty")]
    image_base64: String,
    device_id: String,
    device_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanDevice {
    pub device_id: String,
    pub device_name: String,
    pub last_seen: String,
}

pub struct LanSync {
    running: Arc<AtomicBool>,
    device_id: String,
    pub devices: Arc<Mutex<HashMap<String, LanDevice>>>,
}

impl LanSync {
    pub fn new(device_id: String) -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            device_id,
            devices: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 获取已发现的设备列表
    pub fn get_devices(&self) -> Vec<LanDevice> {
        self.devices
            .lock()
            .map(|d| d.values().cloned().collect())
            .unwrap_or_default()
    }

    /// 发送剪贴板文本到局域网
    pub fn send(&self, text: &str) {
        self.send_item("text", text, "");
    }

    /// 发送剪贴板条目（支持 text/image/file）
    pub fn send_item(&self, item_type: &str, text: &str, image_path: &str) {
        if text.is_empty() && image_path.is_empty() {
            return;
        }

        let mut image_base64 = String::new();

        // 图片类型：读取并编码为 base64
        if item_type == "image" && !image_path.is_empty() {
            match std::fs::metadata(image_path) {
                Ok(meta) if meta.len() <= MAX_IMAGE_SIZE_LAN => match std::fs::read(image_path) {
                    Ok(data) => {
                        image_base64 = base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            &data,
                        );
                        log::info!("[LanSync] 图片已编码 {}B", data.len());
                    }
                    Err(e) => {
                        log::warn!("[LanSync] 读取图片失败: {}", e);
                    }
                },
                Ok(meta) => {
                    log::warn!(
                        "[LanSync] 图片过大 ({}B > {}B)，跳过",
                        meta.len(),
                        MAX_IMAGE_SIZE_LAN
                    );
                }
                Err(e) => {
                    log::warn!("[LanSync] 获取图片元数据失败: {}", e);
                }
            }
        }

        let msg = LanMessage {
            msg_type: "clipboard".to_string(),
            item_type: item_type.to_string(),
            text: text.to_string(),
            image_base64,
            device_id: self.device_id.clone(),
            device_name: hostname::get()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_else(|_| "未知设备".to_string()),
        };

        if let Ok(json) = serde_json::to_string(&msg) {
            if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
                if let Err(e) = socket.set_ttl(2) {
                    log::warn!("[LanSync] 设置 TTL 失败: {}", e);
                }
                if let Err(e) = socket.send_to(json.as_bytes(), MULTICAST_ADDR) {
                    log::warn!("[LanSync] 发送消息失败: {}", e);
                }
            }
        }
    }

    /// 启动局域网监听线程
    pub fn start_listener(&self, app_handle: AppHandle) {
        if self.running.load(Ordering::SeqCst) {
            return;
        }
        self.running.store(true, Ordering::SeqCst);

        let running = self.running.clone();
        let device_id = self.device_id.clone();
        let devices = self.devices.clone();

        std::thread::spawn(move || {
            log::info!("[LanSync] 监听线程启动");

            let socket = match UdpSocket::bind("0.0.0.0:5007") {
                Ok(s) => s,
                Err(e) => {
                    log::warn!("[LanSync] 绑定端口 5007 失败 (可能被占用): {}", e);
                    return;
                }
            };

            use std::net::Ipv4Addr;
            let multicast = Ipv4Addr::new(224, 1, 1, 1);
            let interface = Ipv4Addr::UNSPECIFIED;
            if let Err(e) = socket.join_multicast_v4(&multicast, &interface) {
                log::warn!("[LanSync] 加入组播组失败: {}", e);
            }
            if let Err(e) = socket.set_read_timeout(Some(std::time::Duration::from_secs(2))) {
                log::warn!("[LanSync] 设置读取超时失败: {}", e);
            }

            let mut buf = [0u8; 65536];
            while running.load(Ordering::SeqCst) {
                match socket.recv_from(&mut buf) {
                    Ok((len, _addr)) => {
                        if let Ok(text) = std::str::from_utf8(&buf[..len]) {
                            if let Ok(msg) = serde_json::from_str::<LanMessage>(text) {
                                // 过滤自身消息
                                if msg.device_id == device_id {
                                    continue;
                                }

                                // 更新设备列表
                                {
                                    let now = chrono::Local::now()
                                        .format("%Y-%m-%d %H:%M:%S")
                                        .to_string();
                                    if let Ok(mut devs) = devices.lock() {
                                        devs.insert(
                                            msg.device_id.clone(),
                                            LanDevice {
                                                device_id: msg.device_id.clone(),
                                                device_name: msg.device_name.clone(),
                                                last_seen: now,
                                            },
                                        );
                                    }
                                }

                                // 根据类型处理
                                let now_str =
                                    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
                                let source = format!("局域网: {}", msg.device_name);
                                let item_type = msg.item_type.clone();

                                let (final_text, content) = match item_type.as_str() {
                                    "image" if !msg.image_base64.is_empty() => {
                                        // 解码图片并保存到本地
                                        match save_synced_image(&msg.image_base64, &app_handle) {
                                            Ok(path) => (
                                                format!("[图片同步] 来自 {}", msg.device_name),
                                                path,
                                            ),
                                            Err(e) => {
                                                log::warn!("[LanSync] 保存同步图片失败: {}", e);
                                                (format!("[图片同步失败] {}", e), String::new())
                                            }
                                        }
                                    }
                                    "file" => (format!("[文件] {}", msg.text), String::new()),
                                    _ => (msg.text.clone(), String::new()),
                                };

                                // 为文本类型计算拼音首字母，支持前端拼音搜索
                                let pinyin_initials = if item_type == "text" {
                                    Some(compute_pinyin_initials(&final_text))
                                } else {
                                    None
                                };

                                let item = HistoryItem {
                                    id: uuid::Uuid::new_v4().to_string(),
                                    text: final_text,
                                    time: now_str,
                                    item_type,
                                    content,
                                    pinned: false,
                                    source,
                                    workspace: "默认".to_string(),
                                    md5: None,
                                    pinyin_initials,
                                    group_id: None,
                                    tags: Vec::new(),
                                };

                                if let Some(store) = app_handle.try_state::<DataStore>() {
                                    if let Err(e) = store.insert_history(&item) {
                                        log::error!("[LanSync] 插入同步记录失败: {}", e);
                                    }
                                }

                                if let Err(e) = app_handle.emit(
                                    "clipboard-changed",
                                    crate::clipboard_monitor::ClipboardChanged { item },
                                ) {
                                    log::warn!("[LanSync] 推送同步事件失败: {}", e);
                                }
                            }
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                    Err(e) => {
                        log::warn!("[LanSync] 接收失败: {}", e);
                    }
                }
            }

            log::info!("[LanSync] 监听线程退出");
        });
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

/// 将 base64 编码的图片保存到本地 images 目录，返回路径
fn save_synced_image(base64_data: &str, app_handle: &AppHandle) -> Result<String, String> {
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, base64_data)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取数据目录失败: {}", e))?;
    let images_dir = app_dir.join("images");
    std::fs::create_dir_all(&images_dir).map_err(|e| format!("创建图片目录失败: {}", e))?;

    let file_name = format!("lan_{}.png", uuid::Uuid::new_v4());
    let file_path = images_dir.join(&file_name);

    std::fs::write(&file_path, &bytes).map_err(|e| format!("写入图片文件失败: {}", e))?;

    Ok(file_path.to_str().unwrap_or("").to_string())
}
