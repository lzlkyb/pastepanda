//! Shared device truth and warnings; requested switches are not success flags.
#[derive(Clone)]
pub struct AudioHealth {
    pub sys_active: Option<bool>,
    pub mic_active: Option<bool>,
    pub warnings: Vec<String>,
}

impl AudioHealth {
    pub fn new(sys: bool, mic: bool) -> Self {
        Self { sys_active: (!sys).then_some(false), mic_active: (!mic).then_some(false), warnings: Vec::new() }
    }
    pub fn warn(&mut self, message: &str) {
        if !self.warnings.iter().any(|warning| warning == message) {
            self.warnings.push(message.into());
        }
    }
    pub fn unavailable(&mut self, system: bool, message: &str) {
        if system { self.sys_active = Some(false); } else { self.mic_active = Some(false); }
        self.warn(message);
    }
    pub fn disable_all(&mut self, message: &str) {
        self.sys_active = Some(false);
        self.mic_active = Some(false);
        self.warn(message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requested_devices_start_pending_and_failures_remain_visible() {
        let mut health = AudioHealth::new(true,false);
        assert_eq!(health.sys_active,None);
        assert_eq!(health.mic_active,Some(false));
        health.unavailable(true,"系统声音设备已断开");
        health.unavailable(true,"系统声音设备已断开");
        assert_eq!(health.sys_active,Some(false));
        assert_eq!(health.warnings,vec!["系统声音设备已断开"]);
    }
}
