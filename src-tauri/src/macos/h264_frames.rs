//! Software H.264 frame source, used when the Mac system decoder fails.
use openh264::decoder::Decoder;
use openh264_sys2::{
    videoFormatI420, SBufferInfo, DECODER_OPTION_NUM_OF_FRAMES_REMAINING_IN_BUFFER,
};
use std::{collections::BTreeMap, fs::File, io::BufReader, path::Path};
struct Picture {
    time: f64,
    w: u32,
    h: u32,
    rgba: Vec<u8>,
}
pub(super) struct Frames {
    reader: mp4::Mp4Reader<BufReader<File>>,
    track: u32,
    index: u32,
    count: u32,
    timescale: u32,
    nal_length: usize,
    parameters: Vec<u8>,
    decoder: Decoder,
    current: Option<Picture>,
    next: Option<Picture>,
    eof: bool,
    pending: BTreeMap<u64, Picture>,
    decoded_eof: bool,
    pub duration: f64,
}
fn annex_b(data: &[u8], length: usize) -> Result<Vec<u8>, String> {
    if !(1..=4).contains(&length) || data.len() > 32 * 1024 * 1024 {
        return Err("H.264 数据尺寸无效".into());
    }
    let mut output = Vec::with_capacity(data.len());
    let mut at = 0;
    while at < data.len() {
        if data.len() - at < length {
            return Err("H.264 长度字段不完整".into());
        }
        let mut n = 0usize;
        for b in &data[at..at + length] {
            n = (n << 8) | usize::from(*b);
        }
        at += length;
        if n == 0 || n > data.len() - at {
            return Err("H.264 视频帧不完整".into());
        }
        output.extend_from_slice(&[0, 0, 0, 1]);
        output.extend_from_slice(&data[at..at + n]);
        at += n;
    }
    Ok(output)
}
impl Frames {
    pub fn open(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| e.to_string())?;
        let len = file.metadata().map_err(|e| e.to_string())?.len();
        let reader = mp4::Mp4Reader::read_header(BufReader::new(file), len)
            .map_err(|e| format!("MP4 读取失败：{e}"))?;
        let (&id, track) = reader
            .tracks()
            .iter()
            .find(|(_, t)| t.trak.mdia.minf.stbl.stsd.avc1.is_some())
            .ok_or("系统解码器不可用，软件后备目前支持 H.264；HEVC 请使用高清/标准/流畅档重录")?;
        let avcc = &track
            .trak
            .mdia
            .minf
            .stbl
            .stsd
            .avc1
            .as_ref()
            .ok_or("缺少 H.264 参数")?
            .avcc;
        let mut parameters = Vec::new();
        for n in avcc
            .sequence_parameter_sets
            .iter()
            .chain(avcc.picture_parameter_sets.iter())
        {
            if n.bytes.len() > 65536 {
                return Err("H.264 参数超出限制".into());
            }
            parameters.extend_from_slice(&[0, 0, 0, 1]);
            parameters.extend_from_slice(&n.bytes);
        }
        let count = track.sample_count();
        let timescale = track.timescale();
        let nal_length = usize::from(avcc.length_size_minus_one) + 1;
        let duration = reader.duration().as_secs_f64();
        if count == 0 || timescale == 0 || parameters.is_empty() {
            return Err("视频轨参数无效".into());
        }
        let decoder = Decoder::new().map_err(|e| format!("H.264 软件解码器初始化失败：{e}"))?;
        Ok(Self {
            reader,
            track: id,
            index: 1,
            count,
            timescale,
            nal_length,
            parameters,
            decoder,
            current: None,
            next: None,
            eof: false,
            duration,
            pending: BTreeMap::new(),
            decoded_eof: false,
        })
    }
    fn decode_picture(&mut self) -> Result<Option<Picture>, String> {
        loop {
            let mut planes = [std::ptr::null_mut(); 3];
            let mut info = SBufferInfo::default();
            let code = if self.index <= self.count {
                let sample = self
                    .reader
                    .read_sample(self.track, self.index)
                    .map_err(|e| e.to_string())?
                    .ok_or("MP4 视频帧缺失")?;
                let pts =
                    (i128::from(sample.start_time) + i128::from(sample.rendering_offset)).max(0);
                info.uiInBsTimeStamp = (pts * 1000 / i128::from(self.timescale)) as u64;
                let mut packet = if self.index == 1 {
                    self.parameters.clone()
                } else {
                    Vec::new()
                };
                packet.extend_from_slice(&annex_b(&sample.bytes, self.nal_length)?);
                self.index += 1;
                unsafe {
                    self.decoder.raw_api().decode_frame_no_delay(
                        packet.as_ptr(),
                        packet.len() as i32,
                        planes.as_mut_ptr(),
                        &mut info,
                    )
                }
            } else {
                let mut remaining = 0i32;
                let code = unsafe {
                    self.decoder.raw_api().get_option(
                        DECODER_OPTION_NUM_OF_FRAMES_REMAINING_IN_BUFFER,
                        (&mut remaining as *mut i32).cast(),
                    )
                };
                if code != 0 {
                    return Err(format!("H.264 缓冲查询失败：{code}"));
                }
                if remaining <= 0 {
                    return Ok(None);
                }
                unsafe {
                    self.decoder
                        .raw_api()
                        .flush_frame(planes.as_mut_ptr(), &mut info)
                }
            };
            if code != 0 {
                return Err(format!("H.264 软件解码失败：{code}"));
            }
            if info.iBufferStatus == 0 {
                continue;
            }
            let layout = unsafe { info.UsrData.sSystemBuffer };
            let (w, h) = (layout.iWidth, layout.iHeight);
            if w < 2
                || h < 2
                || w % 2 != 0
                || h % 2 != 0
                || i64::from(w) * i64::from(h) > 40_000_000
                || layout.iFormat != videoFormatI420 as i32
                || layout.iStride[0] < w
                || layout.iStride[1] < (w + 1) / 2
                || planes.iter().any(|p| p.is_null())
            {
                return Err("H.264 解码图像尺寸或格式无效".into());
            }
            let (w, h, ys, uvs) = (
                w as usize,
                h as usize,
                layout.iStride[0] as usize,
                layout.iStride[1] as usize,
            );
            if ys * h > 128 * 1024 * 1024 || uvs * h.div_ceil(2) > 64 * 1024 * 1024 {
                return Err("H.264 解码图像超出限制".into());
            }
            let y = unsafe { std::slice::from_raw_parts(planes[0], ys * h) };
            let u = unsafe { std::slice::from_raw_parts(planes[1], uvs * h.div_ceil(2)) };
            let v = unsafe { std::slice::from_raw_parts(planes[2], uvs * h.div_ceil(2)) };
            let tw = w.min(480);
            let th = (h * tw / w).max(1);
            if th > 4096 {
                return Err("GIF 高度超出限制".into());
            }
            let mut rgba = vec![0; tw * th * 4];
            for oy in 0..th {
                for ox in 0..tw {
                    let sx = ox * w / tw;
                    let sy = oy * h / th;
                    let yy = (i32::from(y[sy * ys + sx]) - 16).max(0);
                    let uu = i32::from(u[(sy / 2) * uvs + sx / 2]) - 128;
                    let vv = i32::from(v[(sy / 2) * uvs + sx / 2]) - 128;
                    let at = (oy * tw + ox) * 4;
                    rgba[at] = ((298 * yy + 409 * vv + 128) >> 8).clamp(0, 255) as u8;
                    rgba[at + 1] =
                        ((298 * yy - 100 * uu - 208 * vv + 128) >> 8).clamp(0, 255) as u8;
                    rgba[at + 2] = ((298 * yy + 516 * uu + 128) >> 8).clamp(0, 255) as u8;
                    rgba[at + 3] = 255;
                }
            }
            return Ok(Some(Picture {
                time: info.uiOutYuvTimeStamp as f64 / 1000.0,
                w: tw as u32,
                h: th as u32,
                rgba,
            }));
        }
    }
    // H.264 may decode B frames out of presentation order. Keep a bounded
    // lookahead (larger than the 16-picture DPB) and yield timestamp order.
    fn read_picture(&mut self) -> Result<Option<Picture>, String> {
        while self.pending.len() < 32 && !self.decoded_eof {
            match self.decode_picture()? {
                Some(picture) => {
                    self.pending
                        .insert((picture.time * 1000.0).round() as u64, picture);
                }
                None => self.decoded_eof = true,
            }
        }
        Ok(self.pending.pop_first().map(|(_, picture)| picture))
    }
    pub fn at(&mut self, time: f64) -> Result<(u32, u32, Vec<u8>), String> {
        if self.next.is_none() && !self.eof {
            self.next = self.read_picture()?;
            self.eof = self.next.is_none();
        }
        while self.next.as_ref().is_some_and(|p| p.time <= time) || self.current.is_none() {
            let Some(next) = self.next.take() else {
                break;
            };
            if self.current.as_ref().is_some_and(|p| p.time > next.time) {
                return Err("H.264 图像时间顺序无效".into());
            }
            self.current = Some(next);
            self.next = self.read_picture()?;
            self.eof = self.next.is_none();
        }
        let frame = self.current.as_ref().ok_or("H.264 视频没有可解码画面")?;
        Ok((frame.w, frame.h, frame.rgba.clone()))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nal_lengths_reject_truncated_and_oversized_data() {
        assert!(annex_b(&[0, 0, 0], 4).is_err());
        assert!(annex_b(&[0, 0, 0, 5, 1], 4).is_err());
        assert_eq!(
            annex_b(&[0, 0, 0, 2, 0x65, 1], 4).unwrap(),
            [0, 0, 0, 1, 0x65, 1]
        );
    }
}
