//! System audio capture worker; owns its native stream on one dedicated thread.
use super::{asc_for, try_push_audio, AudioCfg, AudioOut, AudioTx};
use std::{
    ffi::c_void,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};
extern "C" {
    fn pp_rc_audio_start(handle: *mut *mut c_void) -> i32;
    fn pp_rc_audio_next(
        handle: *mut c_void,
        bytes: *mut *mut u8,
        length: *mut usize,
        pts: *mut u64,
    ) -> i32;
    fn pp_rc_audio_stop(handle: *mut c_void);
    fn pp_mac_free(bytes: *mut c_void);
    fn pp_rc_speaker_muted(muted: *mut bool) -> i32;
    fn pp_rc_speaker_set(on: bool, actual: *mut bool) -> i32;
}
struct Capture(*mut c_void);
impl Drop for Capture {
    fn drop(&mut self) {
        unsafe { pp_rc_audio_stop(self.0) }
    }
}
fn failure(code: i32) -> String {
    match code {
        2 => "传输系统声音需要屏幕录制权限，请在系统设置中允许 PastePanda 后重开",
        5 => "Mac 系统声音 AAC 编码失败",
        8 => "Mac 系统声音传输需要 macOS 13 或更高版本",
        9 => "Mac 系统声音传输目前支持单显示器",
        _ => "Mac 系统声音采集失败或超时",
    }
    .into()
}
pub struct AudioWorker {
    stop: Arc<AtomicBool>,
    exited: tokio::sync::mpsc::UnboundedReceiver<()>,
}
impl AudioWorker {
    pub fn start(wanted: Arc<AtomicBool>, tx: AudioTx) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let (ack, exited) = tokio::sync::mpsc::unbounded_channel();
        let backup = tx.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("rc-mac-audio".into())
            .spawn(move || {
                run(flag, wanted, tx);
                let _ = ack.send(());
            })
        {
            try_push_audio(
                &backup,
                AudioOut::Error(format!("无法启动 Mac 音频线程：{error}")),
                &AtomicU64::new(0),
            );
        }
        Self { stop, exited }
    }
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
    pub async fn stop_confirmed(&mut self) {
        self.stop();
        // Native startup <=8s, shutdown <=2s. Never open a replacement before this barrier.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(11), self.exited.recv()).await;
    }
}
impl Drop for AudioWorker {
    fn drop(&mut self) {
        self.stop();
    }
}
fn run(stop: Arc<AtomicBool>, wanted: Arc<AtomicBool>, tx: AudioTx) {
    let dropped = AtomicU64::new(0);
    if stop.load(Ordering::SeqCst) || !wanted.load(Ordering::SeqCst) {
        return;
    }
    let mut handle = std::ptr::null_mut();
    let code = unsafe { pp_rc_audio_start(&mut handle) };
    if code != 0 || handle.is_null() {
        try_push_audio(&tx, AudioOut::Error(failure(code)), &dropped);
        return;
    }
    let capture = Capture(handle);
    let config = AudioCfg {
        sr: 48000,
        ch: 2,
        asc: asc_for(48000, 2).expect("AAC-LC wire configuration"),
        br: 128,
    };
    if !try_push_audio(&tx, AudioOut::Cfg(config), &dropped) {
        return;
    }
    while !stop.load(Ordering::SeqCst) && wanted.load(Ordering::SeqCst) {
        let (mut bytes, mut length, mut pts) = (std::ptr::null_mut(), 0, 0);
        let result = unsafe { pp_rc_audio_next(capture.0, &mut bytes, &mut length, &mut pts) };
        if result == 1 {
            std::thread::sleep(std::time::Duration::from_millis(10));
            continue;
        }
        if result != 0 {
            if !bytes.is_null() {
                unsafe { pp_mac_free(bytes.cast()) }
            };
            try_push_audio(&tx, AudioOut::Error(failure(result)), &dropped);
            break;
        }
        if bytes.is_null() || length == 0 || length > 65536 {
            if !bytes.is_null() {
                unsafe { pp_mac_free(bytes.cast()) }
            };
            try_push_audio(&tx, AudioOut::Error("Mac 音频包无效".into()), &dropped);
            break;
        }
        let data = unsafe { std::slice::from_raw_parts(bytes, length) }.to_vec();
        unsafe { pp_mac_free(bytes.cast()) };
        if !try_push_audio(&tx, AudioOut::Pkt { pts_ms: pts, data }, &dropped) {
            break;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_failures_have_visible_messages() {
        for code in [2, 4, 5, 8, 9] {
            assert!(!failure(code).is_empty());
        }
    }
}

pub fn spk_mute_get() -> Result<bool, String> {
    let mut muted = false;
    if unsafe { pp_rc_speaker_muted(&mut muted) } == 0 {
        Ok(muted)
    } else {
        Err("此输出设备无法查询扬声器静音状态".into())
    }
}

pub fn spk_mute_set(on: bool) -> Result<bool, String> {
    let mut actual = false;
    let code = unsafe { pp_rc_speaker_set(on, &mut actual) };
    match code {
        0 => Ok(actual),
        2 => Err("此输出设备不支持系统扬声器静音".into()),
        _ => Err(format!(
            "系统未确认扬声器静音切换（{code}），请检查当前声音输出设备"
        )),
    }
}
