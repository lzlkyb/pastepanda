//! Status uses the same epoch as captured media, excluding encoder preparation.
use std::time::Instant;

pub fn elapsed_ms(started:Instant,ready:bool,paused_total_ms:u64,paused_since:Option<Instant>,now:Instant)->u64 {
    if !ready {return 0;}
    let mut elapsed=now.saturating_duration_since(started).as_millis() as u64;
    if let Some(paused)=paused_since {
        elapsed=elapsed.saturating_sub(now.saturating_duration_since(paused).as_millis() as u64);
    }
    elapsed.saturating_sub(paused_total_ms)
}

pub fn begin(started:&mut Instant,ready:&mut bool,paused_total_ms:&mut u64,paused_since:&mut Option<Instant>,now:Instant) {
    *started=now;
    *ready=true;
    *paused_total_ms=0;
    if paused_since.is_some() {*paused_since=Some(now);}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn preparing_encoder_does_not_count_as_recorded_media() {
        let started=Instant::now();
        assert_eq!(elapsed_ms(started,false,0,None,started+Duration::from_secs(5)),0);
        assert_eq!(elapsed_ms(started,true,0,None,started+Duration::from_secs(5)),5000);
    }

    #[test]
    fn pause_before_capture_is_rebased_without_negative_or_jumping_time() {
        let queued=Instant::now();
        let mut started=queued;
        let mut ready=false;
        let mut paused_total=100;
        let mut paused_since=Some(queued+Duration::from_millis(50));
        let capture=queued+Duration::from_secs(5);
        begin(&mut started,&mut ready,&mut paused_total,&mut paused_since,capture);
        assert!(ready);
        assert_eq!(elapsed_ms(started,ready,paused_total,paused_since,capture+Duration::from_millis(200)),0);
        paused_total=200;
        paused_since=None;
        assert_eq!(elapsed_ms(started,ready,paused_total,paused_since,capture+Duration::from_millis(300)),100);
    }
}
