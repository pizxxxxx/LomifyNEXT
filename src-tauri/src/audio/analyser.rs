//! Spectrum analyser: taps PCM mid-pipeline, runs FFT in a background thread,
//! emits log-scale magnitude bins to the frontend ~30Hz for visualizer canvas.
//!
//! Hot path (audio thread):
//!  - `AnalyserSource::next()` is called per-sample; we do NO allocation, NO logf,
//!    NO blocking. We average channels into mono, then push into a fixed-cap
//!    ring buffer guarded by a Mutex. The lock is taken only once per audio
//!    frame, never per-sample, by accumulating channels first.
//!  - If the FFT thread has the lock (rare, FFT itself is fast), we drop the
//!    frame instead of blocking — visualizer gracefully handles gaps.
//!
//! FFT thread:
//!  - Runs at fixed ~30Hz. 2048-point real FFT on most recent samples.
//!  - Hann window pre-computed once at startup.
//!  - 64 log-spaced bins, normalized + smoothed with prev frame for visual
//!    stability. Sleep-based pacing — no heavy timers.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rodio::source::SeekError;
use rodio::Source;
use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use tauri::{AppHandle, Emitter};

use crate::audio::types::{ChannelCount, SampleRate};

const FFT_SIZE: usize = 2048;
const RING_CAPACITY: usize = 4096;
const FFT_INTERVAL_MS: u64 = 33;
pub const NUM_BINS: usize = 64;
const MIN_FREQ_HZ: f32 = 50.0;

pub struct AnalyserBuffer {
    samples: Mutex<VecDeque<f32>>,
    /// Monotonic count of frames pushed by the audio thread. The FFT thread compares
    /// it across iterations to tell "paused / no data" apart from "same window as last
    /// tick": the reader never drains the ring, so `len() < FFT_SIZE` stops being true
    /// after the first `RING_CAPACITY` frames and the fade-out path in `run_fft_loop`
    /// was unreachable without this.
    writes: AtomicU64,
    pub sample_rate: AtomicU32,
    pub running: AtomicBool,
}

impl AnalyserBuffer {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            samples: Mutex::new(VecDeque::with_capacity(RING_CAPACITY)),
            writes: AtomicU64::new(0),
            sample_rate: AtomicU32::new(44_100),
            running: AtomicBool::new(true),
        })
    }
}

pub struct AnalyserSource<S: Source<Item = f32>> {
    source: S,
    buffer: Arc<AnalyserBuffer>,
    channels: ChannelCount,
    sample_rate: SampleRate,
    cur_channel: u16,
    accum: f32,
}

impl<S: Source<Item = f32>> AnalyserSource<S> {
    pub fn new(source: S, buffer: Arc<AnalyserBuffer>) -> Self {
        let channels = source.channels();
        let sample_rate = source.sample_rate();
        buffer
            .sample_rate
            .store(sample_rate.get(), Ordering::Relaxed);
        Self {
            source,
            buffer,
            channels,
            sample_rate,
            cur_channel: 0,
            accum: 0.0,
        }
    }
}

impl<S: Source<Item = f32>> Iterator for AnalyserSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        let sample = self.source.next()?;
        self.accum += sample;
        self.cur_channel += 1;

        // Once per audio frame (all channels seen), push the mono mix.
        if self.cur_channel >= self.channels.get() {
            let mono = self.accum / self.channels.get() as f32;
            self.cur_channel = 0;
            self.accum = 0.0;

            // try_lock — if FFT thread is reading, just drop this frame.
            if let Ok(mut q) = self.buffer.samples.try_lock() {
                // pop_front, not drain(0..n): VecDeque::drain constructs an iterator
                // and fixes the ring up on drop, which is far more work than one O(1)
                // pop — and this branch runs ~48k times per second.
                while q.len() >= RING_CAPACITY {
                    q.pop_front();
                }
                q.push_back(mono);
                self.buffer.writes.fetch_add(1, Ordering::Relaxed);
            }
        }
        Some(sample)
    }
}

impl<S: Source<Item = f32>> Source for AnalyserSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }
    fn channels(&self) -> ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> SampleRate {
        self.sample_rate
    }
    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.source.try_seek(pos)
    }
}

/// Background FFT thread. Lives for the whole app lifetime; cheap when no
/// audio is playing (sleep + empty-buffer skip).
pub fn start_fft_thread(app: AppHandle, buffer: Arc<AnalyserBuffer>) {
    std::thread::Builder::new()
        .name("audio-fft".into())
        .spawn(move || run_fft_loop(app, buffer))
        .expect("failed to spawn audio-fft thread");
}

fn run_fft_loop(app: AppHandle, buffer: Arc<AnalyserBuffer>) {
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);

    // Pre-compute Hann window once.
    let mut window = vec![0.0f32; FFT_SIZE];
    for (i, w) in window.iter_mut().enumerate() {
        *w = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (FFT_SIZE - 1) as f32).cos());
    }

    let mut fft_buf = vec![Complex::new(0.0f32, 0.0); FFT_SIZE];
    let mut bins_smooth = vec![0.0f32; NUM_BINS];
    let mut silence_skips: u32 = 0;
    let mut prev_emit_was_silent = true;
    let mut last_writes = 0u64;

    loop {
        std::thread::sleep(Duration::from_millis(FFT_INTERVAL_MS));
        if !buffer.running.load(Ordering::Relaxed) {
            break;
        }

        // Staleness gate: the reader never removes samples, so a paused audio thread
        // leaves a full ring behind. Comparing the write counter is what makes the
        // "no fresh samples" fade-out below actually reachable — previously the FFT
        // re-ran over the same trailing window for the entire duration of a pause.
        let writes = buffer.writes.load(Ordering::Relaxed);
        let has_fresh_frames = writes != last_writes;
        last_writes = writes;

        let snapshot: Option<Vec<f32>> = if !has_fresh_frames {
            None
        } else {
            let q = buffer.samples.lock().unwrap();
            if q.len() < FFT_SIZE {
                None
            } else {
                let start = q.len() - FFT_SIZE;
                Some(q.iter().skip(start).copied().collect())
            }
        };

        let Some(samples) = snapshot else {
            // No fresh samples (paused / loading). After ~4 ticks (~130ms) of
            // silence, emit one zero frame so the canvas can fade out, then go quiet.
            silence_skips = silence_skips.saturating_add(1);
            if !prev_emit_was_silent && silence_skips >= 4 {
                let zeros = vec![0.0f32; NUM_BINS];
                let _ = app.emit("audio:fft", &zeros);
                prev_emit_was_silent = true;
            }
            continue;
        };

        // Quick silence detection — skip FFT for fully zeroed buffers.
        let mut peak = 0.0f32;
        for &s in &samples {
            let a = s.abs();
            if a > peak {
                peak = a;
            }
        }
        if peak < 1e-4 {
            silence_skips = silence_skips.saturating_add(1);
            if !prev_emit_was_silent {
                let zeros = vec![0.0f32; NUM_BINS];
                let _ = app.emit("audio:fft", &zeros);
                prev_emit_was_silent = true;
            }
            continue;
        }
        silence_skips = 0;

        for i in 0..FFT_SIZE {
            fft_buf[i] = Complex::new(samples[i] * window[i], 0.0);
        }
        fft.process(&mut fft_buf);

        let sample_rate = buffer.sample_rate.load(Ordering::Relaxed) as f32;
        let nyquist = (sample_rate * 0.5).max(1.0);
        let mag_count = FFT_SIZE / 2;

        let log_min = MIN_FREQ_HZ.ln();
        let log_max = nyquist.ln();
        let log_range = (log_max - log_min).max(1e-3);

        // Bin-bucketing: distribute FFT magnitudes into log-spaced bins, take max.
        //
        // The 50 Hz bin and its neighbours all land in display bin 0, so bass used to read as
        // a couple of bars no matter how much low end the track had. Splitting magnitude
        // across the two bins around the exact log position smooths the staircase: an
        // intermediate component now fills in the gap between neighbours instead of being
        // dropped into only one of them.
        let spread = (FFT_SIZE as f32 / 1024.0).max(1.0);
        let mut bins = vec![0.0f32; NUM_BINS];
        let nbins_minus_1 = (NUM_BINS - 1) as f32;
        for (i, c) in fft_buf.iter().take(mag_count).enumerate() {
            let freq = (i as f32) * nyquist / (mag_count as f32);
            if freq < MIN_FREQ_HZ {
                continue;
            }
            let log_freq = freq.ln();
            let pos = ((log_freq - log_min) / log_range).clamp(0.0, 1.0) * nbins_minus_1;
            let idx = pos as usize;
            let frac = pos - idx as f32;
            let mag = (c.re * c.re + c.im * c.im).sqrt() * spread;
            let mag_up = mag / (1.0 + frac);
            let mag_down = mag - mag_up;
            let k = idx.min(NUM_BINS - 1);
            if mag_up > bins[k] {
                bins[k] = mag_up;
            }
            if frac > 0.001 && k + 1 < NUM_BINS && mag_down > bins[k + 1] {
                bins[k + 1] = mag_down;
            }
        }

        // Log-compress + normalize + smooth with previous frame.
        // Emp. normalisation: FFT magnitudes hit ~32 on full-scale music with Hann.
        let inv_log9 = 1.0 / 10.0_f32.ln(); // (1+9).ln()
        for i in 0..NUM_BINS {
            let v = (bins[i] / 32.0).min(1.0);
            let log_v = (1.0 + v * 9.0).ln() * inv_log9;
            bins_smooth[i] = bins_smooth[i] * 0.55 + log_v * 0.45;
            bins[i] = bins_smooth[i];
        }

        if app.emit("audio:fft", &bins).is_ok() {
            prev_emit_was_silent = false;
        }
    }
}
