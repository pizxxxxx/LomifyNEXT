use std::num::NonZero;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use rodio::mixer::Mixer;
use rodio::Player;

use crate::audio::analyser::AnalyserBuffer;
use crate::audio::device::open_device_sink;
use crate::audio::types::{
    AudioThreadCmd, EqParams, FloatingCommentEvent, LyricsTimingLine, MediaCmd,
};

pub struct LyricsTimelineState {
    pub lines: Vec<LyricsTimingLine>,
    pub active_index: Option<usize>,
}

pub struct CommentsTimelineState {
    pub comments: Vec<FloatingCommentEvent>,
    pub next_index: usize,
}

/// Lightweight hover-preview channel: a second rodio `Player` on the shared mixer
/// with its own throwaway analyser (so it never disturbs the main player's spectrum)
/// and a tick-driven linear volume ramp for fade-in/out. Never writes plays history.
pub struct PreviewState {
    pub player: Option<Player>,
    /// Currently applied volume (rodio scale 0.0..2.0).
    pub volume: f32,
    /// Target volume the tick-thread ramp is moving toward.
    pub target: f32,
    /// Per-tick volume delta magnitude (>= 0); direction derived from volume vs target.
    pub step: f32,
    /// When the ramp reaches 0, stop and drop the player (fade-out).
    pub stop_at_zero: bool,
    /// Monotonic generation of the installed preview. A newer hover bumps it; a
    /// stale stop / out-of-order decode is rejected by comparing against it so
    /// rapid hover across tiles can't clobber the surviving preview.
    pub gen: u64,
}

/// Уходящий трек на время микширования перехода: снят с `state.player`, но всё ещё
/// подключён к микшеру и гаснет по тику — ровно как превью при наведении выше.
///
/// Почему один слот, а не список. Одновременно гаснуть должен ровно один трек: если
/// микширование началось, а человек тут же переключил ещё раз, новый уходящий занимает это
/// же место, а прежний снимается сразу. Со списком быстрая череда переключений наложила бы
/// друг на друга сколько угодно потоков, и громкость сложилась бы в кашу.
pub struct CrossfadeState {
    pub player: Option<Player>,
    /// Пройденная доля перехода, 0.0 → 1.0. Сама громкость считается из неё по кривой
    /// (`gain()`), а не хранится: обе половины перехода идут по одному прогрессу, и держать
    /// два независимых числа означало бы дать им разъехаться.
    pub progress: f32,
    /// Прирост прогресса за тик (>= 0). 0 — микширования нет.
    pub step: f32,
    /// Сколько миллисекунд уходящему трек ещё играть в одиночку, прежде чем начнётся сам
    /// переход. Ноль — переход уже идёт.
    ///
    /// Это то, что делает перекрытие настоящим. Входящий трек готов не в тот миг, когда его
    /// попросили, а через сеть и декодирование — и если начинать затухание по готовности,
    /// уходящий трек к этому времени успевает кончиться, так что «микширование» гасит тишину.
    /// Интерфейс поэтому просит переход заранее и говорит, сколько осталось играть; лишнее
    /// время ждут здесь, с входящим на паузе.
    pub delay_ms: u64,
    /// Длина перехода, с которой его начинать по истечении `delay_ms`.
    pub pending_ms: u64,
}

impl CrossfadeState {
    /// Доля громкости уходящего трека. Косинус, а не `1 - progress`: см. [`FadeInState::gain`].
    pub fn gain(&self) -> f32 {
        (self.progress.clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2).cos()
    }
}

/// Нарастание входящего трека — вторая половина микширования.
///
/// Живёт отдельно от `CrossfadeState`, потому что относится к плееру в `state.player`, то
/// есть к тому, который продолжит играть и после конца перехода. Всё, что выставляет ему
/// громкость (`set_volume`, пересборка при перемотке и переоткрытии устройства), обязано
/// умножать на `gain()`: иначе движение ползунка посреди перехода выкинуло бы входящий трек
/// на полную громкость одним скачком.
pub struct FadeInState {
    /// Пройденная доля перехода, 0.0 → 1.0. 1.0 — нарастания нет.
    pub progress: f32,
    /// Прирост прогресса за тик (>= 0). 0 — нарастание закончилось или его не было.
    pub step: f32,
}

impl FadeInState {
    /// Доля громкости входящего трека: `sin(progress · π/2)`.
    ///
    /// Не прямая. Два разных трека — это два несвязанных сигнала, и складываются они по
    /// мощности, а не по амплитуде: на прямой в середине перехода каждый звучит вполовину,
    /// а вместе — на 3 дБ тише, чем звучал любой из них до перехода. На слух это провал в
    /// середине, из-за которого переход читается как «музыка на секунду отступила», а не как
    /// микширование. У синуса с косинусом сумма квадратов равна единице на всём переходе,
    /// поэтому громкость держится ровно, а уходящий трек слышно почти до конца — то есть
    /// перекрытие как раз и становится заметным.
    pub fn gain(&self) -> f32 {
        (self.progress.clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2).sin()
    }
}

pub struct AudioState {
    pub player: Mutex<Option<Player>>,
    pub mixer: Arc<Mutex<Mixer>>,
    pub eq_params: Arc<RwLock<EqParams>>,
    pub normalization_enabled: AtomicBool,
    pub normalization_gain: Mutex<f32>,
    pub volume: Mutex<f32>,
    pub playback_rate: Mutex<f32>,
    /// Source-time position integrator `(source_anchor, output_anchor)` in seconds.
    /// rodio's get_pos() is wall-clock (output) time; source time is integrated as
    /// `source_anchor + (get_pos() - output_anchor) * rate`. The anchor is re-based on
    /// load/seek/loop and on every rate change so speed changes mid-track stay exact.
    pub pos_anchor: Mutex<(f64, f64)>,
    pub has_track: AtomicBool,
    pub ended_notified: AtomicBool,
    pub suppress_ended_until_ms: AtomicU64,
    /// Wall-clock ms until which the tick thread skips stall-detection — set around
    /// device switch/reconnect so a settling output isn't read as a dead stream.
    pub suppress_stall_until_ms: AtomicU64,
    pub device_error: Arc<AtomicBool>,
    pub device_reconnected: Arc<AtomicBool>,
    pub load_gen: AtomicU64,
    /// Monotonic seek token. `audio_seek` now runs on the blocking pool (a backward
    /// seek costs a full decode), so a scrub gesture can queue several; each task
    /// re-checks this and skips itself if a newer seek already superseded it.
    pub seek_gen: AtomicU64,
    pub media_tx: Mutex<Option<std::sync::mpsc::Sender<MediaCmd>>>,
    pub audio_tx: std::sync::mpsc::Sender<AudioThreadCmd>,
    pub source_bytes: Mutex<Option<Vec<u8>>>,
    pub follow_default_output: AtomicBool,
    pub last_known_default_output: Mutex<Option<String>>,
    pub lyrics_timeline: Mutex<Option<LyricsTimelineState>>,
    pub comments_timeline: Mutex<Option<CommentsTimelineState>>,
    /// A-B loop region `(a, b)` in **source seconds** (a < b). When set, playback
    /// jumps back to `a` once it crosses `b` (see tick.rs). None = disabled.
    pub ab_loop: Mutex<Option<(f64, f64)>>,
    pub analyser_buffer: Arc<AnalyserBuffer>,
    pub preview: Mutex<PreviewState>,
    pub crossfade: Mutex<CrossfadeState>,
    pub fade_in: Mutex<FadeInState>,
}

/// Stand-in mixer used when no output device can be opened. Players connect to it and
/// their samples go nowhere (the pull side is dropped on purpose), which keeps the app
/// alive and silent instead of aborting the process — the previous code called
/// `.expect("no audio output device")` on the audio thread in three places, so a machine
/// with no output (or a switch whose fallback also failed) took the whole app down.
/// `device_error` is set alongside it, which is what drives the reconnect retries.
fn detached_mixer() -> Mixer {
    rodio::mixer::mixer(NonZero::new(2).unwrap(), NonZero::new(44_100).unwrap()).0
}

pub fn init() -> AudioState {
    let (mixer_tx, mixer_rx) = std::sync::mpsc::channel::<Arc<Mutex<Mixer>>>();
    let (cmd_tx, cmd_rx) = std::sync::mpsc::channel::<AudioThreadCmd>();
    let device_error_flag = Arc::new(AtomicBool::new(false));
    let reconnected_flag = Arc::new(AtomicBool::new(false));

    let cmd_tx_for_thread = cmd_tx.clone();
    let reconnected_for_thread = reconnected_flag.clone();
    let error_flag_for_thread = device_error_flag.clone();
    std::thread::Builder::new()
        .name("audio-output".into())
        .spawn(move || {
            let cmd_tx = cmd_tx_for_thread;
            let reconnected = reconnected_for_thread;
            let error_flag = error_flag_for_thread;
            // `None` = currently no live output. Kept as an Option so every failure path
            // below can leave the thread running (and retryable) instead of panicking.
            let mut device_sink = match open_device_sink(None, &cmd_tx, &error_flag) {
                Ok(sink) => Some(sink),
                Err(error) => {
                    eprintln!("[audio] no output device at startup: {error}");
                    error_flag.store(true, Ordering::Relaxed);
                    None
                }
            };
            let shared_mixer = Arc::new(Mutex::new(match device_sink.as_ref() {
                Some(sink) => sink.mixer().clone(),
                None => detached_mixer(),
            }));
            mixer_tx.send(shared_mixer.clone()).ok();

            loop {
                match cmd_rx.recv() {
                    Ok(AudioThreadCmd::SwitchDevice { name, reply }) => {
                        // Release the old device before opening the new one — some
                        // drivers refuse a second concurrent open. `take()` (not a bare
                        // `= None`) so the binding counts as read: it exists purely for
                        // its Drop timing.
                        drop(device_sink.take());

                        match open_device_sink(name.as_deref(), &cmd_tx, &error_flag) {
                            Ok(new_sink) => {
                                let mixer = new_sink.mixer().clone();
                                *shared_mixer.lock().unwrap() = mixer.clone();
                                device_sink = Some(new_sink);
                                reply.send(Ok(mixer)).ok();
                            }
                            Err(error) => {
                                match open_device_sink(None, &cmd_tx, &error_flag) {
                                    Ok(fallback) => {
                                        *shared_mixer.lock().unwrap() =
                                            fallback.mixer().clone();
                                        device_sink = Some(fallback);
                                    }
                                    Err(fallback_error) => {
                                        eprintln!(
                                            "[audio] fallback to default output failed: {fallback_error}"
                                        );
                                        error_flag.store(true, Ordering::Relaxed);
                                        *shared_mixer.lock().unwrap() = detached_mixer();
                                    }
                                }
                                reply.send(Err(error)).ok();
                            }
                        }
                    }
                    Ok(AudioThreadCmd::Reconnect) => {
                        eprintln!("[audio] device invalidated, reconnecting...");
                        std::thread::sleep(Duration::from_millis(500));

                        drop(device_sink.take());
                        match open_device_sink(None, &cmd_tx, &error_flag) {
                            Ok(new_sink) => {
                                *shared_mixer.lock().unwrap() = new_sink.mixer().clone();
                                device_sink = Some(new_sink);
                                reconnected.store(true, Ordering::Release);
                                eprintln!("[audio] reconnected successfully");
                            }
                            Err(error) => {
                                eprintln!("[audio] reconnect failed: {error}, retrying...");
                                std::thread::sleep(Duration::from_secs(1));
                                match open_device_sink(None, &cmd_tx, &error_flag) {
                                    Ok(new_sink) => {
                                        *shared_mixer.lock().unwrap() =
                                            new_sink.mixer().clone();
                                        device_sink = Some(new_sink);
                                        reconnected.store(true, Ordering::Release);
                                    }
                                    Err(retry_error) => {
                                        // Stay alive on a detached mixer; stall
                                        // detection in tick.rs keeps sending Reconnect.
                                        eprintln!("[audio] reconnect retry failed: {retry_error}");
                                        error_flag.store(true, Ordering::Relaxed);
                                        *shared_mixer.lock().unwrap() = detached_mixer();
                                    }
                                }
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        })
        .expect("failed to spawn audio thread");

    let shared_mixer = mixer_rx.recv().expect("audio thread failed to init");

    AudioState {
        player: Mutex::new(None),
        mixer: shared_mixer,
        eq_params: Arc::new(RwLock::new(EqParams::default())),
        normalization_enabled: AtomicBool::new(true),
        normalization_gain: Mutex::new(1.0),
        volume: Mutex::new(0.25),
        playback_rate: Mutex::new(1.0),
        pos_anchor: Mutex::new((0.0, 0.0)),
        has_track: AtomicBool::new(false),
        ended_notified: AtomicBool::new(false),
        suppress_ended_until_ms: AtomicU64::new(0),
        suppress_stall_until_ms: AtomicU64::new(0),
        device_error: device_error_flag,
        device_reconnected: reconnected_flag,
        load_gen: AtomicU64::new(0),
        seek_gen: AtomicU64::new(0),
        media_tx: Mutex::new(None),
        audio_tx: cmd_tx,
        source_bytes: Mutex::new(None),
        follow_default_output: AtomicBool::new(true),
        last_known_default_output: Mutex::new(None),
        lyrics_timeline: Mutex::new(None),
        comments_timeline: Mutex::new(None),
        ab_loop: Mutex::new(None),
        analyser_buffer: AnalyserBuffer::new(),
        preview: Mutex::new(PreviewState {
            player: None,
            volume: 0.0,
            target: 0.0,
            step: 0.0,
            stop_at_zero: false,
            gen: 0,
        }),
        crossfade: Mutex::new(CrossfadeState {
            player: None,
            progress: 0.0,
            step: 0.0,
            delay_ms: 0,
            pending_ms: 0,
        }),
        // Нарастания нет: обычная загрузка ставит плеер на полную пользовательскую
        // громкость, и прогресс 1.0 — это ровно «множитель ничего не меняет».
        fade_in: Mutex::new(FadeInState {
            progress: 1.0,
            step: 0.0,
        }),
    }
}
