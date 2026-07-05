//! 统一错误类型 — 参考 CC Switch 的错误集中管理模式
//! 使用 thiserror 提供类型安全的错误，方便前端根据错误类型做差异化处理

use serde::Serialize;

/// 应用级错误类型
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// 数据库操作错误
    #[error("数据库错误: {0}")]
    Database(String),

    /// 剪贴板操作错误
    #[error("剪贴板错误: {0}")]
    Clipboard(String),

    /// 文件操作错误（路径、权限、不存在等）
    #[error("文件错误: {0}")]
    File(String),

    /// 图像处理错误
    #[error("图像处理错误: {0}")]
    Image(String),

    /// 配置错误
    #[error("配置错误: {0}")]
    Config(String),

    /// 网络/同步错误
    #[error("网络错误: {0}")]
    Network(String),

    /// 热键注册错误
    #[error("热键错误: {0}")]
    Hotkey(String),

    /// 系统操作错误（注册表、进程等）
    #[error("系统错误: {0}")]
    System(String),

    /// 参数校验错误
    #[error("参数错误: {0}")]
    Validation(String),

    /// 内部状态错误（资源未初始化等）
    #[error("内部错误: {0}")]
    Internal(String),

    /// 未知错误
    #[error("未知错误: {0}")]
    Unknown(String),
}

/// 前端可用的错误信息（含错误码，方便国际化）
#[derive(Debug, Clone, Serialize)]
pub struct AppErrorInfo {
    /// 错误码（如 "DATABASE_ERROR", "FILE_NOT_FOUND"）
    pub code: String,
    /// 人类可读的错误描述
    pub message: String,
}

impl AppError {
    /// 将 AppError 转换为前端友好的错误信息
    pub fn to_info(&self) -> AppErrorInfo {
        let code = match self {
            AppError::Database(_) => "DATABASE_ERROR",
            AppError::Clipboard(_) => "CLIPBOARD_ERROR",
            AppError::File(_) => "FILE_ERROR",
            AppError::Image(_) => "IMAGE_ERROR",
            AppError::Config(_) => "CONFIG_ERROR",
            AppError::Network(_) => "NETWORK_ERROR",
            AppError::Hotkey(_) => "HOTKEY_ERROR",
            AppError::System(_) => "SYSTEM_ERROR",
            AppError::Validation(_) => "VALIDATION_ERROR",
            AppError::Internal(_) => "INTERNAL_ERROR",
            AppError::Unknown(_) => "UNKNOWN_ERROR",
        };
        AppErrorInfo {
            code: code.to_string(),
            message: self.to_string(),
        }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Database(e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::File(e.to_string())
    }
}

impl From<image::ImageError> for AppError {
    fn from(e: image::ImageError) -> Self {
        AppError::Image(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Config(e.to_string())
    }
}

impl From<String> for AppError {
    fn from(e: String) -> Self {
        AppError::Unknown(e)
    }
}

// 与 Tauri 兼容：tauri::command 需要返回 Result<T, String> 或 Result<T, impl Serialize>
// 这里保持 String 兼容，同时提供 AppError 的转换
impl From<AppError> for String {
    fn from(e: AppError) -> Self {
        e.to_string()
    }
}
