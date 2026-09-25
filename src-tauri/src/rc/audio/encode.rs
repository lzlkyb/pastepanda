//! AAC 编码器（Media Foundation）与 ADTS/ASC 头。

use super::*;

pub struct AacPacket {
    pub pts_ms: u64,
    pub data: Vec<u8>,
}

pub struct AacEncoder {
    /// COM 引用。`release_com` 里**先**置空再 `CoUninitialize`（同 `dxgi.rs::drop_com`）。
    transform: Option<IMFTransform>,
    /// 协商好的输出类型里读出的 AudioSpecificConfig（头部 JSON 用）。
    asc: Vec<u8>,
    sr: u32,
    /// 已喂入的**每声道**采样计数（pts 的时间轴）。
    samples_in: u64,
    /// 凑满 1024×ch 的输入蓄水池（s16 interleaved stereo）。
    acc: Vec<i16>,
    /// 输出缓冲字节数（GetOutputStreamInfo）。
    out_size: u32,
    com_owned: bool,
}

pub(in crate::rc) fn mf_err(e: windows::core::Error) -> String {
    format!("MF：{e}")
}

impl AacEncoder {
    /// 打开收件箱 AAC 编码器。`sr` 跟设备混音格式（不重采样）；
    /// `ch` 恒为 2（采集侧已缩混）。打不开（枚举为空/类型协商失败）返回 Err，
    /// 调用方禁用音频——绝不能因此影响视频会话。
    pub fn open(sr: u32) -> Result<Self, String> {
        unsafe {
            let com_owned = CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED)
                .is_ok();
            crate::rc::encode_h264::ensure_mf_startup()?;

            let in_info = MFT_REGISTER_TYPE_INFO {
                guidMajorType: MFMediaType_Audio,
                guidSubtype: MFAudioFormat_PCM,
            };
            let out_info = MFT_REGISTER_TYPE_INFO {
                guidMajorType: MFMediaType_Audio,
                guidSubtype: MFAudioFormat_AAC,
            };
            let transform = create_aac_mft(&in_info, &out_info)?;

            // 输入：s16 PCM interleaved stereo
            let in_type = MFCreateMediaType().map_err(mf_err)?;
            in_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(mf_err)?;
            in_type.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM).map_err(mf_err)?;
            in_type.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, sr).map_err(mf_err)?;
            in_type.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, CHANNELS).map_err(mf_err)?;
            in_type.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(mf_err)?;
            in_type
                .SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, CHANNELS * 2)
                .map_err(mf_err)?;
            in_type
                .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, sr * CHANNELS * 2)
                .map_err(mf_err)?;
            transform.SetInputType(0, &in_type, 0).map_err(mf_err)?;

            // 输出：从「可用输出类型」里挑 sr/ch 匹配的——收件箱编码器的
            // AAC 专用字段（PayloadType 等）由它自己填，自建类型协商不过。
            let mut chosen: Option<IMFMediaType> = None;
            for idx in 0..64u32 {
                let Ok(t) = transform.GetOutputAvailableType(0, idx) else {
                    break;
                };
                let ok_sr =
                    t.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).unwrap_or(0) == sr;
                let ok_ch =
                    t.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).unwrap_or(0) == CHANNELS;
                if ok_sr && ok_ch {
                    chosen = Some(t);
                    break;
                }
            }
            let out_type = chosen.ok_or_else(|| format!("AAC 编码器没有 {sr}Hz 立体声输出类型"))?;
            // 尽力抬码率到 128k（可用类型带的是默认档）；失败只 warn
            if let Err(e) = out_type.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, BITRATE_BPS / 8) {
                log::warn!("[RC] AAC 码率设置失败（用默认档）：{e}");
            }
            transform.SetOutputType(0, &out_type, 0).map_err(mf_err)?;

            // PayloadType 必须 0（裸 AAC 帧）；ADTS 流前端 description 对不上
            let payload = out_type.GetUINT32(&MF_MT_AAC_PAYLOAD_TYPE).unwrap_or(0);
            if payload != 0 {
                return Err(format!("AAC PayloadType={payload}（只支持 0=裸帧）"));
            }
            // AudioSpecificConfig（前端 description）。0.58 无 MF_MT_AAC_* 常量，
            // 直接按 AOT/采样率表/声道构造——AAC-LC 的 ASC 是确定性位串。
            let asc = asc_for(sr, CHANNELS)
                .ok_or_else(|| format!("ASC 构造失败：{sr}Hz 不在 AAC 标准采样率表内"))?;

            // 输出缓冲尺寸（自备 sample 用）。收件箱 AAC 是同步 MFT，不带分配器。
            let info = transform.GetOutputStreamInfo(0).map_err(mf_err)?;

            log::info!(
                "[RC] AAC 编码器已开：{sr}Hz 立体声 {}kbps，ASC {} 字节",
                BITRATE_BPS / 1000,
                asc.len()
            );
            Ok(Self {
                transform: Some(transform),
                asc,
                sr,
                samples_in: 0,
                acc: Vec::new(),
                out_size: info.cbSize.max(1),
                com_owned,
            })
        }
    }

    pub fn cfg(&self) -> AudioCfg {
        AudioCfg {
            sr: self.sr,
            ch: CHANNELS,
            asc: self.asc.clone(),
            br: BITRATE_BPS / 1000,
        }
    }

    /// 设定 pts 时间轴基点（P2-6）：编码器重开（编码失败 / 设备切换）时，
    /// worker 把**本会话累计喂过的帧数**传进来——原先重开即归零，
    /// 对端 WebCodecs 的播放时间轴突然倒退，表现为声音卡顿/重播。
    pub fn set_sample_offset(&mut self, total_frames: u64) {
        self.samples_in = total_frames;
    }

    /// 喂一段 s16 立体声 interleaved 采样，取回编出的 AAC 帧。
    /// 内部凑满 1024×2 才提交；不满的留在蓄水池。
    pub fn encode(&mut self, pcm: &[i16]) -> Result<Vec<AacPacket>, String> {
        self.acc.extend_from_slice(pcm);
        let frame_vals = AAC_SAMPLES_PER_FRAME * CHANNELS as usize;
        let mut out = Vec::new();
        while self.acc.len() >= frame_vals {
            let chunk: Vec<i16> = self.acc.drain(..frame_vals).collect();
            let pts_ms = (self.samples_in * 1000) / self.sr.max(1) as u64;
            self.samples_in += AAC_SAMPLES_PER_FRAME as u64;
            out.extend(self.submit(&chunk, pts_ms)?);
        }
        Ok(out)
    }

    fn submit(&mut self, chunk: &[i16], pts_ms: u64) -> Result<Vec<AacPacket>, String> {
        unsafe {
            let bytes: Vec<u8> = chunk.iter().flat_map(|v| v.to_le_bytes()).collect();
            let buf = MFCreateMemoryBuffer(bytes.len() as u32).map_err(mf_err)?;
            {
                let mut p: *mut u8 = std::ptr::null_mut();
                let mut max = 0u32;
                let mut cur = 0u32;
                buf.Lock(&mut p, Some(&mut max), Some(&mut cur)).map_err(mf_err)?;
                if !p.is_null() {
                    std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
                }
                buf.SetCurrentLength(bytes.len() as u32).map_err(mf_err)?;
                buf.Unlock().map_err(mf_err)?;
            }
            let sample = MFCreateSample().map_err(mf_err)?;
            sample.AddBuffer(&buf).map_err(mf_err)?;
            let t100 = (self.samples_in as i64 - AAC_SAMPLES_PER_FRAME as i64) * 10_000_000
                / self.sr.max(1) as i64;
            sample.SetSampleTime(t100).map_err(mf_err)?;
            sample
                .SetSampleDuration(AAC_SAMPLES_PER_FRAME as i64 * 10_000_000 / self.sr.max(1) as i64)
                .map_err(mf_err)?;
            self.transform
                .as_ref()
                .ok_or_else(|| "AAC 编码器已释放".to_string())?
                .ProcessInput(0, &sample, 0)
                .map_err(mf_err)?;

            let mut out = Vec::new();
            loop {
                // 自备输出 sample（收件箱 AAC 是同步 MFT，不自带分配器）：
                // 同一个 sample 反复提交——MFT 每轮把新帧写进它的缓冲。
                let provided = MFCreateSample().map_err(mf_err)?;
                let obuf = MFCreateMemoryBuffer(self.out_size).map_err(mf_err)?;
                provided.AddBuffer(&obuf).map_err(mf_err)?;
                let odb = MFT_OUTPUT_DATA_BUFFER {
                    dwStreamID: 0,
                    pSample: std::mem::ManuallyDrop::new(Some(provided.clone())),
                    dwStatus: 0,
                    pEvents: std::mem::ManuallyDrop::new(None),
                };
                let mut status = 0u32;
                let mut outs = [odb];
                let Some(transform) = self.transform.as_ref() else {
                    return Err("AAC 编码器已释放".into());
                };
                let res = transform.ProcessOutput(0, &mut outs, &mut status);
                // 🔴 再审计 A6（2026-09-25）：windows-rs 把 pSample/pEvents 标成
                // ManuallyDrop，成功与否都要手动 drop——不 drop 就每轮泄漏一个
                // IMFSample + MediaBuffer 引用（约 43-46 帧/秒，数小时会话累积
                // 数百 MB）。出错的轮次 MFT 不碰这两个字段，仍归我们所有。
                std::mem::ManuallyDrop::drop(&mut outs[0].pSample);
                std::mem::ManuallyDrop::drop(&mut outs[0].pEvents);
                match res {
                    Ok(()) => {}
                    Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => break,
                    Err(e) => return Err(format!("ProcessOutput：{e}")),
                }
                if let Ok(buf) = provided.ConvertToContiguousBuffer() {
                    if let Ok(bytes) = lock_buffer(&buf) {
                        if !bytes.is_empty() {
                            out.push(AacPacket { pts_ms, data: bytes });
                        }
                    }
                }
            }
            Ok(out)
        }
    }
}

impl AacEncoder {
    /// 🔴 必须先放掉所有 COM 引用再 `CoUninitialize`，顺序反了就是悬垂释放
    /// （同 `dxgi.rs::drop_com` / `encode_h264.rs::release_com`）。
    fn release_com(&mut self) {
        if let Some(t) = self.transform.as_ref() {
            unsafe {
                let _ = t.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            }
        }
        self.transform = None;
        if self.com_owned {
            unsafe { windows::Win32::System::Com::CoUninitialize() };
            self.com_owned = false;
        }
    }
}

impl Drop for AacEncoder {
    fn drop(&mut self) {
        self.release_com();
    }
}

/// 由采样率/声道构造 AAC AudioSpecificConfig（AAC-LC）。
///
/// windows 0.58 没带 `MF_MT_AAC_AUDIO_SPECIFIC_DATA` 常量，而 ASC 本身是
/// 确定性位串（MSB 起）：AOT(5)=2(LC) | 采样率表序号(4) | 声道数(4) |
/// frameLen/dependsOnCoreCoder/extensionFlag 三个 0 → 正好 16 位两字节。
/// 对拍已知值：44.1k 立体声 = `0x12 0x10`（经典 "1210"）、48k 立体声 = `0x11 0x90`。
/// 采样率不在 ISO 14496-3 表 1.9 内（显式 24 位写法）不支持——收件箱 AAC
/// 编码器本身也只收表内采样率，SetInputType 会先一步失败。
pub(in crate::rc) fn asc_for(sr: u32, ch: u32) -> Option<Vec<u8>> {
    const FREQ_INDEX: [(u32, u32); 12] = [
        (96000, 0),
        (88200, 1),
        (64000, 2),
        (48000, 3),
        (44100, 4),
        (32000, 5),
        (24000, 6),
        (22050, 7),
        (16000, 8),
        (12000, 9),
        (11025, 10),
        (8000, 11),
    ];
    let idx = FREQ_INDEX.iter().find(|(f, _)| *f == sr)?.1;
    if ch == 0 || ch > 15 {
        return None;
    }
    let word: u16 = (2u16 << 11) | ((idx as u16) << 7) | ((ch as u16) << 3); // AOT=2 (AAC-LC)
    Some(vec![(word >> 8) as u8, (word & 0xFF) as u8])
}

unsafe fn lock_buffer(buf: &IMFMediaBuffer) -> Result<Vec<u8>, String> {
    let mut p: *mut u8 = std::ptr::null_mut();
    let mut max = 0u32;
    let mut cur = 0u32;
    buf.Lock(&mut p, Some(&mut max), Some(&mut cur)).map_err(mf_err)?;
    let n = if cur > 0 { cur as usize } else { max as usize };
    let mut out = vec![0u8; n];
    if !p.is_null() && n > 0 {
        std::ptr::copy_nonoverlapping(p, out.as_mut_ptr(), n);
    }
    buf.Unlock().map_err(mf_err)?;
    Ok(out)
}

/// 枚举收件箱 AAC 编码器（同步软件 MFT）。优先 SYNCMFT，兜底 ALL。
unsafe fn create_aac_mft(
    in_info: &MFT_REGISTER_TYPE_INFO,
    out_info: &MFT_REGISTER_TYPE_INFO,
) -> Result<IMFTransform, String> {
    for flags in [MFT_ENUM_FLAG_SYNCMFT, MFT_ENUM_FLAG_ALL] {
        let mut count = 0u32;
        let mut acts: *mut Option<IMFActivate> = std::ptr::null_mut();
        let _ = MFTEnumEx(
            MFT_CATEGORY_AUDIO_ENCODER,
            flags,
            Some(in_info),
            Some(out_info),
            &mut acts,
            &mut count,
        );
        if count > 0 && !acts.is_null() {
            let slice = std::slice::from_raw_parts(acts, count as usize);
            let first = slice[0].clone().ok_or("MFT activate 为空")?;
            CoTaskMemFree(Some(acts as _));
            return first
                .ActivateObject::<IMFTransform>()
                .map_err(|e| format!("ActivateObject(AAC)：{e}"));
        }
        if !acts.is_null() {
            CoTaskMemFree(Some(acts as _));
        }
    }
    Err("无 AAC 编码 MFT（收件箱缺失）".into())
}

// ── WASAPI 环回采集 ────────────────────────────────────────────────────
