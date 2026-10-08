//! Bounded local request identities; cancellation is retained before registration.
use super::asset::AssetError;
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::watch;

#[derive(Default)]
struct Requests {
    active: HashMap<String, watch::Sender<bool>>,
    cancelled: VecDeque<(String, Instant)>,
}
fn requests() -> &'static Mutex<Requests> {
    static REQUESTS: OnceLock<Mutex<Requests>> = OnceLock::new();
    REQUESTS.get_or_init(Mutex::default)
}
fn valid(id: &str) -> Result<(), AssetError> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| AssetError::new("invalid", "图片请求标识无效"))
}
pub struct RequestGuard {
    id: String,
    cancel: watch::Receiver<bool>,
}
impl Drop for RequestGuard {
    fn drop(&mut self) {
        if let Ok(mut requests) = requests().lock() {
            requests.active.remove(&self.id);
        }
    }
}
impl RequestGuard {
    pub fn receiver(&self) -> watch::Receiver<bool> {
        self.cancel.clone()
    }
    pub fn cancelled(&self) -> bool {
        *self.cancel.borrow()
    }
}
pub fn begin(id: &str) -> Result<RequestGuard, AssetError> {
    valid(id)?;
    let mut requests = requests().lock().map_err(|_| AssetError::io())?;
    requests
        .cancelled
        .retain(|(_, at)| at.elapsed() < Duration::from_secs(90));
    if requests.cancelled.iter().any(|(old, _)| old == id) {
        return Err(AssetError::cancelled());
    }
    if requests.active.contains_key(id) || requests.active.len() >= 2 {
        return Err(AssetError::new("busy", "正在补齐其他图片，请稍后重试"));
    }
    let (sender, cancel) = watch::channel(false);
    requests.active.insert(id.into(), sender);
    Ok(RequestGuard {
        id: id.into(),
        cancel,
    })
}
pub fn cancel(id: &str) -> Result<(), AssetError> {
    valid(id)?;
    let mut requests = requests().lock().map_err(|_| AssetError::io())?;
    if let Some(sender) = requests.active.get(id) {
        sender.send_replace(true);
    }
    // Retain a small tombstone set: navigating away can race the invoke entering Rust.
    if requests.cancelled.len() >= 64 {
        requests.cancelled.pop_front();
    }
    requests.cancelled.push_back((id.into(), Instant::now()));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_cancellation_survives_registration_race_and_releases_slot() {
        let id = uuid::Uuid::new_v4().to_string();
        cancel(&id).unwrap();
        assert_eq!(begin(&id).err().unwrap().code, "cancelled");
        let live = uuid::Uuid::new_v4().to_string();
        let guard = begin(&live).unwrap();
        assert_eq!(begin(&live).err().unwrap().code, "busy");
        cancel(&live).unwrap();
        assert!(guard.cancelled());
        drop(guard);
        assert!(!requests().lock().unwrap().active.contains_key(&live));
    }
}
