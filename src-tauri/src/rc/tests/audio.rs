// ── G3 音频：三因子与跨会话保持 ───────────────────────────────────────

#![cfg(target_os = "windows")]

use super::store;
use crate::rc::service::{PeerHostAudio, RcService};

/// 音频出不出声 = 对端申请了 && 对端此刻没关 && **本机没静音**，三者取与。
///
/// 这段语义最容易被后续改动悄悄改错（例如把「本机静音」实现成对端开关的另一个
/// 镜像），所以逐组合钉死——尤其「本机静音后，对端再关再开也解不开」这条。
#[test]
fn audio_wanted_三因子() {
    let svc = RcService::new(store());
    // 默认全否：对端没申请 → 不出声
    assert!(!svc.audio_wanted());

    // 对端申请了、双方都开着 → 出声
    svc.audio_set_peer_wants(true);
    assert!(svc.audio_wanted());

    // 对端在会话里关掉自己 → 不出声；关回去 → 恢复
    svc.set_audio_muted(true);
    assert!(!svc.audio_wanted());
    svc.set_audio_muted(false);
    assert!(svc.audio_wanted());

    // 本机静音 → 一票否决（对端开着也不出声）
    svc.set_audio_local_mute(true);
    assert!(!svc.audio_wanted());
    assert!(svc.audio_local_mute());

    // 🔴 对端再关一次又开回来，仍然不出声——本机的否决不由对端动作解开
    svc.set_audio_muted(true);
    svc.set_audio_muted(false);
    assert!(!svc.audio_wanted(), "本机静音只有本机能解");

    // 本机自己恢复 → 才出声
    svc.set_audio_local_mute(false);
    assert!(svc.audio_wanted());
}

/// 本机静音**跨会话保持**：`audio_reset` 收口的是对端申请位 / 对端开关 / 收流缓冲，
/// 不该顺手把用户的隐私开关解开（那等于每来一个人就自动放行一次）。
#[test]
fn 本机静音跨会话保持() {
    let svc = RcService::new(store());
    svc.audio_set_peer_wants(true);
    svc.set_audio_local_mute(true);

    svc.audio_reset();

    assert!(!svc.audio_peer_wants(), "对端申请位该被会话收口清掉");
    assert!(
        svc.audio_local_mute(),
        "本机静音不该被会话收口解开（隐私开关不做自动回退）"
    );
    assert!(!svc.audio_wanted(), "收口后没有新申请，仍不出声");
}

/// G3-B：对端报来的主机音频状态是**本会话**的事实，会话收口即作废——
/// 不然下一场会话会带着上一场的「对方已静音」显示出来（对端可能早就改回来了）。
#[test]
fn 对端音频状态随会话收口作废() {
    let svc = RcService::new(store());
    assert!(svc.peer_host_audio().is_none(), "默认没收到过（旧对端也恒 None）");

    svc.set_peer_host_audio(PeerHostAudio {
        local_mute: true,
        spk_mute: true,
        err: None,
    });
    let got = svc.peer_host_audio().expect("刚写入的该读得到");
    assert!(got.local_mute && got.spk_mute);

    svc.audio_reset();
    assert!(svc.peer_host_audio().is_none(), "会话收口要清，否则串到下一场");
}

/// G3-C：「对端静音了本机扬声器」的标记同样只属于本会话。
///
/// 它与「扬声器此刻是否静音」是两回事——本机用户自己按静音键**不会**置位
/// （我们不监听系统静音变化），所以它只回答「对端做过这个动作且没人撤销」，
/// 正是横幅提示与「恢复外放」按钮的显示条件。
#[test]
fn 对端静音标记只由对端动作驱动且随会话清掉() {
    let svc = RcService::new(store());
    assert!(!svc.spk_muted_by_peer(), "默认没有");

    svc.set_spk_muted_by_peer(true);
    assert!(svc.spk_muted_by_peer());
    // 本机一键恢复的语义 = 清掉标记（提示与按钮随之收起）
    svc.set_spk_muted_by_peer(false);
    assert!(!svc.spk_muted_by_peer());

    svc.set_spk_muted_by_peer(true);
    svc.audio_reset();
    assert!(!svc.spk_muted_by_peer(), "会话收口该清（那是本会话的事实）");
}
