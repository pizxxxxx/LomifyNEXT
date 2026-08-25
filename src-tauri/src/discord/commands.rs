use std::sync::{Arc, Mutex};

use discord_rich_presence::{
    activity::{Activity, ActivityType, Assets, Button, Timestamps},
    DiscordIpc, DiscordIpcClient,
};

use crate::shared::constants::DISCORD_CLIENT_ID;

pub struct DiscordState {
    pub client: Mutex<Option<DiscordIpcClient>>,
}

#[derive(serde::Deserialize)]
pub struct DiscordTrackInfo {
    title: String,
    artist: String,
    artwork_url: Option<String>,
    track_url: Option<String>,
    duration_secs: Option<i64>,
    elapsed_secs: Option<i64>,
    is_playing: Option<bool>,
    mode: Option<DiscordRpcMode>,
    show_button: Option<bool>,
    /// Где человек слушает: «Яндекс Музыка», «SoundCloud», «Локальный файл». Готовая подпись
    /// от интерфейса, а не код источника, — здесь её только вставляют в строку, и знать про
    /// внутренние имена сервисов этой стороне незачем.
    ///
    /// `Option`, потому что источник известен не всегда (трек из истории, ручной импорт), а
    /// придумывать за него нельзя: «слушаю в SoundCloud» про локальный файл — это ложь в
    /// профиле человека.
    source: Option<String>,
}

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscordRpcMode {
    Track,
    Artist,
    Activity,
}

/// Обрезать строку до `max` байт по границе символа.
///
/// Discord отклоняет `state`/`details` длиннее 128 байт целиком — не обрезает, а отвечает
/// ошибкой, то есть статус просто не обновляется. Со источником в той же строке предел стал
/// достижимым: у трека с четырьмя авторами и «Яндекс Музыка» на хвосте набегает и больше.
/// Резать надо по `char_indices`: `&s[..max]` на русском тексте почти наверняка попадёт в
/// середину двухбайтового символа и уронит поток паникой.
fn clamp_bytes(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    let end = value
        .char_indices()
        .map(|(index, ch)| index + ch.len_utf8())
        .take_while(|end| *end <= max.saturating_sub(1))
        .last()
        .unwrap_or(0);
    format!("{}…", &value[..end])
}

/// Предел Discord на `details`/`state`.
const DISCORD_FIELD_MAX: usize = 128;

/// Вторая строка статуса: автор, где слушают и пометка о паузе.
///
/// Источник идёт через `•` в ту же строку, а не в `small_text` под маленькой иконкой, как это
/// обычно делают: `small_text` показывается только вместе с `small_image`, а картинку взять
/// негде — ассеты приложения в портале Discord нам не принадлежат, а ссылка на чужой логотип
/// в интернете отвалится молча и в самый неудобный момент.
fn track_state(artist: &str, source: Option<&str>, is_playing: bool) -> String {
    let mut state = match source {
        Some(source) => format!("{artist} • {source}"),
        None => artist.to_string(),
    };
    if !is_playing {
        state.push_str(" (На паузе)");
    }
    clamp_bytes(&state, DISCORD_FIELD_MAX)
}

#[tauri::command]
pub async fn discord_connect(state: tauri::State<'_, Arc<DiscordState>>) -> Result<bool, String> {
    {
        let guard = state.client.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Ok(true);
        }
    }

    let connect_res = tokio::task::spawn_blocking(move || {
        let mut client = DiscordIpcClient::new(DISCORD_CLIENT_ID);
        let res = client.connect();
        (res, client)
    })
    .await
    .map_err(|e| e.to_string())?;

    match connect_res.0 {
        Ok(_) => {
            println!("[Discord] Connected");
            let mut guard = state.client.lock().map_err(|e| e.to_string())?;
            *guard = Some(connect_res.1);
            Ok(true)
        }
        Err(e) => {
            println!("[Discord] Connection failed: {e}");
            Err(format!("Connection failed: {e}"))
        }
    }
}

#[tauri::command]
pub fn discord_disconnect(state: tauri::State<'_, Arc<DiscordState>>) {
    let Ok(mut guard) = state.client.lock() else {
        return;
    };
    if let Some(ref mut client) = *guard {
        let _ = client.close();
        println!("[Discord] Disconnected");
    }
    *guard = None;
}

#[tauri::command]
pub fn discord_set_activity(
    state: tauri::State<'_, Arc<DiscordState>>,
    track: DiscordTrackInfo,
) -> Result<(), String> {
    let mut guard = state.client.lock().map_err(|e| e.to_string())?;
    let client = match guard.as_mut() {
        Some(c) => c,
        None => return Ok(()), // Silently ignore if not connected
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    let elapsed = track.elapsed_secs.unwrap_or(0);
    let start = now - elapsed;
    let is_playing = track.is_playing.unwrap_or(true);
    let mode = track.mode.unwrap_or(DiscordRpcMode::Track);
    let show_button = track.show_button.unwrap_or(true);

    let large_image = track.artwork_url.as_deref().unwrap_or("lomify_logo");

    let assets = Assets::new().large_image(large_image);

    // Строки собираются до `Activity`, а не по месту: `Activity` хранит `&str`, поэтому
    // временная строка, созданная внутри `match`, не переживёт свою ветку.
    let source = track
        .source
        .as_deref()
        .map(str::trim)
        .filter(|source| !source.is_empty());
    let title = clamp_bytes(&track.title, DISCORD_FIELD_MAX);
    let artist_state = track_state(&track.artist, source, is_playing);
    let artist_details = clamp_bytes(&track.artist, DISCORD_FIELD_MAX);
    // В режиме «артист» название трека не показывают вовсе, так что вторая строка свободна —
    // источник занимает её целиком.
    let artist_mode_state = match (source, is_playing) {
        (Some(source), true) => source.to_string(),
        (Some(source), false) => format!("{source} (На паузе)"),
        (None, true) => String::new(),
        (None, false) => "На паузе".to_string(),
    };

    let mut activity = Activity::new()
        .activity_type(ActivityType::Listening)
        .assets(assets);

    activity = match mode {
        DiscordRpcMode::Track => activity.details(&title).state(&artist_state),
        DiscordRpcMode::Artist => {
            let activity = activity.details(&artist_details);
            if artist_mode_state.is_empty() {
                activity
            } else {
                activity.state(&artist_mode_state)
            }
        }
        DiscordRpcMode::Activity => {
            if is_playing {
                activity
            } else {
                activity.details("На паузе")
            }
        }
    };

    if is_playing {
        let mut timestamps = Timestamps::new().start(start);
        if let Some(dur) = track.duration_secs {
            if dur > 0 {
                timestamps = timestamps.end(start + dur);
            }
        }
        activity = activity.timestamps(timestamps);
    }

    if show_button {
        if let Some(ref url) = track.track_url {
            activity = activity.buttons(vec![Button::new("Listen on LomifyNEXT", url)]);
        }
    }

    let result = client.set_activity(activity);

    if result.is_err() {
        *guard = None;
    }

    result.map_err(|e| format!("set_activity: {e}"))?;

    Ok(())
}

#[tauri::command]
pub fn discord_clear_activity(state: tauri::State<'_, Arc<DiscordState>>) -> Result<(), String> {
    let mut guard = state.client.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut client) = *guard {
        client
            .clear_activity()
            .map_err(|e| format!("clear_activity: {e}"))?;
    }
    Ok(())
}
