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
}

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscordRpcMode {
    Track,
    Artist,
    Activity,
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

    let artist_state = if is_playing {
        track.artist.clone()
    } else {
        format!("{} (На паузе)", track.artist)
    };

    let mut activity = Activity::new()
        .activity_type(ActivityType::Listening)
        .assets(assets);

    activity = match mode {
        DiscordRpcMode::Track => activity.details(&track.title).state(&artist_state),
        DiscordRpcMode::Artist => {
            let activity = activity.details(&track.artist);
            if is_playing {
                activity
            } else {
                activity.state("На паузе")
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
