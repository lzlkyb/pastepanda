//! Pixel and timing contracts shared by decoded GIF frames and regression tests.
pub fn bgra_to_rgba(pixels: &mut [u8]) {
    for pixel in pixels.chunks_exact_mut(4) { pixel.swap(0,2); pixel[3] = 255; }
}

pub fn frame_delays(start_100ns: i64, end_100ns: i64) -> impl Iterator<Item=u16> {
    // Round absolute boundaries, not each interval: 12fps must not become 12.5fps.
    let boundary=|t:i64| (t.max(0) as u64).saturating_add(50_000)/100_000;
    let units=boundary(end_100ns).saturating_sub(boundary(start_100ns)).max(1);
    let count=units.div_ceil(u64::from(u16::MAX));
    (0..count).map(move|index|(units-index*u64::from(u16::MAX)).min(u64::from(u16::MAX)) as u16)
}

pub fn packed_bgra(bytes:&[u8],width:u32,height:u32,stride:i32)->Result<Vec<u8>,String> {
    let row=(width as usize).checked_mul(4).ok_or("视频尺寸溢出")?;
    let pitch=stride.unsigned_abs() as usize;
    let total=pitch.checked_mul(height as usize).ok_or("视频帧大小溢出")?;
    if row==0 || height==0 || pitch<row || bytes.len()<total {return Err("解码帧不完整（尺寸/步幅不符）".into());}
    let mut packed=Vec::with_capacity(row*height as usize);
    for y in 0..height as usize {
        let source_y=if stride<0 {height as usize-1-y}else{y};
        packed.extend_from_slice(&bytes[source_y*pitch..source_y*pitch+row]);
    }
    Ok(packed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn red_and_blue_survive_bgra_to_gif_rgba() {
        let mut colors = [0,0,255,0, 255,0,0,0];
        bgra_to_rgba(&mut colors);
        assert_eq!(colors,[255,0,0,255, 0,0,255,255]);
    }
    #[test]
    fn sparse_samples_and_12fps_keep_wall_clock_duration() {
        assert_eq!(frame_delays(0,20_000_000).map(u64::from).sum::<u64>(),200);
        let total:u64=(0..120).flat_map(|i|frame_delays(i*10_000_000/12,(i+1)*10_000_000/12)).map(u64::from).sum();
        assert_eq!(total,1000,"120 frames at 12fps are ten seconds");
        let long:Vec<_>=frame_delays(0,7_000_000_000).collect();
        assert!(long.len()>1);
        assert_eq!(long.iter().map(|n|u64::from(*n)).sum::<u64>(),70_000);
    }

    #[test]
    fn padded_bottom_up_frames_use_negotiated_stride() {
        assert_eq!(packed_bgra(&[1,2,3,4,0,0,0,0,5,6,7,8,0,0,0,0],1,2,-8).unwrap(),vec![5,6,7,8,1,2,3,4]);
        assert!(packed_bgra(&[0;8],2,2,8).is_err());
    }
}
