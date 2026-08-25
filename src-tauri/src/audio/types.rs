use std::num::NonZero;
use std::sync::mpsc::Sender;

use rodio::mixer::Mixer;

pub const EQ_BANDS: usize = 10;
pub const EQ_FREQS: [f64; EQ_BANDS] = [
    32.0, 64.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];
pub const EQ_Q: f64 = 1.414;
pub const NORMALIZATION_ANALYSIS_SAMPLES: usize = 48_000 * 2 * 30;
pub const NORMALIZATION_BLOCK_SAMPLES: usize = 48_000 * 2 / 2;
pub const NORMALIZATION_TARGET_RMS: f64 = 0.14;
pub const NORMALIZATION_TARGET_PEAK: f64 = 0.95;
pub const NORMALIZATION_MAX_BOOST_DB: f64 = 9.0;
pub const NORMALIZATION_MAX_ATTENUATION_DB: f64 = -8.0;
pub const TICK_INTERVAL_MS: u64 = 100;

pub type ChannelCount = NonZero<u16>;
pub type SampleRate = NonZero<u32>;

pub struct EqParams {
    pub enabled: bool,
    pub gains: [f64; EQ_BANDS],
}

impl Default for EqParams {
    fn default() -> Self {
        Self {
            enabled: false,
            gains: [0.0; EQ_BANDS],
        }
    }
}

// Все варианты — это команды на установку state у системного медиа-контроллера
// (MPRIS/SMTC), общий `Set`-префикс отражает это назначение, не редандант.
#[allow(clippy::enum_variant_names)]
pub enum MediaCmd {
    SetMetadata {
        title: String,
        artist: String,
        cover_url: Option<String>,
        duration_secs: f64,
    },
    SetPlaying(bool),
    SetPosition(f64),
}

pub enum AudioThreadCmd {
    SwitchDevice {
        name: Option<String>,
        reply: Sender<Result<Mixer, String>>,
    },
    Reconnect,
}

#[derive(serde::Serialize)]
pub struct AudioLoadResult {
    pub duration_secs: Option<f64>,
    /// Загрузку обогнала более свежая: плеер НЕ собран и ничего не играет.
    ///
    /// Раньше на этом месте возвращался `Ok(duration_secs: None)` — успех по форме и
    /// ничего по сути. Плеер в интерфейсе на такой ответ включал `isPlaying = true` и
    /// посылал `audio_play` в пустоту: получалась тишина без единой ошибки где-либо.
    /// Флаг делает разницу видимой и вызывающей стороне, и в логе.
    pub superseded: bool,
}

impl AudioLoadResult {
    pub fn superseded() -> Self {
        Self {
            duration_secs: None,
            superseded: true,
        }
    }

    pub fn loaded(duration_secs: Option<f64>) -> Self {
        Self {
            duration_secs,
            superseded: false,
        }
    }
}

#[derive(serde::Serialize, Clone)]
pub struct AudioSink {
    pub name: String,
    pub description: String,
    pub is_default: bool,
}

pub const STALL_THRESHOLD_MS: u64 = 2_000;
pub const STALL_COOLDOWN_MS: u64 = 10_000;
/// After a device switch/reconnect the new output can take a moment to start
/// pulling samples (Bluetooth especially); suppress stall-detection for this long
/// so the settling gap isn't mistaken for a dead stream.
pub const STALL_SUPPRESS_MS: u64 = 4_000;

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsTimingLine {
    pub time_secs: f64,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct FloatingCommentEvent {
    pub id: i64,
    pub body: String,
    pub timestamp_ms: u64,
    pub user_avatar_url: Option<String>,
}
