//! Session-owned FFmpeg/SVT-AV1 encoder. Only a bundled library is loaded in
//! release builds; missing/incompatible libraries never change the AVC path.
use crate::rc::video_params::VideoPacket;
use libloading::Library;
use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

#[repr(C)]
#[derive(Default)]
struct Packet {
    data: *mut u8,
    length: usize,
    at_ms: i64,
    key: bool,
}
type Open = unsafe extern "C" fn(u32, u32, u32, u32, *mut *mut c_void) -> i32;
type Encode = unsafe extern "C" fn(*mut c_void, *const u8, usize, bool, i64, *mut Packet) -> i32;
type Close = unsafe extern "C" fn(*mut c_void);
type Free = unsafe extern "C" fn(*mut u8);
struct Api {
    _library: Library,
    open: Open,
    encode: Encode,
    close: Close,
    free: Free,
}
fn library_paths(exe: PathBuf) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(contents) = exe.parent().and_then(|p| p.parent()) {
        if contents.file_name().is_some_and(|p| p == "Contents") {
            paths.push(contents.join("Frameworks/libpastepanda_av1.dylib"));
        }
    }
    // Direct cargo/dev execution has no bundle; never use a build-machine path
    // from an installed app, even if it is a debug package.
    #[cfg(debug_assertions)]
    if paths.is_empty() {
        paths.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../.cache/macos-av1-runtime/libpastepanda_av1.dylib"),
        );
    }
    paths
}
impl Api {
    fn load() -> Result<Arc<Self>, String> {
        let exe = std::env::current_exe().map_err(|_| "无法定位 AV1 运行库")?;
        let path = library_paths(exe)
            .into_iter()
            .find(|p| p.is_file())
            .ok_or("应用未包含 AV1 运行库")?;
        // The handle remains owned by Api until every encoder is dropped. No
        // PATH, system library directories or caller-selected paths are used.
        unsafe {
            let library = Library::new(path).map_err(|_| "AV1 运行库无法加载")?;
            let abi = library
                .get::<unsafe extern "C" fn() -> u32>(b"pp_av1_abi\0")
                .map_err(|_| "AV1 ABI 缺失")?;
            if abi() != 1 {
                return Err("AV1 ABI 不兼容".into());
            }
            let open = *library
                .get::<Open>(b"pp_av1_open\0")
                .map_err(|_| "AV1 open 接口缺失")?;
            let encode = *library
                .get::<Encode>(b"pp_av1_encode\0")
                .map_err(|_| "AV1 encode 接口缺失")?;
            let close = *library
                .get::<Close>(b"pp_av1_close\0")
                .map_err(|_| "AV1 close 接口缺失")?;
            let free = *library
                .get::<Free>(b"pp_av1_free\0")
                .map_err(|_| "AV1 free 接口缺失")?;
            Ok(Arc::new(Self {
                _library: library,
                open,
                encode,
                close,
                free,
            }))
        }
    }
}
fn api() -> Result<Arc<Api>, String> {
    static API: OnceLock<Result<Arc<Api>, String>> = OnceLock::new();
    API.get_or_init(Api::load).clone()
}
pub struct Encoder {
    api: Arc<Api>,
    handle: *mut c_void,
    parameters: (u32, u32, u32, u32),
}
// Owned by the remote session and always used under its encoder mutex.
unsafe impl Send for Encoder {}
impl Encoder {
    pub fn open(w: u32, h: u32, fps: u32, bitrate: u32) -> Result<Self, String> {
        let api = api()?;
        let mut handle = std::ptr::null_mut();
        if unsafe { (api.open)(w, h, fps, bitrate, &mut handle) } != 0 || handle.is_null() {
            if !handle.is_null() {
                unsafe { (api.close)(handle) };
            }
            return Err("FFmpeg/SVT-AV1 编码器初始化失败".into());
        }
        Ok(Self {
            api,
            handle,
            parameters: (w, h, fps, bitrate),
        })
    }
    pub fn matches(&self, w: u32, h: u32, fps: u32, bitrate: u32) -> bool {
        self.parameters == (w, h, fps, bitrate)
    }
    pub fn encode(
        &mut self,
        rgba: &[u8],
        key: bool,
        at_ms: i64,
    ) -> Result<Option<VideoPacket>, String> {
        let mut output = Packet::default();
        let status = unsafe {
            (self.api.encode)(
                self.handle,
                rgba.as_ptr(),
                rgba.len(),
                key,
                at_ms,
                &mut output,
            )
        };
        struct Owned<'a>(&'a Api, *mut u8);
        impl Drop for Owned<'_> {
            fn drop(&mut self) {
                if !self.1.is_null() {
                    unsafe { (self.0.free)(self.1) };
                }
            }
        }
        let memory = Owned(&self.api, output.data);
        if status == 10 && memory.1.is_null() && output.length == 0 {
            return Ok(None);
        }
        if status != 0
            || memory.1.is_null()
            || output.length == 0
            || output.length > crate::rc::video::MAX_H264_BYTES
        {
            return Err(format!("FFmpeg/SVT-AV1 编码失败（{status}）"));
        }
        Ok(Some(VideoPacket {
            data: unsafe { std::slice::from_raw_parts(memory.1, output.length) }.to_vec(),
            at_ms: output.at_ms,
            key: output.key,
            width: self.parameters.0,
            height: self.parameters.1,
        }))
    }
}
impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe { (self.api.close)(self.handle) };
    }
}
pub fn available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| Encoder::open(64, 64, 30, 1_000_000).is_ok())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installed_app_only_loads_its_own_framework() {
        assert_eq!(
            library_paths(PathBuf::from(
                "/Applications/PastePanda.app/Contents/MacOS/PastePanda"
            )),
            vec![PathBuf::from(
                "/Applications/PastePanda.app/Contents/Frameworks/libpastepanda_av1.dylib"
            )]
        );
    }
    #[test]
    fn built_library_encodes_when_explicitly_requested() {
        if std::env::var_os("PASTEPANDA_TEST_AV1").is_none() {
            return;
        }
        let mut encoder = Encoder::open(64, 64, 30, 1_000_000).unwrap();
        let rgba = vec![120; 64 * 64 * 4];
        let mut packets = Vec::new();
        for index in 0..12 {
            if let Some(packet) = encoder
                .encode(&rgba, index == 0 || index == 6, index * 34)
                .unwrap()
            {
                packets.push(packet);
            }
            std::thread::sleep(std::time::Duration::from_millis(34));
        }
        assert!(packets.len() >= 4);
        assert!(packets[0].key);
        assert!(packets.windows(2).all(|p| p[0].at_ms < p[1].at_ms));
        assert!(packets.iter().any(|p| p.key && p.at_ms == 204));
    }
}
