use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, State};
use tokio::task;

use crate::app::diagnostics::log_native;
use crate::audio::decode::{
    create_player_from_bytes, describe_bytes, resolve_normalization_gain, PreparedPlayer,
};
use crate::audio::state::AudioState;
use crate::audio::types::{AudioLoadResult, MediaCmd, EQ_BANDS, STALL_SUPPRESS_MS, TICK_INTERVAL_MS};
use crate::shared::hls;
use crate::shared::net::looks_like_proxy_failure;

const ENDED_SUPPRESS_MS: u64 = 1200;

/// Запас к окну заглушения `audio:ended` на время микширования: столько отводится на саму
/// загрузку входящего трека (сеть и декодирование) сверх длительности перехода. Разбор —
/// в `suppress_ended_during_crossfade`.
const CROSSFADE_LOAD_SLACK_MS: u64 = 8_000;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn suppress_ended_temporarily(state: &AudioState) {
    state
        .suppress_ended_until_ms
        .store(now_ms() + ENDED_SUPPRESS_MS, Ordering::Relaxed);
}

/// Заглушить `audio:ended` на всё микширование вместе с загрузкой входящего трека.
///
/// Уходящий трек при микшировании доигрывает до своего настоящего конца прямо во время
/// загрузки нового — и его `empty()` тик прочитает как «трек кончился». Интерфейс на это
/// событие включает следующий, то есть посреди начатого перехода поехал бы ещё один, уже
/// третий трек. Обычной паузы `ENDED_SUPPRESS_MS` тут мало: она рассчитана на мгновенную
/// замену плеера, а здесь между началом и передачей эстафеты стоит сеть.
///
/// Окно намеренно конечное, а не «до передачи эстафеты»: если загрузка провалится, событие
/// должно снова начать проходить — иначе трек кончится, и не случится вообще ничего.
fn suppress_ended_during_crossfade(state: &AudioState, crossfade_ms: u64) {
    state.suppress_ended_until_ms.store(
        now_ms() + crossfade_ms + CROSSFADE_LOAD_SLACK_MS,
        Ordering::Relaxed,
    );
}

/// Mute stall-detection (tick.rs) for a short window. A device switch briefly
/// freezes the old player and the freshly opened output may lag before it starts
/// pulling samples; without this the tick thread reads the gap as a dead stream and
/// fires a redundant reconnect mid-switch.
pub fn suppress_stall_temporarily(state: &AudioState) {
    state
        .suppress_stall_until_ms
        .store(now_ms() + STALL_SUPPRESS_MS, Ordering::Relaxed);
}

fn volume_to_rodio(v: f64) -> f32 {
    (v * 1.5).clamp(0.0, 2.0) as f32
}

/// Занять поколение загрузки — «этот вызов теперь главный».
///
/// Раньше загрузка только *читала* счётчик, а увеличивал его отдельный `audio_stop`,
/// который интерфейс посылал перед каждой загрузкой и не дожидался. Два независимых
/// сообщения по одному каналу к состоянию одного плеера — это гонка: приди `stop`
/// позже, чем загрузка успела собрать плеер, и он снимал уже новый трек. Снаружи это
/// и выглядело как «трек не включается, только иногда что-то мелькнёт»: звук был, ровно
/// до момента, когда опоздавший `stop` его забирал. Теперь поколение занимает сама
/// загрузка, и `stop` (настоящий, от пользователя) отменяет её честно — по номеру.
fn claim_load(state: &AudioState) -> u64 {
    state.load_gen.fetch_add(1, Ordering::Relaxed) + 1
}

fn superseded_by_newer(state: &AudioState, generation: u64) -> bool {
    state.load_gen.load(Ordering::Relaxed) != generation
}

/// Отменить загрузку, которая прямо сейчас в полёте, не трогая звук.
///
/// Нужно ровно там, где раньше интерфейс перед каждой загрузкой посылал `audio_stop`: тот
/// поднимал поколение (это и защищало от загрузки, запущенной предыдущим нажатием и
/// успевшей поставить свой плеер поверх нашего) — но заодно снимал плеер. При микшировании
/// снимать нельзя: прежний трек обязан доиграть под входящий. Так что от `stop` здесь
/// остаётся только его половина по делу.
pub fn cancel_pending_load(state: &AudioState) -> u64 {
    state.load_gen.fetch_add(1, Ordering::Relaxed) + 1
}

/// Шаг прогресса перехода за один тик при длине перехода `fade_ms`.
///
/// Прогресс — общий для обеих половин (0.0 → 1.0), громкость каждая считает из него по своей
/// кривой (`FadeInState::gain`, `CrossfadeState::gain`), поэтому шаг здесь один.
fn ramp_step(fade_ms: u64) -> f32 {
    let ticks = (fade_ms as f32 / TICK_INTERVAL_MS as f32).max(1.0);
    (1.0 / ticks).max(0.0005)
}

/// Громкость, с которой плеер должен звучать прямо сейчас: пользовательская, помноженная
/// на долю нарастания.
///
/// Пересборка плеера (перемотка, переоткрытие устройства) обязана брать её, а не голое
/// `state.volume`: попади пересборка в середину микширования, входящий трек прыгнул бы на
/// полную громкость, а тик продолжил бы вести его прогресс с того места, где он был, — то
/// есть громкость сперва скакнула бы вверх, а следующим тиком обратно вниз.
fn live_volume(state: &AudioState) -> f32 {
    let volume = *state.volume.lock().unwrap();
    let gain = state.fade_in.lock().unwrap().gain();
    volume * gain
}

/// Сбросить нарастание: множитель снова ничего не меняет.
fn reset_fade_in(state: &AudioState) {
    let mut fade = state.fade_in.lock().unwrap();
    fade.progress = 1.0;
    fade.step = 0.0;
}

/// Снять уходящий трек, если микширование ещё идёт. Плеер возвращается наружу, чтобы
/// `stop()` вызывался с отпущенным замком — как и во всех остальных снятиях здесь.
fn take_crossfade_player(state: &AudioState) -> Option<rodio::Player> {
    let mut crossfade = state.crossfade.lock().unwrap();
    crossfade.step = 0.0;
    crossfade.progress = 1.0;
    // Отложенный старт тоже отменяется: переход, которого больше нет, ждать нечему.
    crossfade.delay_ms = 0;
    crossfade.pending_ms = 0;
    crossfade.player.take()
}

/// Ждёт ли прямо сейчас начатый переход своего часа — то есть стоит ли входящий трек на
/// паузе не по воле человека.
pub fn crossfade_is_waiting(state: &AudioState) -> bool {
    state.crossfade.lock().unwrap().delay_ms > 0
}

/// Ключ кеша громкости для файла, если сверху его не передали.
///
/// Имя файла в кеше — `lomify_<источник>_<id>.audio`, то есть уже готовый уникальный
/// ключ трека. Без него `resolve_normalization_gain` каждый раз считает громкость заново
/// (тридцать секунд декодирования на каждое включение) и никуда её не пишет: обе половины
/// кеша выходят из строя от одного `None`.
fn normalization_key_from_path(path: &str) -> Option<String> {
    std::path::Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
}

/// Ссылка для лога — без строки запроса.
///
/// В хвосте подписанной ссылки на поток лежат подпись раздачи и опознавательные данные
/// клиента (у Яндекса `sign`, у SoundCloud `track_authorization`). В файл лога, который
/// человек приложит к жалобе, им попадать нельзя. Хоста и пути хватает, чтобы понять,
/// откуда шла загрузка.
fn url_for_log(url: &str) -> &str {
    url.split(|c| c == '?' || c == '#').next().unwrap_or(url)
}

fn stop_current_player(state: &AudioState) {
    suppress_ended_temporarily(state);
    // Снимаем и уходящий трек, если прямо сейчас идёт микширование: «снять прежнее»
    // означает всё прежнее. Иначе переключение вручную посреди перехода оставило бы
    // гаснущий хвост поверх нового трека — и человек услышал бы то, что уже пропустил.
    if let Some(fading) = take_crossfade_player(state) {
        fading.stop();
    }
    reset_fade_in(state);
    let old = state.player.lock().unwrap().take();
    if let Some(old) = old {
        old.stop();
    }
}

fn apply_current_rate(state: &AudioState, player: &rodio::Player) {
    let rate = *state.playback_rate.lock().unwrap();
    if (rate - 1.0).abs() > f32::EPSILON {
        player.set_speed(rate);
    }
}

/// Current playback speed as f64, floored away from zero so it's safe to divide by.
/// rodio's `get_pos()`/`try_seek()` operate in output (wall-clock) time = source/rate;
/// this lets callers convert to/from the source timeline the rest of the app uses.
pub fn current_rate(state: &AudioState) -> f64 {
    (*state.playback_rate.lock().unwrap() as f64).max(0.01)
}

/// Current position in **source seconds**, integrated from rodio's wall-clock get_pos().
/// Exact across mid-track speed changes (each constant-rate segment is closed into the
/// anchor by set_playback_rate). Does NOT lock `state.player` — pass the held player.
pub fn source_pos(state: &AudioState, player: &rodio::Player) -> f64 {
    let rate = current_rate(state);
    let (src_anchor, out_anchor) = *state.pos_anchor.lock().unwrap();
    (src_anchor + (player.get_pos().as_secs_f64() - out_anchor) * rate).max(0.0)
}

/// Re-base the integrator so subsequent get_pos() readings map to source `source`.
/// `output` is the get_pos() value that corresponds to that source position right now.
fn set_pos_anchor(state: &AudioState, source: f64, output: f64) {
    *state.pos_anchor.lock().unwrap() = (source.max(0.0), output.max(0.0));
}

/// Передать эстафету: прежний трек уходит в слот микширования, а входящий встаёт на его
/// место с нулевой громкостью.
///
/// `delay_ms` — сколько уходящему играть в одиночку до начала перехода (см.
/// [`CrossfadeState::delay_ms`]). Пока идёт ожидание, шаги нулевые: прогресс стоит, уходящий
/// звучит на полной громкости, входящий молчит — его на паузу ставит вызывающий, здесь только
/// счёт. Отсчёт ведёт тик.
///
/// Порядок здесь не косметика. Прогресс выставляется ДО установки нового плеера, потому что
/// тик читает его каждые 100 мс: увидь он новый плеер раньше, чем нулевой прогресс, — выставил
/// бы ему полную громкость, и вместо перехода получился бы щелчок.
fn begin_crossfade(state: &AudioState, crossfade_ms: u64, delay_ms: u64) {
    let step = if delay_ms > 0 {
        0.0
    } else {
        ramp_step(crossfade_ms)
    };
    {
        let mut fade = state.fade_in.lock().unwrap();
        fade.progress = 0.0;
        fade.step = step;
    }
    let previous = state.player.lock().unwrap().take();
    let displaced = {
        let mut crossfade = state.crossfade.lock().unwrap();
        crossfade.progress = 0.0;
        crossfade.step = step;
        crossfade.delay_ms = delay_ms;
        crossfade.pending_ms = crossfade_ms;
        std::mem::replace(&mut crossfade.player, previous)
    };
    // Тот, кто гас до нас (переключили дважды подряд), снимается сразу: третьим голосом
    // он бы только сложил громкость.
    if let Some(old) = displaced {
        old.stop();
    }
}

/// Пустить отложенный переход: обе половины получают шаг, входящий трек — команду играть.
///
/// Зовётся из тика, когда `delay_ms` дотикал до нуля (или когда уходящий кончился раньше
/// срока). Возвращает `false`, если пускать нечего: ожидания нет или входящий плеер ещё не
/// встал на место — второе бывает в те доли микросекунды между `begin_crossfade` и установкой
/// плеера в `commit_loaded_track`, и тогда переход честнее отложить до следующего тика, чем
/// начать в один голос и оставить входящий трек на паузе навсегда.
pub fn start_pending_crossfade(state: &AudioState) -> bool {
    if state.player.lock().unwrap().is_none() {
        return false;
    }
    let step = {
        let mut crossfade = state.crossfade.lock().unwrap();
        if crossfade.delay_ms == 0 {
            return false;
        }
        let step = ramp_step(crossfade.pending_ms);
        crossfade.delay_ms = 0;
        crossfade.step = step;
        step
    };
    state.fade_in.lock().unwrap().step = step;
    if let Some(ref player) = *state.player.lock().unwrap() {
        player.play();
    }
    true
}

fn commit_loaded_track(
    state: &AudioState,
    bytes: Vec<u8>,
    new_player: rodio::Player,
    normalization_gain: f32,
    crossfade_ms: u64,
    remaining_ms: u64,
) {
    apply_current_rate(state, &new_player);
    // Микшировать есть с чем, только если уходящий трек ещё звучит. Загрузка бывает дольше
    // всего остатка (медленная сеть, первый полный проход по файлу для громкости) — и тогда
    // «переход» превратился бы в шестисекундное нарастание из тишины после паузы, то есть в
    // артефакт хуже обычного старта. Пустой источник — это именно «уже кончился»: у живого
    // плеера `empty()` ложно, даже когда он на паузе.
    let outgoing_alive = state
        .player
        .lock()
        .unwrap()
        .as_ref()
        .map(|player| !player.empty())
        .unwrap_or(false);
    if crossfade_ms > 0 && outgoing_alive {
        // Сколько уходящему играть одному: всё, что осталось от него сверх самого перехода.
        // Ноль (загрузка съела остаток или интерфейс не сказал, сколько его) — начинаем сразу,
        // как и было: это худший случай, но не сломанный.
        let delay_ms = remaining_ms.saturating_sub(crossfade_ms);
        if delay_ms > 0 {
            // Ждать входящий обязан молча: он подключён к микшеру с первого сэмпла, а его
            // выход — через delay_ms. Пауза, а не нулевая громкость: иначе трек к своему
            // выходу проиграл бы в тишину первые секунды, то есть начался бы с середины.
            new_player.pause();
        }
        begin_crossfade(state, crossfade_ms, delay_ms);
        // Длинное окно заглушения `audio:ended` отводилось на загрузку, а она только что
        // кончилась — возвращаем обычное. Иначе трек короче этого окна (склейка, интерлюдия)
        // доиграл бы до конца внутри него, событие не прошло бы, и дальше не поехало бы
        // ничего: тишина при живом плеере.
        suppress_ended_temporarily(state);
    } else {
        // Прежний плеер обычно снят ещё в начале загрузки (`stop_current_player`), но не
        // всегда: при заказанном микшировании его нарочно оставили доигрывать — и он кончился
        // сам, пока шла загрузка. Такой снимаем здесь, иначе пустой голос висел бы на микшере
        // до случайного мига, когда его дропнет присваивание ниже.
        let leftover = state.player.lock().unwrap().take();
        if let Some(old) = leftover {
            old.stop();
        }
        // Долю нарастания надо вернуть к единице: без этого трек, включённый вручную посреди
        // чужого перехода, унаследовал бы чужую недоигранную долю.
        reset_fade_in(state);
        if crossfade_ms > 0 {
            // Микширование заказывали, значит плеер собран молчащим (`build_vol = 0.0`). Раз
            // перехода не будет, громкость выставляем руками — иначе трек «играет» в нуле, и
            // это ровно тот случай, который снаружи выглядит как «включил, а тишина».
            let vol = *state.volume.lock().unwrap();
            new_player.set_volume(vol);
        }
    }
    *state.player.lock().unwrap() = Some(new_player);
    *state.source_bytes.lock().unwrap() = Some(bytes);
    *state.normalization_gain.lock().unwrap() = normalization_gain;
    // Fresh track starts at source 0 / output 0.
    set_pos_anchor(state, 0.0, 0.0);
    state.has_track.store(true, Ordering::Relaxed);
    state.ended_notified.store(false, Ordering::Relaxed);
    state.device_error.store(false, Ordering::Relaxed);
}

// Все 9 параметров — это один build шаг плеера: mixer/volume/normalization-кеш
// + eq + analyser идут в одну `spawn_blocking`-обертку. Заводить отдельную
// структуру `BuildPlayerArgs` ради одной точки вызова — лишний слой.
#[allow(clippy::too_many_arguments)]
async fn build_player_from_bytes(
    bytes: Vec<u8>,
    mixer: rodio::mixer::Mixer,
    volume: f32,
    normalization_enabled: bool,
    normalization_cache_dir: Option<PathBuf>,
    normalization_cache_key: Option<String>,
    start_paused: bool,
    eq_params: std::sync::Arc<std::sync::RwLock<crate::audio::types::EqParams>>,
    analyser_buffer: std::sync::Arc<crate::audio::analyser::AnalyserBuffer>,
) -> Result<(Vec<u8>, PreparedPlayer, f32), String> {
    task::spawn_blocking(move || {
        let normalization_gain = if normalization_enabled {
            resolve_normalization_gain(
                &bytes,
                normalization_cache_dir.as_deref(),
                normalization_cache_key.as_deref(),
            )?
        } else {
            1.0
        };
        let prepared = create_player_from_bytes(
            &bytes,
            &mixer,
            volume,
            normalization_gain,
            start_paused,
            eq_params,
            analyser_buffer,
        )?;
        Ok((bytes, prepared, normalization_gain))
    })
    .await
    .map_err(|e| format!("audio decode task failed: {e}"))?
}

/// Поставить собранный плеер в работу и записать в лог всё, что о нём известно.
///
/// Отдельная функция — потому что интересна не сама установка, а `empty()` сразу после
/// сборки. Пустая очередь означает, что декодер не дал ни одного кадра: через долю секунды
/// тик пришлёт `audio:ended`, интерфейс перещёлкнет на следующий трек, и так по кругу.
/// Снаружи это ровно «треки не включаются, только иногда что-то мелькнёт» — и до этой
/// строчки в логе отличить такое от «звук не дошёл до устройства» было нечем.
#[allow(clippy::too_many_arguments)]
fn commit_and_log(
    app: &AppHandle,
    state: &AudioState,
    label: &str,
    bytes: Vec<u8>,
    prepared: PreparedPlayer,
    normalization_gain: f32,
    volume: f32,
    crossfade_ms: u64,
    remaining_ms: u64,
    elapsed_ms: u128,
) -> AudioLoadResult {
    let PreparedPlayer {
        player,
        duration_secs,
        decoder,
        sample_rate,
        channels,
    } = prepared;
    let empty = player.empty();
    let paused = player.is_paused();
    let duration_text = duration_secs
        .map(|secs| format!("{secs:.1} с"))
        .unwrap_or_else(|| "неизвестна".to_string());
    // Остаток уходящего трека интерфейс называл до загрузки, а загрузка шла время — вот
    // сколько его осталось на самом деле.
    let remaining_now = remaining_ms.saturating_sub(elapsed_ms as u64);
    let crossfade_text = if crossfade_ms > 0 {
        format!(
            ", микширование {crossfade_ms} мс (у прежнего осталось {remaining_now} мс)"
        )
    } else {
        String::new()
    };
    log_native(
        app,
        if empty { "WARN" } else { "INFO" },
        format!(
            "[Audio] плеер собран ({label}): {decoder}, {sample_rate} Гц, {channels} кан., \
             длительность {duration_text}, громкость {volume:.3} × нормализация \
             {normalization_gain:.3}, пауза={paused}, пусто={empty}{crossfade_text}, {elapsed_ms} мс"
        ),
    );

    commit_loaded_track(
        state,
        bytes,
        player,
        normalization_gain,
        crossfade_ms,
        remaining_now,
    );
    AudioLoadResult::loaded(duration_secs)
}

pub fn reload_current_track(state: &AudioState) -> Result<(), String> {
    suppress_ended_temporarily(state);
    suppress_stall_temporarily(state);
    let bytes = state.source_bytes.lock().unwrap().clone();
    let Some(bytes) = bytes else {
        return Ok(());
    };

    let rate = current_rate(state);
    let (source_position, was_paused) = {
        let player = state.player.lock().unwrap();
        let Some(player) = player.as_ref() else {
            return Ok(());
        };
        (source_pos(state, player), player.is_paused())
    };

    let mixer = state.mixer.lock().unwrap().clone();
    let vol = live_volume(state);
    let normalization_enabled = state.normalization_enabled.load(Ordering::Relaxed);
    let normalization_gain = *state.normalization_gain.lock().unwrap();
    let new_player = create_player_from_bytes(
        &bytes,
        &mixer,
        vol,
        if normalization_enabled {
            normalization_gain
        } else {
            1.0
        },
        was_paused,
        state.eq_params.clone(),
        state.analyser_buffer.clone(),
    )?
    .player;
    // Apply speed BEFORE seeking so try_seek's argument is interpreted under the speed
    // factor: try_seek(source/rate) lands the decoder at the original source position.
    let output_target = source_position / rate;
    apply_current_rate(state, &new_player);
    if source_position > 0.0 {
        new_player
            .try_seek(Duration::from_secs_f64(output_target))
            .ok();
    }

    let mut player = state.player.lock().unwrap();
    if let Some(old) = player.take() {
        old.stop();
    }
    *player = Some(new_player);
    set_pos_anchor(state, source_position, output_target);
    state.has_track.store(true, Ordering::Relaxed);
    state.ended_notified.store(false, Ordering::Relaxed);
    state.device_error.store(false, Ordering::Relaxed);

    Ok(())
}

pub async fn load_file(
    path: String,
    normalization_cache_dir: Option<PathBuf>,
    normalization_cache_key: Option<String>,
    start_paused: bool,
    crossfade_ms: u64,
    remaining_ms: u64,
    app: &AppHandle,
    state: State<'_, AudioState>,
) -> Result<AudioLoadResult, String> {
    let generation = claim_load(&state);
    let started = std::time::Instant::now();
    if crossfade_ms > 0 {
        // Микширование: прежний трек обязан доиграть под входящий, поэтому снимать его
        // сейчас нельзя — эстафету передаст `begin_crossfade` уже после сборки.
        suppress_ended_during_crossfade(&state, crossfade_ms);
    } else {
        // Прежний трек снимаем сразу, а не после чтения файла с диска: между нажатием и
        // первым сэмплом нового трека не должно доигрывать предыдущее.
        stop_current_player(&state);
    }

    let bytes = task::spawn_blocking({
        let path = path.clone();
        move || std::fs::read(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
    })
    .await
    .map_err(|e| format!("audio file read task failed: {e}"))??;

    let short_name = normalization_key_from_path(&path).unwrap_or_else(|| path.clone());
    log_native(
        app,
        "INFO",
        format!(
            "[Audio] загрузка из файла #{generation} {short_name}: {}",
            describe_bytes(&bytes)
        ),
    );

    if superseded_by_newer(&state, generation) {
        log_native(
            app,
            "INFO",
            format!("[Audio] загрузка #{generation} отменена: пришла более свежая"),
        );
        return Ok(AudioLoadResult::superseded());
    }

    let mixer = state.mixer.lock().unwrap().clone();
    let vol = *state.volume.lock().unwrap();
    // При микшировании входящий плеер собирается с нулевой громкостью: `create_player_from_bytes`
    // подключает его к микшеру и он звучит с первого же сэмпла, ещё до передачи эстафеты, —
    // собери его с полной, и вместо перехода вышел бы залп поверх уходящего трека.
    let build_vol = if crossfade_ms > 0 { 0.0 } else { vol };
    let normalization_enabled = state.normalization_enabled.load(Ordering::Relaxed);
    let (bytes, prepared, normalization_gain) = build_player_from_bytes(
        bytes,
        mixer,
        build_vol,
        normalization_enabled,
        normalization_cache_dir,
        normalization_cache_key.or_else(|| normalization_key_from_path(&path)),
        start_paused,
        state.eq_params.clone(),
        state.analyser_buffer.clone(),
    )
    .await?;

    if superseded_by_newer(&state, generation) {
        log_native(
            app,
            "INFO",
            format!("[Audio] загрузка #{generation} отменена после сборки: пришла более свежая"),
        );
        // Собранный плеер уже подключён к микшеру, так что его надо снять руками: при
        // микшировании он молчит (нулевая громкость), и молчащий голос легко не заметить —
        // он всё равно тянет декодирование каждым кадром микшера.
        prepared.player.stop();
        return Ok(AudioLoadResult::superseded());
    }

    Ok(commit_and_log(
        app,
        &state,
        &format!("файл #{generation}"),
        bytes,
        prepared,
        normalization_gain,
        vol,
        crossfade_ms,
        remaining_ms,
        started.elapsed().as_millis(),
    ))
}

/// `User-Agent` для скачивания самого аудио.
///
/// `reqwest::Client::new()` не посылает `User-Agent` вообще — заголовка просто нет в запросе.
/// Для бэкенда SoundCloud это безразлично, а раздача Яндекс Музыки на запрос без него
/// отвечает 403, и подписанная ссылка при этом совершенно валидна: подпись проверяется, но
/// клиент без опознавательных знаков до файла не допускается. В приложении это выглядело как
/// «трек заблокирован» — то есть ошибка транспорта выдавала себя за региональный запрет.
///
/// Значение — обычный Chrome: именно так ходит веб-плеер music.yandex.ru, а `get-mp3`-ссылки
/// мы строим по его же схеме, так что и представляться логично так же.
const STREAM_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

pub async fn load_url(
    url: String,
    session_id: Option<String>,
    cache_path: Option<String>,
    normalization_cache_dir: Option<PathBuf>,
    normalization_cache_key: Option<String>,
    start_paused: bool,
    crossfade_ms: u64,
    remaining_ms: u64,
    app: &AppHandle,
    state: State<'_, AudioState>,
) -> Result<AudioLoadResult, String> {
    let generation = claim_load(&state);
    let started = std::time::Instant::now();
    if crossfade_ms > 0 {
        // Микширование: уходящий трек играет всё время скачивания и передаст эстафету только
        // после сборки. Заглушение `audio:ended` покрывает и это время — иначе трек кончится
        // сам, интерфейс включит следующий, и посреди перехода поедет третий.
        suppress_ended_during_crossfade(&state, crossfade_ms);
    } else {
        // Старый трек снимаем сразу, до сети: скачивание идёт секунды, и всё это время
        // прежний трек продолжал играть поверх уже выбранного нового.
        stop_current_player(&state);
    }
    log_native(
        app,
        "INFO",
        format!(
            "[Audio] загрузка из сети #{generation}: {}",
            url_for_log(&url)
        ),
    );

    let build_client = |bypass_proxy: bool| {
        let builder = reqwest::Client::builder().user_agent(STREAM_USER_AGENT);
        let builder = if bypass_proxy {
            builder.no_proxy()
        } else {
            builder
        };
        builder.build()
    };

    let mut client = build_client(false).map_err(|e| e.to_string())?;
    let mut bypassed_proxy = false;
    let retry_delays = [300u64, 800, 2000];
    let mut last_err = String::new();
    let mut bytes: Vec<u8> = Vec::new();
    // Адрес, от которого считать относительные пути, если по ссылке окажется плейлист:
    // после редиректов он может отличаться от запрошенного.
    let mut final_url = url.clone();
    let mut success = false;

    for attempt in 0..=retry_delays.len() {
        let mut req = client.get(&url).header("Accept", "*/*");
        if let Some(sid) = &session_id {
            req = req.header("x-session-id", sid);
        }

        match req.send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    final_url = resp.url().to_string();
                    match resp.bytes().await {
                        Ok(b) => {
                            bytes = b.to_vec();
                            success = true;
                            break;
                        }
                        Err(e) => last_err = e.to_string(),
                    }
                } else if status.as_u16() == 429
                    || (status.as_u16() >= 500 && status.as_u16() <= 599)
                {
                    last_err = format!("HTTP {}", status);
                } else if status.as_u16() == 403 || status.as_u16() == 410 {
                    // Ссылка на поток подписана и живёт минуты. 403/410 здесь почти всегда
                    // значит «подпись просрочена», а не «нельзя»: повтор по тому же адресу
                    // бессмысленен, нужна новая ссылка. Говорим об этом прямо, иначе выше по
                    // стеку это снова превратится в «трек заблокирован в регионе».
                    let message = format!(
                        "HTTP {} — ссылка на поток отклонена раздачей (скорее всего просрочена подпись)",
                        status.as_u16()
                    );
                    log_native(
                        app,
                        "WARN",
                        format!("[Audio] загрузка #{generation} не удалась: {message}"),
                    );
                    return Err(message);
                } else {
                    log_native(
                        app,
                        "WARN",
                        format!("[Audio] загрузка #{generation} не удалась: HTTP {status}"),
                    );
                    return Err(format!("HTTP {}", status));
                }
            }
            Err(e) => {
                let msg = e.to_string();
                // Мёртвый системный прокси (выключенный VPN с оставшейся галкой в Windows)
                // рубит загрузку целиком, и по тому же маршруту повторять нечего. Один раз
                // уходим в обход и, если помогло, остаёмся напрямую до конца загрузки.
                if !bypassed_proxy && looks_like_proxy_failure(&msg) {
                    bypassed_proxy = true;
                    if let Ok(direct) = build_client(true) {
                        client = direct;
                        last_err = msg;
                        continue;
                    }
                }
                last_err = msg;
            }
        }

        if attempt < retry_delays.len() {
            tokio::time::sleep(std::time::Duration::from_millis(retry_delays[attempt])).await;
            if superseded_by_newer(&state, generation) {
                log_native(
                    app,
                    "INFO",
                    format!("[Audio] загрузка #{generation} отменена между попытками"),
                );
                return Ok(AudioLoadResult::superseded());
            }
        }
    }

    if !success {
        let message = if bypassed_proxy {
            format!("{last_err} (пробовал и в обход системного прокси — не помогло)")
        } else {
            last_err
        };
        log_native(
            app,
            "WARN",
            format!("[Audio] загрузка #{generation} не удалась: {message}"),
        );
        return Err(message);
    }

    log_native(
        app,
        "INFO",
        format!(
            "[Audio] скачано #{generation}: {} за {} мс",
            describe_bytes(&bytes),
            started.elapsed().as_millis()
        ),
    );

    // По ссылке могло приехать не аудио, а HLS-плейлист: у SoundCloud такие transcoding'и
    // стоят в выдаче раньше progressive, так что это обычный случай, а не редкость. Раньше
    // текст манифеста уходил прямо в декодер, тот его, естественно, не понимал — и трек
    // «не воспроизводился», хотя из кэша тот же трек играл (кэшу HLS собирал анонимный путь).
    if hls::looks_like_playlist(&bytes) {
        let manifest = String::from_utf8_lossy(&bytes).into_owned();
        bytes = hls::assemble(&client, &manifest, &final_url).await?.to_vec();
        log_native(
            app,
            "INFO",
            format!(
                "[Audio] HLS собран #{generation}: {}",
                describe_bytes(&bytes)
            ),
        );

        if superseded_by_newer(&state, generation) {
            return Ok(AudioLoadResult::superseded());
        }
    }

    if superseded_by_newer(&state, generation) {
        log_native(
            app,
            "INFO",
            format!("[Audio] загрузка #{generation} отменена после скачивания"),
        );
        return Ok(AudioLoadResult::superseded());
    }

    if let Some(path) = cache_path.as_deref() {
        let path = path.to_string();
        let data = bytes.clone();
        tokio::spawn(async move {
            tokio::fs::write(&path, &data).await.ok();
        });
    }

    let mixer = state.mixer.lock().unwrap().clone();
    let vol = *state.volume.lock().unwrap();
    // Ноль на время микширования — разбор там же, где и в `load_file`.
    let build_vol = if crossfade_ms > 0 { 0.0 } else { vol };
    let normalization_enabled = state.normalization_enabled.load(Ordering::Relaxed);
    let (bytes, prepared, normalization_gain) = build_player_from_bytes(
        bytes,
        mixer,
        build_vol,
        normalization_enabled,
        normalization_cache_dir,
        // Путь, по которому этот же поток ляжет в кеш, — готовый ключ трека. Без него
        // громкость считается заново на каждое включение и никуда не пишется.
        normalization_cache_key
            .or_else(|| cache_path.as_deref().and_then(normalization_key_from_path)),
        start_paused,
        state.eq_params.clone(),
        state.analyser_buffer.clone(),
    )
    .await?;

    if superseded_by_newer(&state, generation) {
        log_native(
            app,
            "INFO",
            format!("[Audio] загрузка #{generation} отменена после сборки"),
        );
        prepared.player.stop();
        return Ok(AudioLoadResult::superseded());
    }

    Ok(commit_and_log(
        app,
        &state,
        &format!("поток #{generation}"),
        bytes,
        prepared,
        normalization_gain,
        vol,
        crossfade_ms,
        remaining_ms,
        started.elapsed().as_millis(),
    ))
}

pub fn play(app: &AppHandle, state: State<'_, AudioState>) {
    // If the device errored (sleep/wake, headphone unplug), reconnect immediately
    // instead of waiting for stall detection (2s delay).
    if state.device_error.load(Ordering::Relaxed) {
        log_native(
            app,
            "WARN",
            "[Audio] play при ошибке устройства — прошу переоткрыть вывод",
        );
        state
            .audio_tx
            .send(crate::audio::types::AudioThreadCmd::Reconnect)
            .ok();
    }
    // Blocking lock, NOT try_lock. The tick thread touches `state.player` 10x/s; a
    // try_lock that lost that race silently discarded the user's play/pause with no
    // error anywhere. The tick thread now releases the lock before emitting, so the
    // wait here is a couple of reads long.
    // Always unpause so reload_current_track sees was_paused=false.
    // Кроме одного случая: входящий трек, который ждёт своего выхода в отложенном переходе,
    // будить нельзя — он вступит в свой момент, и пустит его тик. Иначе «продолжить» после
    // паузы посреди перехода включило бы оба трека сразу, с полного нуля у входящего.
    let waiting = crossfade_is_waiting(&state);
    let described = match *state.player.lock().unwrap() {
        Some(ref player) => {
            if !waiting {
                player.play();
            }
            format!("пусто={}, позиция={:?}", player.empty(), player.get_pos())
        }
        // Самый важный случай в этой строке: «включить» пришло, а включать нечего.
        // Именно так выглядит тишина без единой ошибки — интерфейс уверен, что играет.
        None => "плеера нет".to_string(),
    };
    // Уходящий трек слушается тех же кнопок. Иначе пауза посреди перехода оставила бы его
    // звучать и гаснуть ещё пару секунд — то есть кнопка «пауза» не останавливала бы музыку.
    resume_crossfade_player(&state);
    log_native(app, "INFO", format!("[Audio] play — {described}"));
}

/// Продолжить уходящий трек, если микширование ещё идёт.
fn resume_crossfade_player(state: &AudioState) {
    if let Some(ref fading) = state.crossfade.lock().unwrap().player {
        fading.play();
    }
}

pub fn pause(app: &AppHandle, state: State<'_, AudioState>) {
    if let Some(ref player) = *state.player.lock().unwrap() {
        player.pause();
    }
    if let Some(ref fading) = state.crossfade.lock().unwrap().player {
        fading.pause();
    }
    log_native(app, "INFO", "[Audio] pause");
}

pub fn stop(app: &AppHandle, state: State<'_, AudioState>) {
    state.has_track.store(false, Ordering::Relaxed);
    // Отменяет и любую загрузку, которая прямо сейчас в полёте: она сверит поколение
    // перед установкой плеера и отступит (см. `claim_load`).
    let generation = state.load_gen.fetch_add(1, Ordering::Relaxed) + 1;
    // Уходящий трек снимается вместе с основным: «остановить» означает тишину, а не
    // «тишину, кроме того хвоста, который сейчас гаснет».
    if let Some(fading) = take_crossfade_player(&state) {
        fading.stop();
    }
    reset_fade_in(&state);
    // Take out of the guard first so `old.stop()` runs with the mutex released.
    let old = state.player.lock().unwrap().take();
    let had_player = old.is_some();
    if let Some(old) = old {
        old.stop();
    }
    *state.source_bytes.lock().unwrap() = None;
    log_native(
        app,
        "INFO",
        format!("[Audio] stop — плеер был={had_player}, поколение теперь #{generation}"),
    );
}

pub fn seek(position: f64, state: &AudioState) -> Result<(), String> {
    suppress_ended_temporarily(state);
    seek_to(state, position)
}

/// Seek to `position` (source seconds), trying an in-place decoder seek first and
/// recreating the player when that fails. A bare `try_seek` silently no-ops on
/// decoders that can't seek in place, so any caller that needs the jump to actually
/// take effect (the manual slider, the A-B loop snap-back in tick.rs) must route
/// through here. Takes `&AudioState` so the tick thread can call it without `State`.
pub fn seek_to(state: &AudioState, position: f64) -> Result<(), String> {
    // `position` is in source seconds (the timeline the whole app uses). rodio's
    // try_seek operates in output time = source/rate on a speed-applied player, so
    // convert before handing it the target.
    let rate = current_rate(state);
    let output_target = (position / rate).max(0.0);
    let target = Duration::from_secs_f64(output_target);
    let was_paused = state
        .player
        .lock()
        .unwrap()
        .as_ref()
        .map(|player| player.is_paused())
        .unwrap_or(false);

    // For position 0 or backward seek, always recreate the player to avoid decoder state issues
    let mut try_seek_success = false;
    if position > 0.0 {
        let player = state.player.lock().unwrap();
        if let Some(ref player) = *player {
            if target >= player.get_pos() && player.try_seek(target).is_ok() {
                try_seek_success = true;
            }
        }
    }

    if try_seek_success {
        state.ended_notified.store(false, Ordering::Relaxed);
        set_pos_anchor(state, position, output_target);
        return Ok(());
    }

    let bytes = state.source_bytes.lock().unwrap().clone();
    let Some(bytes) = bytes else {
        return Err("No source to reload for seek".into());
    };

    let mixer = state.mixer.lock().unwrap().clone();
    let vol = live_volume(state);
    let normalization_enabled = state.normalization_enabled.load(Ordering::Relaxed);
    let normalization_gain = *state.normalization_gain.lock().unwrap();
    let (new_player, _) = create_player_from_bytes(
        &bytes,
        &mixer,
        vol,
        if normalization_enabled {
            normalization_gain
        } else {
            1.0
        },
        was_paused,
        state.eq_params.clone(),
        state.analyser_buffer.clone(),
    )
    .map(|prepared| (prepared.player, prepared.duration_secs))?;
    apply_current_rate(state, &new_player);
    if position > 0.0 {
        new_player.try_seek(target).ok();
    }

    let mut player = state.player.lock().unwrap();
    if let Some(old) = player.take() {
        old.stop();
    }
    *player = Some(new_player);
    set_pos_anchor(state, position, output_target);
    state.ended_notified.store(false, Ordering::Relaxed);

    Ok(())
}

pub fn set_volume(volume: f64, state: State<'_, AudioState>) {
    let vol = volume_to_rodio(volume);
    *state.volume.lock().unwrap() = vol;
    // Обоим голосам — пользовательская громкость, помноженная на их долю. Иначе ползунок
    // посреди перехода выкинул бы входящий трек сразу на полную (а уходящий вернул бы из
    // почти-тишины), и следующий тик тут же дёрнул бы громкость назад.
    let fade_gain = state.fade_in.lock().unwrap().gain();
    if let Some(ref player) = *state.player.lock().unwrap() {
        player.set_volume(vol * fade_gain);
    }
    let crossfade = state.crossfade.lock().unwrap();
    let crossfade_gain = crossfade.gain();
    if let Some(ref fading) = crossfade.player {
        fading.set_volume(vol * crossfade_gain);
    }
}

fn clamp_playback_rate(rate: f64) -> f32 {
    let adjusted_rate = 1.0 + (rate - 1.0) * 0.85; // Снижаем питч на 15% от разницы
    (adjusted_rate.clamp(0.5, 2.0)) as f32
}

pub fn set_playback_rate(rate: f64, state: State<'_, AudioState>) {
    let value = clamp_playback_rate(rate);
    let player_guard = state.player.lock().unwrap();
    if let Some(ref player) = *player_guard {
        // Close the current constant-rate segment into the integrator BEFORE switching
        // speed, so source-time stays exact across the change (no re-seek, no glitch).
        let old_rate = current_rate(&state);
        let out = player.get_pos().as_secs_f64();
        {
            let mut anchor = state.pos_anchor.lock().unwrap();
            anchor.0 += (out - anchor.1) * old_rate;
            anchor.1 = out;
        }
        *state.playback_rate.lock().unwrap() = value;
        player.set_speed(value);
    } else {
        *state.playback_rate.lock().unwrap() = value;
    }
}

pub fn get_position(state: State<'_, AudioState>) -> f64 {
    state
        .player
        .lock()
        .unwrap()
        .as_ref()
        .map(|player| source_pos(&state, player))
        .unwrap_or(0.0)
}

/// Set or clear the A-B loop region. `a`/`b` are in source seconds; a valid region
/// needs both bounds with `b` meaningfully after `a`. Anything else clears the loop.
pub fn set_ab_loop(a: Option<f64>, b: Option<f64>, state: State<'_, AudioState>) {
    let value = match (a, b) {
        (Some(a), Some(b)) if b > a + 0.05 => Some((a.max(0.0), b)),
        _ => None,
    };
    *state.ab_loop.lock().unwrap() = value;
}

pub fn set_eq(enabled: bool, gains: Vec<f64>, state: State<'_, AudioState>) {
    if let Ok(mut params) = state.eq_params.write() {
        params.enabled = enabled;
        for (index, &gain) in gains.iter().enumerate().take(EQ_BANDS) {
            params.gains[index] = gain.clamp(-12.0, 12.0);
        }
    }
}

pub fn set_normalization(enabled: bool, state: State<'_, AudioState>) {
    state
        .normalization_enabled
        .store(enabled, Ordering::Relaxed);
}

pub fn is_playing(state: State<'_, AudioState>) -> bool {
    state
        .player
        .lock()
        .unwrap()
        .as_ref()
        .map(|player| !player.is_paused() && !player.empty())
        .unwrap_or(false)
}

pub fn set_metadata(
    title: String,
    artist: String,
    cover_url: Option<String>,
    duration_secs: f64,
    state: State<'_, AudioState>,
) {
    if let Some(tx) = state.media_tx.lock().unwrap().as_ref() {
        tx.send(MediaCmd::SetMetadata {
            title,
            artist,
            cover_url,
            duration_secs,
        })
        .ok();
    }
}

pub fn set_playback_state(playing: bool, state: State<'_, AudioState>) {
    if let Some(tx) = state.media_tx.lock().unwrap().as_ref() {
        tx.send(MediaCmd::SetPlaying(playing)).ok();
    }
}

pub fn set_media_position(position: f64, state: State<'_, AudioState>) {
    if let Some(tx) = state.media_tx.lock().unwrap().as_ref() {
        tx.send(MediaCmd::SetPosition(position)).ok();
    }
}

pub async fn save_track_to_path(cache_path: String, dest_path: String) -> Result<String, String> {
    tokio::fs::copy(&cache_path, &dest_path)
        .await
        .map_err(|e| format!("Copy failed: {}", e))?;
    Ok(dest_path)
}

/* ── Hover-preview channel ───────────────────────────────────────
 * A parallel lightweight player on the shared mixer for ~15s on-hover
 * previews. Sources from an already-cached file (reusing track_cache),
 * gets its own throwaway analyser so the main player's spectrum stays
 * intact, and fades via a tick-thread volume ramp (see tick.rs). Never
 * touches the main player or plays history.
 */

fn preview_step(target: f32, fade_ms: u64) -> f32 {
    let ticks = (fade_ms as f32 / TICK_INTERVAL_MS as f32).max(1.0);
    (target / ticks).max(0.0005)
}

/// Start (or replace) the hover preview from a cached file `path` at `volume`
/// (rodio scale 0.0..2.0). The decode runs off-thread. `gen` is a monotonic token
/// from the frontend: an out-of-order (older) decode that finishes after a newer
/// hover installed its preview is dropped. There is no play-side fade-in (the
/// sample starts at target volume); fade-OUT lives in `preview_stop`.
pub async fn preview_play(
    path: String,
    volume: f64,
    gen: u64,
    state: State<'_, AudioState>,
) -> Result<(), String> {
    // Cheap pre-check: a hover already superseded by a newer one shouldn't pay for
    // the file read + decode (the authoritative gen check still runs post-decode).
    if gen < state.preview.lock().unwrap().gen {
        return Ok(());
    }
    let bytes = task::spawn_blocking({
        let path = path.clone();
        move || std::fs::read(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
    })
        .await
        .map_err(|e| format!("preview read task failed: {e}"))??;

    let mixer = state.mixer.lock().unwrap().clone();
    let eq_params = state.eq_params.clone();
    let target = (volume as f32).clamp(0.0, 2.0);
    // Own throwaway analyser buffer — the preview decoder must NOT write into the
    // main player's spectrum buffer. Normalization is skipped (gain 1.0) to keep
    // hover latency low. Build directly at the target volume so the sample is
    // audible the instant it loads (a zero-start + tick fade-in left it silent).
    let analyser = crate::audio::analyser::AnalyserBuffer::new();
    let player = task::spawn_blocking(move || {
        create_player_from_bytes(&bytes, &mixer, target, 1.0, false, eq_params, analyser)
            .map(|prepared| prepared.player)
    })
        .await
        .map_err(|e| format!("preview decode task failed: {e}"))??;
    player.play();

    let mut preview = state.preview.lock().unwrap();
    // A newer hover already installed its preview — drop this stale decode.
    if gen < preview.gen {
        player.stop();
        return Ok(());
    }
    if let Some(old) = preview.player.take() {
        old.stop();
    }
    preview.player = Some(player);
    preview.volume = target;
    preview.target = target;
    preview.step = 0.0;
    preview.stop_at_zero = false;
    preview.gen = gen;
    Ok(())
}

/// Stop the hover preview. `gen == 0` force-stops whatever is playing (unhover /
/// click); a non-zero `gen` is a targeted stale-stop that no-ops unless it still
/// matches the installed preview. With `fade_ms > 0` it fades out (the tick
/// thread drops the player at zero); with 0 it stops immediately.
pub fn preview_stop(fade_ms: u64, gen: u64, state: State<'_, AudioState>) {
    let mut preview = state.preview.lock().unwrap();
    if preview.player.is_none() {
        return;
    }
    // Targeted stop for a preview that's already been superseded — ignore.
    if gen != 0 && gen != preview.gen {
        return;
    }
    if fade_ms == 0 {
        if let Some(old) = preview.player.take() {
            old.stop();
        }
        preview.volume = 0.0;
        preview.target = 0.0;
        preview.step = 0.0;
        preview.stop_at_zero = false;
        return;
    }
    preview.step = preview_step(preview.volume.max(0.0005), fade_ms);
    preview.target = 0.0;
    preview.stop_at_zero = true;
}
