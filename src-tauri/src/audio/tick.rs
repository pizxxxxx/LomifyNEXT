use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::app::diagnostics;
use crate::audio::engine;
use crate::audio::state::AudioState;
use crate::audio::timing;
use crate::audio::types::{
    AudioThreadCmd, STALL_COOLDOWN_MS, STALL_THRESHOLD_MS, TICK_INTERVAL_MS,
};

/// Step the hover-preview volume one tick toward its target, dropping the player
/// once a fade-out reaches zero. Independent of the main player.
fn process_preview_fade(state: &AudioState) {
    let mut preview = state.preview.lock().unwrap();
    if preview.player.is_none() {
        return;
    }
    // A fade-out that is already AT its target must still be finalised. Bailing out
    // on `volume == target` before this check leaked the preview player whenever the
    // hover started at volume 0 (global volume 0 / preview volume 0): preview_stop
    // set target = 0 with volume already 0, so the ramp had nothing to do and the
    // player was never dropped — it stayed connected to the mixer indefinitely.
    if (preview.volume - preview.target).abs() <= f32::EPSILON {
        if preview.stop_at_zero && preview.volume <= 0.0 {
            if let Some(old) = preview.player.take() {
                old.stop();
            }
            preview.stop_at_zero = false;
        }
        return;
    }
    let next = if preview.volume < preview.target {
        (preview.volume + preview.step).min(preview.target)
    } else {
        (preview.volume - preview.step).max(preview.target)
    };
    preview.volume = next;
    if let Some(ref player) = preview.player {
        player.set_volume(next);
    }
    if preview.stop_at_zero && next <= 0.0 {
        if let Some(old) = preview.player.take() {
            old.stop();
        }
        preview.stop_at_zero = false;
    }
}

/// Двинуть на один тик обе половины микширования перехода: нарастание входящего трека и
/// затухание уходящего. Плюс отсчитать ожидание, если переход попросили заранее.
///
/// Обе половины ведутся здесь, а не в отдельных потоках на каждый переход: этот поток и так
/// просыпается каждые 100 мс, а изменение громкости на слух ровно настолько же плавное, как
/// и покадровое, — те же 100 мс уже стоят у превью при наведении.
///
/// Замки берутся по одному и на минимум: `state.player` тик держит ниже под чтение позиции,
/// а `stop()` уходящего вызывается с отпущенным `crossfade` — снятие плеера синхронно ждёт
/// микшер, и держать при этом замок значит подарить микшеру шанс встать в очередь за ним.
fn process_crossfade(state: &AudioState) {
    // ── Ожидание. Входящий трек готов, но уходящему ещё играть одному: переход просят
    // заранее, с запасом на сеть и декодирование, и лишнее время ждут здесь.
    let mut start_now = false;
    {
        let mut crossfade = state.crossfade.lock().unwrap();
        if crossfade.delay_ms > 0 {
            match crossfade.player.as_ref() {
                // Человек на паузе. Время до конца уходящего трека вместе с ним не течёт —
                // ровно поэтому ожидание считается тиками, а не по часам: иначе пауза на
                // минуту сожгла бы весь запас, и переход начался бы сразу после «продолжить».
                //
                // Проверка стоит первой, до «уходящий кончился»: у паузы, поставленной в те
                // же 100 мс, что и конец источника, иначе выиграл бы конец — и входящий трек
                // получил бы `play()`, то есть заиграл бы при нажатой паузе.
                Some(player) if player.is_paused() => return,
                // Уходящий кончился раньше, чем обещала его длительность (соврали метаданные,
                // тишина в хвосте файла) — ждать больше нечего: иначе входящий вступит в
                // тишину, и переход обернётся паузой.
                Some(player) if player.empty() => start_now = true,
                Some(_) => {
                    let left = crossfade.delay_ms.saturating_sub(TICK_INTERVAL_MS);
                    if left > 0 {
                        crossfade.delay_ms = left;
                        return;
                    }
                    // Ноль не ставим: обнулит его `start_pending_crossfade`, для которого
                    // ненулевой `delay_ms` — признак «есть что пускать». Заодно это даёт
                    // право отказаться и попробовать следующим тиком.
                    start_now = true;
                }
                None => start_now = true,
            }
        }
    }
    if start_now {
        engine::start_pending_crossfade(state);
        // Первый шаг прогресса сделает следующий тик: прогресс только что выставлен в ноль,
        // и двигать его в этом же тике значит съесть первые 100 мс перехода.
        return;
    }

    let volume = *state.volume.lock().unwrap();

    // Входящий: прогресс идёт к единице и на этом останавливается, шаг сбрасывается —
    // дальше `set_volume` работает как обычно, с множителем 1.0.
    let fade_in_gain = {
        let mut fade = state.fade_in.lock().unwrap();
        if fade.step > 0.0 {
            fade.progress = (fade.progress + fade.step).min(1.0);
            if fade.progress >= 1.0 {
                fade.step = 0.0;
            }
            Some(fade.gain())
        } else {
            None
        }
    };
    if let Some(gain) = fade_in_gain {
        if let Some(ref player) = *state.player.lock().unwrap() {
            player.set_volume(volume * gain);
        }
    }

    // Уходящий: тот же прогресс, обратная кривая; на единице плеер снимается. Ждать его
    // настоящего конца нельзя — трек может быть длиннее перехода (переключили вручную), и
    // тогда он доигрывал бы в тишине, занимая голос микшера.
    //
    // Всё под одним замком: возьми его дважды — сначала посчитать прогресс, потом снять
    // плеер, — и между двумя захватами успел бы начаться новый переход, а снят оказался бы
    // уже его хвост, только что поставленный на полную громкость.
    let finished = {
        let mut crossfade = state.crossfade.lock().unwrap();
        if crossfade.player.is_none() || crossfade.step <= 0.0 {
            return;
        }
        crossfade.progress = (crossfade.progress + crossfade.step).min(1.0);
        if crossfade.progress >= 1.0 {
            crossfade.step = 0.0;
            crossfade.player.take()
        } else {
            let gain = crossfade.gain();
            if let Some(ref fading) = crossfade.player {
                fading.set_volume(volume * gain);
            }
            None
        }
    };
    if let Some(old) = finished {
        old.stop();
    }
}

/// What one tick observed about the player, read under the `state.player` lock and
/// acted on **after** that lock is released.
///
/// `emit` is a full IPC hop into the webview and the timeline scans walk the whole
/// lyrics/comments vectors; doing either while holding `state.player` kept the mutex
/// busy for most of the 100ms tick interval. That is what made `engine::play`/`pause`
/// (which used `try_lock`) lose the race and silently discard the user's action.
enum Tick {
    /// No player installed (transient during load) — nothing to do.
    Idle,
    /// Source exhausted; maybe notify the frontend.
    Ended,
    /// Crossed the A-B loop's upper bound — snap back to `a` (source seconds).
    LoopBack { a: f64, rate: f64 },
    /// Normal progress: `pos` in source seconds, `raw_ms` in output ms.
    Progress { pos: f64, raw_ms: u64, playing: bool },
}

pub fn start_tick_emitter(app: &AppHandle) {
    let handle = app.clone();
    std::thread::Builder::new()
        .name("audio-tick".into())
        .spawn(move || {
            let mut last_pos_ms = 0u64;
            let mut last_progress_at = std::time::Instant::now();
            let mut stall_cooldown_until = std::time::Instant::now();
            // Ждём ли первую живую позицию после установки нового трека. Одна строчка в
            // логе на трек, зато она отвечает на главный вопрос при жалобе «не играет»:
            // забирает ли устройство сэмплы вообще или плеер стоит мёртвым.
            let mut awaiting_first_progress = false;
            let mut had_track = false;

            loop {
                std::thread::sleep(Duration::from_millis(TICK_INTERVAL_MS));
                let state = handle.state::<AudioState>();

                if state.device_reconnected.swap(false, Ordering::Acquire) {
                    let _ = engine::reload_current_track(&state);
                    diagnostics::log_native(
                        &handle,
                        "INFO",
                        "[Audio] Device reconnected and reloaded",
                    );
                    handle.emit("audio:device-reconnected", ()).ok();
                }

                // Advance the hover-preview volume ramp. Done before the has_track
                // guard so previews fade in/out even when no main track is loaded.
                process_preview_fade(&state);

                // Тоже до проверки `has_track`: уходящий трек живёт вне `state.player`, и
                // его затухание не должно зависеть от того, установлен ли входящий.
                process_crossfade(&state);

                if !state.has_track.load(Ordering::Relaxed) {
                    last_pos_ms = 0;
                    last_progress_at = std::time::Instant::now();
                    had_track = false;
                    continue;
                }
                if !had_track {
                    had_track = true;
                    awaiting_first_progress = true;
                }

                // ── Read-only snapshot under the lock; released before any emit. ──
                let tick = {
                    let player_guard = state.player.lock().unwrap();
                    match player_guard.as_ref() {
                        None => Tick::Idle,
                        Some(player) if player.empty() => Tick::Ended,
                        Some(player) => {
                            // rodio's get_pos() is output (wall-clock) time; the rest
                            // of the app works in source seconds, so integrate (exact
                            // across speed changes — see engine::source_pos).
                            let rate = engine::current_rate(&state);
                            let raw_ms = (player.get_pos().as_secs_f64() * 1000.0) as u64;
                            let pos = engine::source_pos(&state, player);
                            match *state.ab_loop.lock().unwrap() {
                                Some((a, b)) if pos >= b => Tick::LoopBack { a, rate },
                                _ => Tick::Progress {
                                    pos,
                                    raw_ms,
                                    playing: !player.is_paused(),
                                },
                            }
                        }
                    }
                };

                match tick {
                    Tick::Idle => {}

                    Tick::Ended => {
                        let suppress_ended = engine::now_ms()
                            < state.suppress_ended_until_ms.load(Ordering::Relaxed);
                        if !state.device_error.load(Ordering::Relaxed)
                            && !suppress_ended
                            && !state.ended_notified.swap(true, Ordering::Relaxed)
                        {
                            // Трек кончился на первых миллисекундах — это не конец
                            // трека, а пустой источник: декодер не дал ни одного кадра.
                            // Интерфейс на `audio:ended` включает следующий, и снаружи
                            // получается «треки не играют, только иногда мелькнёт».
                            let level = if last_pos_ms < 1000 { "WARN" } else { "INFO" };
                            diagnostics::log_native(
                                &handle,
                                level,
                                format!(
                                    "[Audio] источник кончился на {:.1} с — шлю audio:ended",
                                    last_pos_ms as f64 / 1000.0
                                ),
                            );
                            handle.emit("audio:ended", ()).ok();
                        }
                    }

                    // A-B loop: snap back to A as soon as we cross B (source secs).
                    // Route through engine::seek_to (in-place try_seek with a recreate
                    // fallback), NOT a bare try_seek: on decoders that can't seek in
                    // place a bare try_seek silently no-ops, leaving the segment
                    // playing straight through while the bar froze at A.
                    Tick::LoopBack { a, rate } => {
                        engine::seek_to(&state, a).ok();
                        handle.emit("audio:tick", a).ok();
                        last_pos_ms = ((a / rate).max(0.0) * 1000.0) as u64;
                        last_progress_at = std::time::Instant::now();
                    }

                    Tick::Progress {
                        pos,
                        raw_ms,
                        playing,
                    } => {
                        handle.emit("audio:tick", pos).ok();
                        timing::process_lyrics_timeline(&handle, &state, pos);
                        timing::process_comments_timeline(&handle, &state, pos);

                        if awaiting_first_progress && raw_ms > 0 {
                            awaiting_first_progress = false;
                            diagnostics::log_native(
                                &handle,
                                "INFO",
                                format!(
                                    "[Audio] пошёл звук: устройство забрало {raw_ms} мс \
                                     (позиция {pos:.2} с, играет={playing})"
                                ),
                            );
                        }

                        let now = std::time::Instant::now();

                        if !playing {
                            last_pos_ms = raw_ms;
                            last_progress_at = now;
                            continue;
                        }

                        if raw_ms > last_pos_ms {
                            last_pos_ms = raw_ms;
                            last_progress_at = now;
                            continue;
                        }

                        // Backward seek detected — reset stall tracking
                        if raw_ms < last_pos_ms.saturating_sub(500) {
                            last_pos_ms = raw_ms;
                            last_progress_at = now;
                            continue;
                        }

                        // Don't mistake a settling device switch/reconnect for a stall:
                        // the freshly opened output may not be pulling samples yet.
                        if engine::now_ms()
                            < state.suppress_stall_until_ms.load(Ordering::Relaxed)
                        {
                            last_progress_at = now;
                            continue;
                        }

                        if now < stall_cooldown_until {
                            continue;
                        }

                        if now.duration_since(last_progress_at).as_millis() as u64
                            > STALL_THRESHOLD_MS
                        {
                            diagnostics::log_native(
                                &handle,
                                "WARN",
                                "[Audio] Stall detected, reconnecting audio device",
                            );
                            // Reconnect device — stall often means the audio stream
                            // died silently (macOS sleep/wake, headphone unplug).
                            // Just reloading the track on a dead mixer won't help.
                            state.audio_tx.send(AudioThreadCmd::Reconnect).ok();
                            stall_cooldown_until = std::time::Instant::now()
                                + Duration::from_millis(STALL_COOLDOWN_MS);
                            last_progress_at = std::time::Instant::now();
                        }
                    }
                }
            }
        })
        .expect("failed to spawn tick thread");
}
