//! Optional ABI-1 dav1d receiver. Session state is owned by RcService, not a
//! global decoder. Raw RGBA crosses only the local binary IPC boundary.
use libloading::Library;
use std::{ffi::c_void, sync::{Arc, OnceLock}, time::Instant};
use crate::rc::video::{FrameCodec, VideoFrame, MAX_H264_BYTES};

#[repr(C)]
#[derive(Default)]
struct Picture { data: *mut u8, length: usize, at_ms: i64, width: u32, height: u32 }
type Open = unsafe extern "C" fn(*mut *mut c_void) -> i32;
type Decode = unsafe extern "C" fn(*mut c_void, *const u8, usize, i64, *mut Picture) -> i32;
type Close = unsafe extern "C" fn(*mut c_void);
type Free = unsafe extern "C" fn(*mut u8);
struct Api { _library: Library, open: Open, decode: Decode, close: Close, free: Free }
impl Api {
    fn load() -> Result<Arc<Self>, String> {
        let exe = std::env::current_exe().map_err(|_| "无法定位 AV1 运行库")?;
        let path = super::av1::library_paths(exe).into_iter().find(|p| p.is_file()).ok_or("AV1 运行库缺失")?;
        unsafe {
            let library = Library::new(path).map_err(|_| "AV1 运行库无法加载")?;
            let abi = library.get::<unsafe extern "C" fn() -> u32>(b"pp_av1_abi\0").map_err(|_| "AV1 ABI 缺失")?;
            if abi() != 1 { return Err("AV1 ABI 不兼容".into()); }
            let open = *library.get::<Open>(b"pp_av1_decode_open\0").map_err(|_| "AV1 接收接口缺失")?;
            let decode = *library.get::<Decode>(b"pp_av1_decode\0").map_err(|_| "AV1 解码接口缺失")?;
            let close = *library.get::<Close>(b"pp_av1_decode_close\0").map_err(|_| "AV1 关闭接口缺失")?;
            let free = *library.get::<Free>(b"pp_av1_free\0").map_err(|_| "AV1 释放接口缺失")?;
            Ok(Arc::new(Self { _library: library, open, decode, close, free }))
        }
    }
}
fn api() -> Result<Arc<Api>, String> {
    static API: OnceLock<Result<Arc<Api>, String>> = OnceLock::new();
    API.get_or_init(Api::load).clone()
}
struct Decoder { api: Arc<Api>, handle: *mut c_void }
// Only used under RcService's receiver mutex; its library outlives the handle.
unsafe impl Send for Decoder {}
impl Decoder {
    fn open() -> Result<Self, String> {
        let api = api()?;
        let mut handle = std::ptr::null_mut();
        if unsafe { (api.open)(&mut handle) } != 0 || handle.is_null() {
            if !handle.is_null() { unsafe { (api.close)(handle) }; }
            return Err("dav1d 初始化失败".into());
        }
        Ok(Self { api, handle })
    }
    fn decode(&mut self, f: &VideoFrame) -> Result<Option<Vec<u8>>, String> {
        let start = Instant::now();
        let mut picture = Picture::default();
        let status = unsafe { (self.api.decode)(self.handle, f.jpeg.as_ptr(), f.jpeg.len(), f.at_ms, &mut picture) };
        struct Owned<'a>(&'a Api, *mut u8);
        impl Drop for Owned<'_> { fn drop(&mut self) { if !self.1.is_null() { unsafe { (self.0.free)(self.1) }; } } }
        let owned = Owned(&self.api, picture.data);
        if status == 10 && owned.1.is_null() && picture.length == 0 { return Ok(None); }
        if status != 0 || owned.1.is_null() || picture.width != f.width || picture.height != f.height ||
            picture.length != f.width as usize * f.height as usize * 4 || picture.at_ms != f.at_ms {
            return Err(format!("dav1d 解码失败（{status}）"));
        }
        let mut bytes = Vec::with_capacity(8 + picture.length);
        bytes.extend_from_slice(&(f.jpeg.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(unsafe { std::slice::from_raw_parts(owned.1, picture.length) });
        let micros = start.elapsed().as_micros().min(u32::MAX as u128) as u32;
        bytes[4..8].copy_from_slice(&micros.to_le_bytes());
        Ok(Some(bytes))
    }
}
impl Drop for Decoder { fn drop(&mut self) { unsafe { (self.api.close)(self.handle) }; } }

fn bounded(f: &VideoFrame) -> bool {
    f.width > 0 && f.height > 0 && f.width <= 1920 && f.height <= 1920 &&
        u64::from(f.width) * u64::from(f.height) <= 1920 * 1080 &&
        !f.jpeg.is_empty() && f.jpeg.len() <= MAX_H264_BYTES && f.rect.is_none()
}
#[derive(Default)]
pub(crate) struct Receiver {
    session: String,
    dimensions: (u32, u32),
    decoder: Option<Decoder>,
}
impl Receiver {
    pub(crate) fn clear(&mut self) { *self = Self::default(); }
    fn transform(&mut self, session: &str, f: &VideoFrame) -> Result<Option<Vec<u8>>, String> {
        if !bounded(f) { self.clear(); return Err("AV1 软件接收上限为 1080p".into()); }
        if self.session != session || self.dimensions != (f.width, f.height) {
            self.clear(); self.session = session.into(); self.dimensions = (f.width, f.height);
        }
        if self.decoder.is_none() {
            if !f.key { return Err("AV1 接收等待关键帧".into()); }
            self.decoder = Some(Decoder::open()?);
        }
        self.decoder.as_mut().unwrap().decode(f)
    }
    /// Decode every reference frame, retain at most one RGBA picture per
    /// consecutive AV1 run. A compressed/error frame remains on the existing
    /// WebCodecs recovery path, which falls back to AVC after three failures.
    pub(crate) fn batch(&mut self, session: &str, frames: Vec<VideoFrame>) -> (Vec<VideoFrame>, Vec<usize>) {
        let mut out = Vec::new(); let mut native = Vec::new();
        for mut f in frames {
            if f.codec != FrameCodec::Av1 { self.clear(); out.push(f); continue; }
            match self.transform(session, &f) {
                Ok(Some(bytes)) => {
                    f.jpeg = bytes; f.full = true; f.key = true;
                    if native.last().is_some_and(|&i| i + 1 == out.len()) {
                        let previous: VideoFrame = out.pop().unwrap(); native.pop();
                        for offset in [0, 4] {
                            let a = u32::from_le_bytes(previous.jpeg[offset..offset + 4].try_into().unwrap());
                            let b = u32::from_le_bytes(f.jpeg[offset..offset + 4].try_into().unwrap());
                            f.jpeg[offset..offset + 4].copy_from_slice(&a.saturating_add(b).to_le_bytes());
                        }
                    }
                    native.push(out.len()); out.push(f);
                }
                Ok(None) => {}
                Err(_) => { self.decoder = None; out.push(f); }
            }
        }
        (out, native)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_receiver_keeps_reference_frames_but_bounds_rgba_batch() {
        if std::env::var_os("PASTEPANDA_TEST_AV1").is_none() { return; }
        let mut encoder = crate::macos::av1::Encoder::open(64, 64, 30, 1_000_000).unwrap();
        let mut frames = Vec::new();
        for index in 0..20 {
            let pixels = vec![80 + index as u8; 64 * 64 * 4];
            if let Some(packet) = encoder.encode(&pixels, index == 0 || index == 10, index * 34).unwrap() {
                frames.push(VideoFrame { codec: FrameCodec::Av1, jpeg: packet.data, key: packet.key,
                    full: true, at_ms: packet.at_ms, cap_ms: 0, enc_ms: 0, width: 64, height: 64, rect: None });
            }
            std::thread::sleep(std::time::Duration::from_millis(34));
        }
        assert!(frames.len() >= 10);
        let bytes: usize = frames.iter().map(|f| f.jpeg.len()).sum();
        let last = frames.last().unwrap().clone();
        let key = frames.iter().find(|f| f.at_ms == 340 && f.key).unwrap().clone();
        let mut receiver = Receiver::default();
        let (result, native) = receiver.batch("first", frames);
        assert_eq!(native, vec![0]); assert_eq!(result.len(), 1);
        assert_eq!(result[0].at_ms, last.at_ms);
        assert_eq!(result[0].jpeg.len(), 8 + 64 * 64 * 4);
        assert_eq!(u32::from_le_bytes(result[0].jpeg[..4].try_into().unwrap()) as usize, bytes);
        assert!(receiver.decoder.is_some());
        // A new session never inherits the old AV1 reference chain.
        let (delta, flags) = receiver.batch("second", vec![last]);
        assert!(flags.is_empty()); assert_eq!(delta.len(), 1);
        assert!(receiver.decoder.is_none());
        let (recovered, flags) = receiver.batch("second", vec![key]);
        assert_eq!(flags, vec![0]); assert_eq!(recovered.len(), 1);
        receiver.clear(); assert!(receiver.decoder.is_none());
    }
    #[test]
    fn caps_precede_decode_or_allocation() {
        let mut f = VideoFrame { codec: FrameCodec::Av1, jpeg: vec![1], key: false, full: true,
            at_ms: 1, cap_ms: 0, enc_ms: 0, width: 3840, height: 2160, rect: None };
        assert!(!bounded(&f));
        f.width = u32::MAX; assert!(!bounded(&f));
        f.width = 1920; f.height = 1080; assert!(bounded(&f));
        let mut receiver = Receiver::default();
        let (frames, native) = receiver.batch("owned", vec![f]);
        assert!(native.is_empty()); assert_eq!(frames[0].jpeg, vec![1]);
        assert!(receiver.decoder.is_none()); // delta must not create a decoder
        receiver.clear(); assert!(receiver.session.is_empty());
    }
}
