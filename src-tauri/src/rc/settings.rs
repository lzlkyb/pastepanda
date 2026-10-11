//! Correlated setting receipts. Older peers ignore request_id and still apply the input.
use super::input::{assert_control_allowed, InputEvent, KeyMode};
use super::protocol::SessionPhase;
use super::service::RcService;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::oneshot;

const MAX_PENDING: usize = 16;
const WAIT: Duration = Duration::from_secs(8);

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct SettingResult {
    pub status: &'static str,
    pub value: String,
}

struct Pending {
    session: String,
    key: String,
    value: String,
    reply: oneshot::Sender<Result<String, String>>,
}

#[derive(Default)]
pub(in crate::rc) struct SettingTracker(Mutex<HashMap<String, Pending>>);

impl SettingTracker {
    fn begin(
        &self,
        session: &str,
        key: &str,
        value: &str,
    ) -> Result<(String, oneshot::Receiver<Result<String, String>>), String> {
        let mut pending = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if pending.len() >= MAX_PENDING {
            return Err("设置操作过多，请稍后重试".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (reply, receiver) = oneshot::channel();
        pending.insert(
            id.clone(),
            Pending {
                session: session.into(),
                key: key.into(),
                value: value.into(),
                reply,
            },
        );
        Ok((id, receiver))
    }

    fn remove(&self, id: &str) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).remove(id);
    }

    pub(in crate::rc) fn clear(&self) {
        let pending = std::mem::take(&mut *self.0.lock().unwrap_or_else(|p| p.into_inner()));
        for (_, p) in pending {
            let _ = p.reply.send(Err("会话已结束，设置结果未确认".into()));
        }
    }

    fn resolve(&self, session: &str, frame: &serde_json::Value) {
        let Some(id) = frame["request_id"].as_str() else {
            return;
        };
        let mut pending = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let Some(p) = pending.get(id) else { return };
        if p.session != session || frame["key"].as_str() != Some(p.key.as_str()) {
            return;
        }
        let result = match frame["status"].as_str() {
            Some("accepted") if frame["value"].as_str() == Some(p.value.as_str()) => {
                Ok(p.value.clone())
            }
            Some("rejected") => Err(frame["error"]
                .as_str()
                .unwrap_or("电脑拒绝了此设置")
                .to_string()),
            _ => return,
        };
        if let Some(p) = pending.remove(id) {
            let _ = p.reply.send(result);
        }
    }
}

// Removing the entry on Drop also handles cancelled frontend invocations.
struct Registration<'a> {
    tracker: &'a SettingTracker,
    id: String,
}
impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.tracker.remove(&self.id);
    }
}

fn setting_event(key: &str, value: &str) -> Result<InputEvent, String> {
    match (key, value) {
        (
            "quality",
            "auto" | "uhd" | "uhd60" | "ultra" | "sharp" | "balanced" | "smooth" | "fps60"
            | "fps120" | "fps144" | "fps165",
        ) => Ok(InputEvent::SetQuality {
            quality: value.into(),
        }),
        ("audio", "on" | "off") => Ok(InputEvent::AudioOn { on: value == "on" }),
        ("key_mode", "type" | "direct") => Ok(InputEvent::SetKeyMode { mode: value.into() }),
        _ => Err("不支持的设置或设置值".into()),
    }
}

pub(in crate::rc) fn event_setting(ev: &InputEvent) -> Option<(&str, &str)> {
    match ev {
        InputEvent::SetQuality { quality } => Some(("quality", quality)),
        InputEvent::AudioOn { on } => Some(("audio", if *on { "on" } else { "off" })),
        InputEvent::SetKeyMode { mode } => Some(("key_mode", mode)),
        _ => None,
    }
}

impl RcService {
    /// Receipt confirms host configuration acceptance, not a rendered frame/audio delivery.
    pub async fn apply_setting(
        &self,
        session_id: &str,
        key: &str,
        value: &str,
    ) -> Result<SettingResult, String> {
        let ev = setting_event(key, value)?;
        if !self.session_id_is(session_id) {
            return Err("会话已改变，请重新操作".into());
        }
        let deadline = tokio::time::Instant::now() + WAIT;
        let (id, receiver) = self.settings.begin(session_id, key, value)?;
        let _registration = Registration {
            tracker: &self.settings,
            id: id.clone(),
        };
        let connection = self.outbound_conn.lock().await.clone();
        let send = self.send_input_with_request(&ev, Some((session_id, &id)));
        match tokio::time::timeout_at(deadline, send).await {
            Ok(result) => result?,
            Err(_) => {
                // A cancelled write can leave a partial frame; never reuse that stream.
                if let Some(conn) = connection {
                    conn.close(0u32.into(), b"rc-setting-write-timeout");
                }
                return Ok(SettingResult {
                    status: "unconfirmed",
                    value: value.into(),
                });
            }
        }
        let result = match tokio::time::timeout_at(deadline, receiver).await {
            Ok(Ok(result)) => Some(result?),
            Ok(Err(_)) => return Err("会话已结束，设置结果未确认".into()),
            Err(_) => None,
        };
        if !self.session_id_is(session_id) {
            return Err("会话已改变，设置结果未确认".into());
        }
        Ok(SettingResult {
            status: if result.is_some() {
                "accepted"
            } else {
                "unconfirmed"
            },
            value: result.unwrap_or_else(|| value.into()),
        })
    }

    pub(in crate::rc) fn receive_setting_ack(&self, session: &str, frame: &serde_json::Value) {
        if self.session_id_is(session) {
            self.settings.resolve(session, frame);
        }
    }

    /// Legacy and tracked input share the exact same permission and side-effect boundary.
    pub(in crate::rc) fn apply_inbound_setting(
        &self,
        session: &str,
        peer: &str,
        ev: &InputEvent,
        tracked: bool,
    ) -> Result<String, String> {
        let (key, value) = event_setting(ev).ok_or("不支持的设置")?;
        if tracked {
            setting_event(key, value)?;
        }
        {
            // Keep session identity stable across the synchronous setting mutation.
            let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let s = inner.session.as_ref().ok_or("会话已结束")?;
            if s.id != session || s.peer != peer || s.phase != SessionPhase::InboundActive {
                return Err("会话已改变".into());
            }
            match ev {
                InputEvent::SetQuality { quality } => self.set_stream_quality(quality)?,
                InputEvent::AudioOn { on } => {
                    #[cfg(any(target_os="windows",target_os="macos"))]
                    self.set_audio_muted(!*on);
                    #[cfg(not(any(target_os="windows",target_os="macos")))]
                    if tracked && *on {
                        return Err("对方系统不支持传输电脑声音".into());
                    }
                }
                InputEvent::SetKeyMode { mode } => {
                    assert_control_allowed(s.capability)?;
                    self.set_peer_key_mode(KeyMode::from_wire(mode));
                }
                _ => unreachable!(),
            }
        }
        if key != "key_mode" {
            self.emit_stream_note(key, value);
        }
        Ok(if key == "key_mode" {
            KeyMode::from_wire(value).wire().into()
        } else {
            value.into()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service(capability: super::super::protocol::Capability) -> RcService {
        let svc = RcService::new(crate::data_store::DataStore::new(":memory:").unwrap());
        svc.inner.lock().unwrap().session = Some(super::super::session::Session {
            id: "current".into(),
            peer: "peer".into(),
            peer_name: "电脑".into(),
            display_name: String::new(),
            capability,
            phase: SessionPhase::InboundActive,
            started_ms: 0,
            started_mono: 0,
            granted: true,
            bg_since_mono: 0,
        });
        svc
    }

    #[test]
    fn shared_host_boundary_rejects_stale_peer_and_view_key_mode() {
        use super::super::protocol::Capability;
        let svc = service(Capability::View);
        let event = setting_event("key_mode", "direct").unwrap();
        for tracked in [true, false] {
            assert!(svc
                .apply_inbound_setting("old", "peer", &event, tracked)
                .is_err());
            assert!(svc
                .apply_inbound_setting("current", "other", &event, tracked)
                .is_err());
            assert!(svc
                .apply_inbound_setting("current", "peer", &event, tracked)
                .is_err());
            assert_eq!(svc.key_mode(), KeyMode::VirtualKey);
            assert_eq!(
                svc.apply_inbound_setting(
                    "current",
                    "peer",
                    &setting_event("quality", "smooth").unwrap(),
                    tracked
                )
                .unwrap(),
                "smooth"
            );
        }
    }

    #[test]
    fn legacy_unknown_key_mode_falls_back_but_tracked_is_rejected() {
        let svc = service(super::super::protocol::Capability::Control);
        let unknown = InputEvent::SetKeyMode {
            mode: "unknown".into(),
        };
        svc.set_peer_key_mode(KeyMode::ScanCode);
        assert!(svc
            .apply_inbound_setting("current", "peer", &unknown, true)
            .is_err());
        assert_eq!(svc.key_mode(), KeyMode::ScanCode);
        assert_eq!(
            svc.apply_inbound_setting("current", "peer", &unknown, false)
                .unwrap(),
            "type"
        );
        assert_eq!(svc.key_mode(), KeyMode::VirtualKey);
    }

    #[tokio::test]
    async fn missing_send_channel_is_failure_and_teardown_cancels_waiters() {
        let svc = service(super::super::protocol::Capability::Control);
        svc.inner.lock().unwrap().session.as_mut().unwrap().phase = SessionPhase::OutboundActive;
        assert!(svc
            .apply_setting("current", "quality", "sharp")
            .await
            .is_err());
        assert!(svc.settings.0.lock().unwrap().is_empty());
        let (_, receiver) = svc.settings.begin("current", "quality", "sharp").unwrap();
        svc.clear_outbound_link().await;
        assert!(receiver.await.unwrap().is_err());
        assert!(svc.settings.0.lock().unwrap().is_empty());
    }

    #[test]
    fn validates_only_known_values_and_preserves_legacy_json() {
        for (key, value) in [
            ("quality", "auto"),
            ("quality", "fps165"),
            ("audio", "off"),
            ("key_mode", "direct"),
        ] {
            let event = setting_event(key, value).unwrap();
            let mut json = serde_json::to_value(&event).unwrap();
            json["request_id"] = "receipt-1".into();
            let legacy: InputEvent = serde_json::from_value(json).unwrap();
            assert_eq!(event_setting(&legacy), Some((key, value)));
        }
        for (key, value) in [
            ("quality", "unknown"),
            ("audio", "true"),
            ("key_mode", "unknown"),
            ("other", "on"),
        ] {
            assert!(setting_event(key, value).is_err());
        }
    }

    #[tokio::test]
    async fn receipt_is_scoped_to_session_request_key_and_value() {
        let tracker = SettingTracker::default();
        let (id, mut receiver) = tracker.begin("new", "quality", "sharp").unwrap();
        let mut frame = serde_json::json!({"request_id":id,"key":"quality","value":"sharp","status":"accepted"});
        tracker.resolve("old", &frame);
        frame["key"] = "audio".into();
        tracker.resolve("new", &frame);
        frame["key"] = "quality".into();
        frame["value"] = "balanced".into();
        tracker.resolve("new", &frame);
        assert!(matches!(
            receiver.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        frame["value"] = "sharp".into();
        tracker.resolve("new", &frame);
        assert_eq!(receiver.await.unwrap().unwrap(), "sharp");
        tracker.resolve("new", &frame); // A duplicate cannot resurrect a completed request.
        assert!(tracker.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn pending_bound_cancel_and_rejection_do_not_report_success() {
        let tracker = SettingTracker::default();
        let mut receivers = vec![];
        for _ in 0..MAX_PENDING {
            receivers.push(tracker.begin("s", "audio", "on").unwrap().1);
        }
        assert!(tracker.begin("s", "audio", "on").is_err());
        tracker.clear();
        for receiver in receivers {
            assert!(receiver.await.unwrap().is_err());
        }
        let (id, receiver) = tracker.begin("s", "audio", "on").unwrap();
        tracker.resolve("s", &serde_json::json!({"request_id":id,"key":"audio","status":"rejected","error":"unsupported"}));
        assert_eq!(receiver.await.unwrap(), Err("unsupported".into()));
    }

    #[tokio::test]
    async fn timeout_or_cancel_releases_tracker_and_late_receipt_is_ignored() {
        let tracker = SettingTracker::default();
        let (id, receiver) = tracker.begin("s", "audio", "on").unwrap();
        let registration = Registration {
            tracker: &tracker,
            id: id.clone(),
        };
        assert!(tokio::time::timeout(Duration::from_millis(1), receiver)
            .await
            .is_err());
        drop(registration);
        tracker.resolve(
            "s",
            &serde_json::json!({"request_id":id,"key":"audio","value":"on","status":"accepted"}),
        );
        assert!(tracker.0.lock().unwrap().is_empty());
    }
}
