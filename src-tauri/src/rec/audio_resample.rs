//! Streaming stereo interpolation: keep the boundary sample as well as phase.
#[derive(Default)]
pub struct LinearResampler {
    phase: f64,
    tail: Option<[i16; 2]>,
}

impl LinearResampler {
    pub fn process(&mut self, input: &[i16], from_sr: u32, to_sr: u32) -> Vec<i16> {
        if input.is_empty() || from_sr == 0 || to_sr == 0 { return Vec::new(); }
        if from_sr == to_sr { return input.to_vec(); }
        let mut samples = Vec::with_capacity(input.len() + 2);
        if let Some(tail) = self.tail { samples.extend_from_slice(&tail); }
        samples.extend_from_slice(input);
        let frames = samples.len() / 2;
        if frames == 0 { return Vec::new(); }
        let step = f64::from(from_sr) / f64::from(to_sr);
        let mut output = Vec::with_capacity(((frames as f64 / step).ceil() as usize) * 2);
        while self.phase + 1.0 < frames as f64 {
            let index = self.phase.floor() as usize;
            let fraction = (self.phase - index as f64) as f32;
            for channel in 0..2 {
                let left = f32::from(samples[index * 2 + channel]);
                let right = f32::from(samples[(index + 1) * 2 + channel]);
                output.push((left + (right - left) * fraction) as i16);
            }
            self.phase += step;
        }
        // Keep the last input frame for interpolation with the next packet.
        self.phase -= (frames - 1) as f64;
        self.tail = Some([samples[(frames - 1) * 2], samples[(frames - 1) * 2 + 1]]);
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packet_boundaries_do_not_change_stream_duration_or_waveform() {
        let input: Vec<i16> = (0..44100).flat_map(|i| [(i%30000) as i16, -(i%30000) as i16]).collect();
        for (from, to) in [(44100,48000),(48000,44100)] {
            let whole = LinearResampler::default().process(&input,from,to);
            let mut resampler = LinearResampler::default();
            let split: Vec<i16> = input.chunks(882).flat_map(|chunk| resampler.process(chunk,from,to)).collect();
            assert!(whole.len().abs_diff(split.len())<=2);
            assert!(whole.iter().zip(&split).all(|(a,b)| a.abs_diff(*b)<=1));
        }
    }
}
