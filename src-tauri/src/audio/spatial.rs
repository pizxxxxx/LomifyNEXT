use std::f32::consts::PI;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use biquad::{Biquad, Coefficients, DirectForm1, Hertz, ToHertz, Type, Q_BUTTERWORTH_F64};
use rodio::source::SeekError;
use rodio::Source;

use crate::audio::types::{ChannelCount, SampleRate, SpatialParams};

/// Ring buffer capacity for delay lines.
/// At 48 kHz, 32768 samples is ~682 ms, giving ample depth for large concert hall reflections.
const DELAY_CAP: usize = 32768;
const DELAY_MASK: usize = DELAY_CAP - 1;

/// Fractional-delay circular buffer for click-free acoustic reflection modeling.
struct DelayLine {
    buffer: Vec<f32>,
    write_pos: usize,
}

impl DelayLine {
    fn new() -> Self {
        Self {
            buffer: vec![0.0; DELAY_CAP],
            write_pos: 0,
        }
    }

    #[inline(always)]
    fn write(&mut self, sample: f32) {
        self.buffer[self.write_pos] = sample;
        self.write_pos = (self.write_pos + 1) & DELAY_MASK;
    }

    #[inline(always)]
    fn read_fractional(&self, delay_samples: f32) -> f32 {
        let d = delay_samples.clamp(0.0, (DELAY_CAP - 2) as f32);
        let d_int = d as usize;
        let frac = d - d_int as f32;

        let idx0 = (self.write_pos + DELAY_CAP - 1 - (d_int & DELAY_MASK)) & DELAY_MASK;
        let idx1 = (idx0 + DELAY_CAP - 1) & DELAY_MASK;

        let s0 = self.buffer[idx0];
        let s1 = self.buffer[idx1];
        s0 + frac * (s1 - s0)
    }

    fn clear(&mut self) {
        self.buffer.fill(0.0);
        self.write_pos = 0;
    }
}

/// 1-pole lowpass filter for sub-bass crossover, head shadow, and room damping.
#[derive(Clone, Copy)]
struct OnePoleLp {
    alpha: f32,
    state: f32,
}

impl OnePoleLp {
    fn new(cutoff_hz: f32, sample_rate: f32) -> Self {
        let dt = 1.0 / sample_rate.max(8000.0);
        let rc = 1.0 / (2.0 * PI * cutoff_hz.max(10.0));
        let alpha = (dt / (rc + dt)).clamp(0.0, 1.0);
        Self { alpha, state: 0.0 }
    }

    #[inline(always)]
    fn process(&mut self, input: f32) -> f32 {
        self.state += self.alpha * (input - self.state);
        self.state
    }

    fn set_cutoff(&mut self, cutoff_hz: f32, sample_rate: f32) {
        let dt = 1.0 / sample_rate.max(8000.0);
        let rc = 1.0 / (2.0 * PI * cutoff_hz.max(10.0));
        self.alpha = (dt / (rc + dt)).clamp(0.0, 1.0);
    }

    fn clear(&mut self) {
        self.state = 0.0;
    }
}

/// 1-pole highpass filter for Abbey Road reverb filtering (prevents room boom and bass boost).
#[derive(Clone, Copy)]
struct OnePoleHp {
    alpha: f32,
    prev_in: f32,
    prev_out: f32,
}

impl OnePoleHp {
    fn new(cutoff_hz: f32, sample_rate: f32) -> Self {
        let dt = 1.0 / sample_rate.max(8000.0);
        let rc = 1.0 / (2.0 * PI * cutoff_hz.max(10.0));
        let alpha = rc / (rc + dt);
        Self {
            alpha,
            prev_in: 0.0,
            prev_out: 0.0,
        }
    }

    #[inline(always)]
    fn process(&mut self, input: f32) -> f32 {
        let output = self.alpha * (self.prev_out + input - self.prev_in);
        self.prev_in = input;
        self.prev_out = output;
        output
    }

    fn clear(&mut self) {
        self.prev_in = 0.0;
        self.prev_out = 0.0;
    }
}

/// Schroeder all-pass diffuser for velvety, dense 3D acoustic diffusion.
struct Allpass {
    buffer: Vec<f32>,
    pos: usize,
    feedback: f32,
}

impl Allpass {
    fn new(delay_samples: usize, feedback: f32) -> Self {
        let cap = delay_samples.max(1);
        Self {
            buffer: vec![0.0; cap],
            pos: 0,
            feedback,
        }
    }

    #[inline(always)]
    fn process(&mut self, input: f32) -> f32 {
        let buf_val = self.buffer[self.pos];
        let v = input + self.feedback * buf_val;
        let output = buf_val - self.feedback * v;
        self.buffer[self.pos] = v;
        self.pos += 1;
        if self.pos >= self.buffer.len() {
            self.pos = 0;
        }
        output
    }

    fn clear(&mut self) {
        self.buffer.fill(0.0);
        self.pos = 0;
    }
}

/// Smooth soft-knee saturation curve to prevent harsh digital clipping on loud peaks.
#[inline(always)]
fn soft_limit(x: f32) -> f32 {
    if x > 0.85 {
        0.85 + (x - 0.85) / (1.0 + (x - 0.85).powi(2)).sqrt() * 0.15
    } else if x < -0.85 {
        -0.85 + (x + 0.85) / (1.0 + (x + 0.85).powi(2)).sqrt() * 0.15
    } else {
        x
    }
}

/// 3D Virtual Room & Spatial Audio Source.
///
/// Implements binaural head-shadow crossfeed, sub-bass preservation,
/// multi-tap early wall/ceiling room reflections scaled by `room_size`,
/// all-pass diffusion stages, mid/side spatial width enhancement,
/// acoustic decay tail feedback, and a subtle air-presence shelf.
pub struct SpatialSource<S: Source<Item = f32>> {
    source: S,
    params: Arc<RwLock<SpatialParams>>,
    channels: ChannelCount,
    sample_rate: SampleRate,
    current_channel: u16,
    sample_counter: u32,

    // Parameter smoothing to prevent clicks/pops:
    target_mix: f32,
    current_mix: f32,
    target_room_size: f32,
    current_room_size: f32,
    target_intensity: f32,
    current_intensity: f32,
    mix_smoothing: f32,
    param_smoothing: f32,
    bypassed: bool,

    // Delay lines:
    delay_l: DelayLine,
    delay_r: DelayLine,

    // Crossover & acoustic filters:
    bass_lp_l: OnePoleLp,
    bass_lp_r: OnePoleLp,
    reverb_hp_l: OnePoleHp,
    reverb_hp_r: OnePoleHp,
    head_shadow_l: OnePoleLp,
    head_shadow_r: OnePoleLp,
    room_damp_l: OnePoleLp,
    room_damp_r: OnePoleLp,

    // Schroeder all-pass diffusers:
    diffuser_l1: Allpass,
    diffuser_l2: Allpass,
    diffuser_r1: Allpass,
    diffuser_r2: Allpass,

    // Air / presence high-shelf filter:
    air_coeffs: Coefficients<f64>,
    air_filter_l: DirectForm1<f64>,
    air_filter_r: DirectForm1<f64>,

    // Pending second channel for stereo pair:
    pending_right: Option<f32>,
}

impl<S: Source<Item = f32>> SpatialSource<S> {
    pub fn new(source: S, params: Arc<RwLock<SpatialParams>>) -> Self {
        let sample_rate = source.sample_rate();
        let channels = source.channels();
        let sr_f32 = sample_rate.get() as f32;
        let fs: Hertz<f64> = (sample_rate.get() as f64).hz();

        let initial_params = params.read().ok().map(|p| *p).unwrap_or_default();
        let initial_mix = if initial_params.enabled { 1.0 } else { 0.0 };
        let initial_room = initial_params.room_size.clamp(0.0, 1.0);
        let initial_intensity = initial_params.intensity.clamp(0.0, 1.5);

        // High shelf (+2.5 dB at 9200 Hz) for a little air and openness:
        let air_coeffs = Coefficients::<f64>::from_params(
            Type::HighShelf(2.5),
            fs,
            9200.0.hz(),
            Q_BUTTERWORTH_F64,
        )
        .unwrap_or_else(|_| {
            Coefficients::<f64>::from_params(Type::PeakingEQ(0.0), fs, 1000.0.hz(), 1.0).unwrap()
        });

        // Asymmetric allpass diffuser lengths for dense stereo decorrelation:
        let d_l1 = (0.0047 * sr_f32).round() as usize;
        let d_l2 = (0.0019 * sr_f32).round() as usize;
        let d_r1 = (0.0053 * sr_f32).round() as usize;
        let d_r2 = (0.0022 * sr_f32).round() as usize;

        Self {
            source,
            params,
            channels,
            sample_rate,
            current_channel: 0,
            sample_counter: 0,
            target_mix: initial_mix,
            current_mix: initial_mix,
            target_room_size: initial_room,
            current_room_size: initial_room,
            target_intensity: initial_intensity,
            current_intensity: initial_intensity,
            // Time-based smoothing stays consistent for 44.1, 48 and 96 kHz sources.
            mix_smoothing: 1.0 - (-1.0 / (0.025 * sr_f32)).exp(),
            param_smoothing: 1.0 - (-1.0 / (0.020 * sr_f32)).exp(),
            bypassed: initial_mix == 0.0,
            delay_l: DelayLine::new(),
            delay_r: DelayLine::new(),
            bass_lp_l: OnePoleLp::new(200.0, sr_f32),
            bass_lp_r: OnePoleLp::new(200.0, sr_f32),
            reverb_hp_l: OnePoleHp::new(400.0, sr_f32),
            reverb_hp_r: OnePoleHp::new(400.0, sr_f32),
            head_shadow_l: OnePoleLp::new(2800.0, sr_f32),
            head_shadow_r: OnePoleLp::new(2800.0, sr_f32),
            room_damp_l: OnePoleLp::new(3600.0, sr_f32),
            room_damp_r: OnePoleLp::new(3600.0, sr_f32),
            diffuser_l1: Allpass::new(d_l1, 0.65),
            diffuser_l2: Allpass::new(d_l2, 0.60),
            diffuser_r1: Allpass::new(d_r1, 0.65),
            diffuser_r2: Allpass::new(d_r2, 0.60),
            air_coeffs,
            air_filter_l: DirectForm1::new(air_coeffs),
            air_filter_r: DirectForm1::new(air_coeffs),
            pending_right: None,
        }
    }

    fn clear_effect_state(&mut self) {
        self.delay_l.clear();
        self.delay_r.clear();
        self.bass_lp_l.clear();
        self.bass_lp_r.clear();
        self.reverb_hp_l.clear();
        self.reverb_hp_r.clear();
        self.head_shadow_l.clear();
        self.head_shadow_r.clear();
        self.room_damp_l.clear();
        self.room_damp_r.clear();
        self.diffuser_l1.clear();
        self.diffuser_l2.clear();
        self.diffuser_r1.clear();
        self.diffuser_r2.clear();
        self.air_filter_l = DirectForm1::new(self.air_coeffs);
        self.air_filter_r = DirectForm1::new(self.air_coeffs);
    }

    fn reset_state(&mut self) {
        self.clear_effect_state();
        self.pending_right = None;
        self.current_channel = 0;
        self.sample_counter = 0;
        self.bypassed = self.target_mix == 0.0;
    }

    #[inline]
    fn process_stereo_pair(&mut self, l: f32, r: f32) -> (f32, f32) {
        let sr = self.sample_rate.get() as f32;

        // Fade the effect over ~25 ms; instant changes are audible on loud transients.
        self.current_mix += (self.target_mix - self.current_mix) * self.mix_smoothing;
        self.current_room_size +=
            (self.target_room_size - self.current_room_size) * self.param_smoothing;
        self.current_intensity +=
            (self.target_intensity - self.current_intensity) * self.param_smoothing;

        // Once the fade finishes, clear the old room tail exactly once. A later
        // re-enable must not resurrect echoes from a previous track/setting.
        if self.current_mix < 0.0001 && self.target_mix == 0.0 {
            if !self.bypassed {
                self.clear_effect_state();
                self.bypassed = true;
            }
            return (l, r);
        }
        self.bypassed = false;

        // 1. Separate sub-bass (< 200 Hz) so kick and 808 bass stay 100% focused, punchy and uncolored:
        let l_low = self.bass_lp_l.process(l);
        let r_low = self.bass_lp_r.process(r);
        let l_mid_high = l - l_low;
        let r_mid_high = r - r_low;

        // 2. Haas Psychoacoustic 3D Spatial Offset (~0.88 ms = opposite-ear crossfeed):
        // Cross-feeding opposite channels with pinna shadow and subtle phase offset
        // breaks the "inside-the-head" sensation and pushes audio outside into physical 3D space.
        let haas_samples = 0.00088 * sr;
        let opp_r = self.delay_r.read_fractional(haas_samples);
        let opp_l = self.delay_l.read_fractional(haas_samples);
        let shadow_r = self.head_shadow_r.process(opp_r);
        let shadow_l = self.head_shadow_l.process(opp_l);

        // Antisymmetric crossfeed changes only the side signal. The old subtraction
        // from both channels attenuated centered vocals and collapsed mono mixes.
        let crossfeed_side = (shadow_l - shadow_r) * (0.15 * self.current_intensity);
        let staged_l = l_mid_high + crossfeed_side;
        let staged_r = r_mid_high - crossfeed_side;

        // 3. Widen the side channel without scaling the mid channel down.
        let mid = (staged_l + staged_r) * 0.5;
        let side = (staged_l - staged_r) * 0.5;
        let side_width = ((1.0 + 0.55 * self.current_room_size)
            * (0.85 + 0.35 * self.current_intensity))
            .clamp(1.0, 1.8);
        let wide_l = mid + side * side_width;
        let wide_r = mid - side * side_width;

        // 4. Filter room send with Abbey Road low-cut (400 Hz) to eliminate standing-wave bass boost:
        let send_l = self.reverb_hp_l.process(wide_l);
        let send_r = self.reverb_hp_r.process(wide_r);

        // 5. Multi-tap Early Reflections (room, walls, ceiling reflections):
        let room_scale = 0.45 + 0.65 * self.current_room_size;
        let refl_l_raw = self.delay_l.read_fractional(0.0095 * room_scale * sr) * 0.16
            + self.delay_r.read_fractional(0.0192 * room_scale * sr) * 0.13
            + self.delay_l.read_fractional(0.0334 * room_scale * sr) * 0.11
            + self.delay_r.read_fractional(0.0487 * room_scale * sr) * 0.09
            + self.delay_l.read_fractional(0.0681 * room_scale * sr) * 0.07
            + self.delay_r.read_fractional(0.0915 * room_scale * sr) * 0.05
            + self.delay_l.read_fractional(0.1190 * room_scale * sr) * 0.04;

        let refl_r_raw = self.delay_r.read_fractional(0.0118 * room_scale * sr) * 0.16
            + self.delay_l.read_fractional(0.0175 * room_scale * sr) * 0.13
            + self.delay_r.read_fractional(0.0361 * room_scale * sr) * 0.11
            + self.delay_l.read_fractional(0.0452 * room_scale * sr) * 0.09
            + self.delay_r.read_fractional(0.0723 * room_scale * sr) * 0.07
            + self.delay_l.read_fractional(0.0874 * room_scale * sr) * 0.05
            + self.delay_r.read_fractional(0.1242 * room_scale * sr) * 0.04;

        // Dynamic room wall damping (cozy studio: 2800 Hz; grand hall: 5800 Hz):
        let damp_cutoff = 2800.0 + 3000.0 * self.current_room_size;
        if (self.sample_counter & 63) == 0 {
            self.room_damp_l.set_cutoff(damp_cutoff, sr);
            self.room_damp_r.set_cutoff(damp_cutoff, sr);
        }

        let refl_l_damped = self.room_damp_l.process(refl_l_raw);
        let refl_r_damped = self.room_damp_r.process(refl_r_raw);

        // 6. High-density All-pass phase diffusion stage:
        let diff_l = self
            .diffuser_l2
            .process(self.diffuser_l1.process(refl_l_damped));
        let diff_r = self
            .diffuser_r2
            .process(self.diffuser_r1.process(refl_r_damped));

        // 7. Virtual Room Decay Tail (Feedback loop with cross-injection):
        // Re-inject a fraction of reflected acoustics to produce a lush, velvety reverberant decay:
        let fb_gain =
            (0.16 + 0.26 * self.current_room_size) * (0.60 + 0.35 * self.current_intensity);
        let fb_l = (diff_r * fb_gain).clamp(-0.65, 0.65);
        let fb_r = (diff_l * fb_gain).clamp(-0.65, 0.65);

        // Write filtered direct sound + feedback into circular delay lines:
        self.delay_l.write(send_l + fb_l);
        self.delay_r.write(send_r + fb_r);

        // 8. Combine direct sound with 3D room reflections:
        let refl_level =
            (0.45 + 0.35 * self.current_room_size) * (0.70 + 0.40 * self.current_intensity);
        let mut wet_l = wide_l + diff_l * refl_level;
        let mut wet_r = wide_r + diff_r * refl_level;

        // 9. Air-presence filter (+2.5 dB high shelf):
        wet_l = Biquad::run(&mut self.air_filter_l, wet_l as f64) as f32;
        wet_r = Biquad::run(&mut self.air_filter_r, wet_r as f64) as f32;

        // 10. Re-inject centered, punchy sub-bass without coloration:
        wet_l += l_low;
        wet_r += r_low;

        // 11. Limit only the effected signal. The dry path must remain bit-for-bit
        // unchanged at zero mix, including during the final fade-out samples.
        let mix = self.current_mix;
        let final_l = l + (soft_limit(wet_l) - l) * mix;
        let final_r = r + (soft_limit(wet_r) - r) * mix;

        (final_l, final_r)
    }
}

impl<S: Source<Item = f32>> Iterator for SpatialSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        // If we already computed the right channel of a stereo pair, yield it:
        if let Some(r) = self.pending_right.take() {
            self.current_channel = 0;
            return Some(r);
        }

        // For non-stereo streams, safely pass through without modification:
        if self.channels.get() != 2 {
            return self.source.next();
        }

        // Periodically read target parameters from shared state (every 32 samples):
        if (self.sample_counter & 31) == 0 {
            if let Ok(params) = self.params.try_read() {
                self.target_mix = if params.enabled { 1.0 } else { 0.0 };
                self.target_room_size = params.room_size.clamp(0.0, 1.0);
                self.target_intensity = params.intensity.clamp(0.0, 1.5);
            }
        }
        self.sample_counter = self.sample_counter.wrapping_add(1);

        // Fetch left and right from upstream:
        let l = self.source.next()?;
        let r = match self.source.next() {
            Some(sample) => sample,
            None => {
                // Odd number of samples at end of stream:
                return Some(l);
            }
        };

        let (out_l, out_r) = self.process_stereo_pair(l, r);
        self.pending_right = Some(out_r);
        self.current_channel = 1;

        Some(out_l)
    }
}

impl<S: Source<Item = f32>> Source for SpatialSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }

    fn channels(&self) -> ChannelCount {
        self.source.channels()
    }

    fn sample_rate(&self) -> SampleRate {
        self.source.sample_rate()
    }

    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.reset_state();
        self.source.try_seek(pos)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rodio::buffer::SamplesBuffer;

    fn source(enabled: bool) -> SpatialSource<SamplesBuffer> {
        let input = SamplesBuffer::new(
            ChannelCount::new(2).unwrap(),
            SampleRate::new(48_000).unwrap(),
            vec![0.0_f32, 0.0],
        );
        let params = Arc::new(RwLock::new(SpatialParams {
            enabled,
            room_size: 0.5,
            intensity: 0.85,
        }));
        SpatialSource::new(input, params)
    }

    #[test]
    fn disabled_path_preserves_dry_samples() {
        let mut spatial = source(false);
        assert_eq!(spatial.process_stereo_pair(1.2, -1.2), (1.2, -1.2));
    }

    #[test]
    fn centered_signal_stays_centered_before_room_reflections() {
        let mut spatial = source(true);
        for _ in 0..128 {
            let (left, right) = spatial.process_stereo_pair(0.4, 0.4);
            assert!((left - right).abs() < 1e-6);
        }
    }

    #[test]
    fn disabling_clears_room_tail_before_reenable() {
        let mut spatial = source(true);
        spatial.process_stereo_pair(0.8, 0.0);
        for _ in 0..1_000 {
            spatial.process_stereo_pair(0.0, 0.0);
        }

        spatial.target_mix = 0.0;
        for _ in 0..20_000 {
            spatial.process_stereo_pair(0.0, 0.0);
        }
        assert!(spatial.bypassed);

        spatial.target_mix = 1.0;
        for _ in 0..1_000 {
            let (left, right) = spatial.process_stereo_pair(0.0, 0.0);
            assert!(left.abs() < 1e-6 && right.abs() < 1e-6);
        }
    }
}
