use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager, State};
use tokio::task;

use crate::app::diagnostics;
use crate::audio::device;
use crate::audio::engine;
use crate::audio::state::AudioState;
use crate::audio::timing;
use crate::audio::types::{AudioLoadResult, AudioSink};

#[tauri::command]
pub async fn audio_load_file(
    path: String,
    cache_key: Option<String>,
    start_paused: bool,
    // `Option` — чтобы старый вызов без этого аргумента остался валидным: Tauri сверяет
    // имена полей, и обязательный `u64` превратил бы любой пропущенный `crossfadeMs` в
    // ошибку разбора аргументов, то есть в трек, который не включается.
    crossfade_ms: Option<u64>,
    // Сколько уходящему треку осталось играть на момент вызова. Из этого получается задержка
    // перед переходом: загрузка занимает неизвестно сколько (сеть, склейка HLS, первый полный
    // проход для громкости), и без такой отсрочки переход начинался бы по готовности — часто
    // уже после конца уходящего трека, то есть микшировал бы тишину. `Option` — по той же
    // причине, что и выше.
    remaining_ms: Option<u64>,
    app: AppHandle,
    state: State<'_, AudioState>,
) -> Result<AudioLoadResult, String> {
    let normalization_cache_dir = app
        .path()
        .app_cache_dir()
        .ok()
        .map(|dir| dir.join("audio-normalization"));
    engine::load_file(
        path,
        normalization_cache_dir,
        cache_key,
        start_paused,
        crossfade_ms.unwrap_or(0),
        remaining_ms.unwrap_or(0),
        &app,
        state,
    )
    .await
}

#[tauri::command]
pub async fn audio_load_url(
    url: String,
    session_id: Option<String>,
    cache_path: Option<String>,
    cache_key: Option<String>,
    start_paused: bool,
    crossfade_ms: Option<u64>,
    remaining_ms: Option<u64>,
    app: AppHandle,
    state: State<'_, AudioState>,
) -> Result<AudioLoadResult, String> {
    let normalization_cache_dir = app
        .path()
        .app_cache_dir()
        .ok()
        .map(|dir| dir.join("audio-normalization"));
    engine::load_url(
        url,
        session_id,
        cache_path,
        normalization_cache_dir,
        cache_key,
        start_paused,
        crossfade_ms.unwrap_or(0),
        remaining_ms.unwrap_or(0),
        &app,
        state,
    )
    .await
}

#[tauri::command]
pub fn audio_play(app: AppHandle, state: State<'_, AudioState>) {
    engine::play(&app, state);
}

#[tauri::command]
pub fn audio_pause(app: AppHandle, state: State<'_, AudioState>) {
    engine::pause(&app, state);
}

#[tauri::command]
pub fn audio_stop(app: AppHandle, state: State<'_, AudioState>) {
    engine::stop(&app, state);
}

/// Отменить загрузку в полёте, не глуша звук.
///
/// Половина `audio_stop`, которая нужна перед микшированием: интерфейс всё так же обязан
/// отменить загрузку, запущенную предыдущим нажатием (иначе она поставит свой плеер поверх
/// нашего), но снимать играющий трек ему теперь нельзя — тот доигрывает под входящий.
#[tauri::command]
pub fn audio_cancel_load(app: AppHandle, state: State<'_, AudioState>) {
    let generation = engine::cancel_pending_load(&state);
    diagnostics::log_native(
        &app,
        "INFO",
        format!("[Audio] загрузка отменена под микширование, поколение теперь #{generation}"),
    );
}

/// Seeking is NOT cheap: `engine::seek_to` only manages an in-place `try_seek` for a
/// forward jump on a seekable decoder — a backward seek or seek-to-0 rebuilds the
/// player from the raw bytes, i.e. a full decode. As a sync command that ran on the
/// main thread and froze the window for its whole duration, so it goes to the blocking
/// pool instead.
#[tauri::command]
pub async fn audio_seek(position: f64, app: AppHandle) -> Result<(), String> {
    let generation = {
        let state = app.state::<AudioState>();
        state.seek_gen.fetch_add(1, Ordering::Relaxed) + 1
    };
    task::spawn_blocking(move || {
        let state = app.state::<AudioState>();
        // A scrub gesture queues seeks faster than they decode; skip every task a
        // newer seek has already superseded rather than decoding the whole backlog.
        if state.seek_gen.load(Ordering::Relaxed) != generation {
            return Ok(());
        }
        engine::seek(position, &state)
    })
    .await
    .map_err(|e| format!("audio seek task failed: {e}"))?
}

#[tauri::command]
pub fn audio_set_volume(volume: f64, state: State<'_, AudioState>) {
    engine::set_volume(volume, state);
}

#[tauri::command]
pub fn audio_set_playback_rate(rate: f64, state: State<'_, AudioState>) {
    engine::set_playback_rate(rate, state);
}

#[tauri::command]
pub fn audio_set_ab_loop(a: Option<f64>, b: Option<f64>, state: State<'_, AudioState>) {
    engine::set_ab_loop(a, b, state);
}

#[tauri::command]
pub fn audio_get_position(state: State<'_, AudioState>) -> f64 {
    engine::get_position(state)
}

#[tauri::command]
pub fn audio_set_eq(enabled: bool, gains: Vec<f64>, state: State<'_, AudioState>) {
    engine::set_eq(enabled, gains, state);
}

#[tauri::command]
pub fn audio_set_normalization(enabled: bool, state: State<'_, AudioState>) {
    engine::set_normalization(enabled, state);
}

#[tauri::command]
pub fn audio_is_playing(state: State<'_, AudioState>) -> bool {
    engine::is_playing(state)
}

#[tauri::command]
pub fn audio_set_metadata(
    title: String,
    artist: String,
    cover_url: Option<String>,
    duration_secs: f64,
    state: State<'_, AudioState>,
) {
    engine::set_metadata(title, artist, cover_url, duration_secs, state);
}

#[tauri::command]
pub fn audio_set_playback_state(playing: bool, state: State<'_, AudioState>) {
    engine::set_playback_state(playing, state);
}

#[tauri::command]
pub fn audio_set_media_position(position: f64, state: State<'_, AudioState>) {
    engine::set_media_position(position, state);
}

/// cpal device enumeration is an OS call (COM on Windows, a `pactl` subprocess on
/// Linux) — off the main thread.
#[tauri::command]
pub async fn audio_list_devices() -> Vec<AudioSink> {
    task::spawn_blocking(device::list_devices)
        .await
        .unwrap_or_default()
}

/// Waits on the output thread's device-open reply (seconds for a Bluetooth sink) and
/// then rebuilds the current track on the new mixer. Both are blocking, so this must
/// not run on the main thread.
#[tauri::command]
pub async fn audio_switch_device(
    device_name: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    task::spawn_blocking(move || {
        let state = app.state::<AudioState>();
        device::switch_device(&state, device_name)
    })
    .await
    .map_err(|e| format!("audio device switch task failed: {e}"))?
}

#[tauri::command]
pub async fn audio_set_follow_default_output(follow: bool, app: AppHandle) {
    // Reads the current default device (another OS call) when enabling.
    let _ = task::spawn_blocking(move || {
        let state = app.state::<AudioState>();
        device::set_follow_default_output(&state, follow);
    })
    .await;
}

#[tauri::command]
pub async fn save_track_to_path(cache_path: String, dest_path: String) -> Result<String, String> {
    engine::save_track_to_path(cache_path, dest_path).await
}

#[tauri::command]
pub fn audio_set_lyrics_timeline(
    lines: Vec<crate::audio::types::LyricsTimingLine>,
    state: State<'_, AudioState>,
) {
    timing::audio_set_lyrics_timeline(lines, state);
}

#[tauri::command]
pub fn audio_clear_lyrics_timeline(state: State<'_, AudioState>) {
    timing::audio_clear_lyrics_timeline(state);
}

#[tauri::command]
pub fn audio_set_comments_timeline(
    comments: Vec<crate::audio::types::FloatingCommentEvent>,
    state: State<'_, AudioState>,
) {
    timing::audio_set_comments_timeline(comments, state);
}

#[tauri::command]
pub fn audio_clear_comments_timeline(state: State<'_, AudioState>) {
    timing::audio_clear_comments_timeline(state);
}

#[tauri::command]
pub async fn audio_preview_play(
    path: String,
    volume: f64,
    gen: u64,
    state: State<'_, AudioState>,
) -> Result<(), String> {
    engine::preview_play(path, volume, gen, state).await
}

#[tauri::command]
pub fn audio_preview_stop(fade_ms: u64, gen: u64, state: State<'_, AudioState>) {
    engine::preview_stop(fade_ms, gen, state);
}
