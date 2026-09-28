use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Deserialize, Serialize)]
pub struct Snapshot {
    pub version: u8,
    pub title: String,
    pub artist: String,
    pub playing: bool,
    pub position: f64,
    pub duration: f64,
    pub lyrics: String,
    #[serde(default)]
    pub artwork: String,
    #[serde(default)]
    pub artwork_status: String,
    pub offset: f64,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default)]
    pub api_url: String,
    #[serde(default)]
    pub api_port: u16,
}

impl Snapshot {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 || self.title.len() > 2048 || self.artist.len() > 2048
            || self.lyrics.len() > 400_000 || self.artwork.len() > 200_000 || self.artwork_status.len() > 1024 || !self.position.is_finite()
            || !self.duration.is_finite() || !self.offset.is_finite()
            || self.position < 0.0 || self.duration < 0.0 || self.offset.abs() > 60.0 {
            return Err("Invalid Rockium playback snapshot".into());
        }
        Ok(())
    }
}

static CURRENT_SNAPSHOT: OnceLock<Arc<Mutex<Option<Snapshot>>>> = OnceLock::new();
static API_PORT: AtomicU16 = AtomicU16::new(0);
static LAST_DISK_WRITE_MS: AtomicU64 = AtomicU64::new(0);
static WRITE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
static WRITE_COUNTER: AtomicU64 = AtomicU64::new(0);
static SERVER_ENABLED: AtomicBool = AtomicBool::new(true);
static BRIDGE_ENABLED: AtomicBool = AtomicBool::new(true);

pub fn is_server_enabled() -> bool {
    SERVER_ENABLED.load(Ordering::Relaxed)
}

pub fn is_bridge_enabled() -> bool {
    BRIDGE_ENABLED.load(Ordering::Relaxed)
}

pub fn set_api_port(port: u16) {
    API_PORT.store(port, Ordering::Relaxed);
    if port > 0 && is_server_enabled() && is_bridge_enabled() {
        if let Ok(dir) = get_integrations_dir() {
            let api_info = serde_json::json!({
                "port": port,
                "url": format!("http://127.0.0.1:{}", port),
                "endpoints": {
                    "rockium": format!("http://127.0.0.1:{}/rockium", port),
                    "lyrics": format!("http://127.0.0.1:{}/lyrics", port),
                    "now_playing": format!("http://127.0.0.1:{}/now-playing", port),
                    "cover": format!("http://127.0.0.1:{}/cover", port)
                }
            });
            if let Ok(api_bytes) = serde_json::to_vec_pretty(&api_info) {
                let _ = std::fs::create_dir_all(&dir);
                let id = WRITE_COUNTER.fetch_add(1, Ordering::Relaxed);
                let api_temp = dir.join(format!("api-{}-{}.tmp", std::process::id(), id));
                if std::fs::write(&api_temp, &api_bytes).is_ok() {
                    let _ = std::fs::rename(&api_temp, dir.join("api.json"));
                }
            }
        }
    } else if !is_server_enabled() || !is_bridge_enabled() {
        if let Ok(dir) = get_integrations_dir() {
            let api_path = dir.join("api.json");
            if api_path.exists() {
                let _ = std::fs::remove_file(api_path);
            }
        }
    }
}

pub fn get_api_port() -> u16 {
    API_PORT.load(Ordering::Relaxed)
}

pub fn snapshot_store() -> &'static Arc<Mutex<Option<Snapshot>>> {
    CURRENT_SNAPSHOT.get_or_init(|| Arc::new(Mutex::new(None)))
}

pub fn get_current_snapshot() -> Option<Snapshot> {
    snapshot_store().lock().unwrap().clone()
}

fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn get_integrations_dir() -> Result<PathBuf, String> {
    let base = std::env::var_os("LOCALAPPDATA").ok_or("Local playback bridge requires Windows")?;
    Ok(PathBuf::from(base).join("LomifyNEXT").join("integrations"))
}

pub async fn write_snapshot_to_disk(snapshot: &Snapshot) -> Result<(), String> {
    if !is_bridge_enabled() {
        return Ok(());
    }
    let dir = match get_integrations_dir() {
        Ok(d) => d,
        Err(e) => return Err(e),
    };
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let data = serde_json::to_vec(snapshot).map_err(|e| e.to_string())?;
    let id = WRITE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = dir.join(format!("rockium-{}-{}.tmp", std::process::id(), id));
    tokio::fs::write(&temp, &data).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&temp, dir.join("rockium.json")).await.map_err(|e| e.to_string())?;

    let api_path = dir.join("api.json");
    if is_server_enabled() {
        let port = get_api_port();
        if port > 0 {
            let api_info = serde_json::json!({
                "port": port,
                "url": format!("http://127.0.0.1:{}", port),
                "endpoints": {
                    "rockium": format!("http://127.0.0.1:{}/rockium", port),
                    "lyrics": format!("http://127.0.0.1:{}/lyrics", port),
                    "now_playing": format!("http://127.0.0.1:{}/now-playing", port),
                    "cover": format!("http://127.0.0.1:{}/cover", port)
                }
            });
            if let Ok(api_bytes) = serde_json::to_vec_pretty(&api_info) {
                let api_temp = dir.join(format!("api-{}-{}.tmp", std::process::id(), id));
                if tokio::fs::write(&api_temp, &api_bytes).await.is_ok() {
                    let _ = tokio::fs::rename(&api_temp, &api_path).await;
                }
            }
        }
    } else if api_path.exists() {
        let _ = tokio::fs::remove_file(&api_path).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn rockium_configure(enabled: bool, server_enabled: bool) -> Result<(), String> {
    BRIDGE_ENABLED.store(enabled, Ordering::SeqCst);
    SERVER_ENABLED.store(server_enabled, Ordering::SeqCst);

    let dir = match get_integrations_dir() {
        Ok(d) => d,
        Err(e) => return Err(e),
    };

    let api_path = dir.join("api.json");
    if !enabled || !server_enabled {
        if api_path.exists() {
            let _ = tokio::fs::remove_file(&api_path).await;
        }
    } else {
        let port = get_api_port();
        if port > 0 {
            let api_info = serde_json::json!({
                "port": port,
                "url": format!("http://127.0.0.1:{}", port),
                "endpoints": {
                    "rockium": format!("http://127.0.0.1:{}/rockium", port),
                    "lyrics": format!("http://127.0.0.1:{}/lyrics", port),
                    "now_playing": format!("http://127.0.0.1:{}/now-playing", port),
                    "cover": format!("http://127.0.0.1:{}/cover", port)
                }
            });
            if let Ok(api_bytes) = serde_json::to_vec_pretty(&api_info) {
                let _ = tokio::fs::create_dir_all(&dir).await;
                let id = WRITE_COUNTER.fetch_add(1, Ordering::Relaxed);
                let api_temp = dir.join(format!("api-{}-{}.tmp", std::process::id(), id));
                if tokio::fs::write(&api_temp, &api_bytes).await.is_ok() {
                    let _ = tokio::fs::rename(&api_temp, &api_path).await;
                }
            }
        }
    }

    if !enabled {
        let rockium_path = dir.join("rockium.json");
        if rockium_path.exists() {
            let _ = tokio::fs::remove_file(&rockium_path).await;
        }
        *snapshot_store().lock().unwrap() = None;
    } else {
        let mut snapshot_to_save = None;
        {
            let mut store = snapshot_store().lock().unwrap();
            if let Some(ref mut s) = *store {
                let port = if server_enabled { get_api_port() } else { 0 };
                s.api_port = port;
                s.api_url = if port > 0 { format!("http://127.0.0.1:{}/rockium", port) } else { String::new() };
                s.updated_at = now_millis();
                snapshot_to_save = Some(s.clone());
            }
        }
        if let Some(s) = snapshot_to_save {
            write_snapshot_to_disk(&s).await?;
        }
    }

    Ok(())
}

/// Local playback/lyrics only. This command accepts no file paths or credentials.
#[tauri::command]
pub async fn rockium_publish(mut snapshot: Snapshot) -> Result<(), String> {
    if !is_bridge_enabled() {
        return Ok(());
    }
    snapshot.validate()?;
    let now = now_millis();
    snapshot.updated_at = now;
    if is_server_enabled() {
        let port = get_api_port();
        if port > 0 {
            snapshot.api_port = port;
            snapshot.api_url = format!("http://127.0.0.1:{}/rockium", port);
        }
    } else {
        snapshot.api_port = 0;
        snapshot.api_url = String::new();
    }
    *snapshot_store().lock().unwrap() = Some(snapshot.clone());
    LAST_DISK_WRITE_MS.store(now, Ordering::Relaxed);
    write_snapshot_to_disk(&snapshot).await
}

/// Periodic continuous update from the native audio tick thread.
/// Runs every 100ms in Rust; writes snapshot every ~300ms to guarantee fresh state
/// even when Lomify is minimized or backgrounded and webview timers are throttled.
pub fn on_audio_tick(pos: f64, playing: bool) {
    if !is_bridge_enabled() {
        return;
    }
    let now = now_millis();
    let mut snapshot_to_write = None;
    {
        let mut store = snapshot_store().lock().unwrap();
        if let Some(ref mut s) = *store {
            s.position = pos;
            s.playing = playing;
            let last_write = LAST_DISK_WRITE_MS.load(Ordering::Relaxed);
            if now.saturating_sub(last_write) >= 300 {
                s.updated_at = now;
                if is_server_enabled() {
                    let port = get_api_port();
                    if port > 0 && s.api_port == 0 {
                        s.api_port = port;
                        s.api_url = format!("http://127.0.0.1:{}/rockium", port);
                    }
                } else {
                    s.api_port = 0;
                    s.api_url.clear();
                }
                LAST_DISK_WRITE_MS.store(now, Ordering::Relaxed);
                snapshot_to_write = Some(s.clone());
            }
        }
    }

    if let Some(snapshot) = snapshot_to_write {
        if !WRITE_IN_PROGRESS.swap(true, Ordering::SeqCst) {
            tauri::async_runtime::spawn(async move {
                let _ = write_snapshot_to_disk(&snapshot).await;
                WRITE_IN_PROGRESS.store(false, Ordering::SeqCst);
            });
        }
    }
}

pub fn on_playback_idle() {
    if !is_bridge_enabled() {
        return;
    }
    let mut snapshot_to_write = None;
    {
        let mut store = snapshot_store().lock().unwrap();
        if let Some(ref mut s) = *store {
            if s.playing {
                let now = now_millis();
                s.playing = false;
                s.updated_at = now;
                LAST_DISK_WRITE_MS.store(now, Ordering::Relaxed);
                snapshot_to_write = Some(s.clone());
            }
        }
    }
    if let Some(snapshot) = snapshot_to_write {
        tauri::async_runtime::spawn(async move {
            let _ = write_snapshot_to_disk(&snapshot).await;
        });
    }
}

pub fn on_playback_ended() {
    on_playback_idle();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reject_invalid_clock_and_protocol() {
        let mut s = Snapshot { version: 1, title: "Track".into(), artist: "Artist".into(),
            playing: true, position: 20.0, duration: 180.0, lyrics: "[00:20.00]Line".into(), artwork: String::new(), artwork_status: String::new(), offset: -0.4, updated_at: 0, api_url: String::new(), api_port: 0 };
        assert!(s.validate().is_ok());
        s.position = f64::NAN; assert!(s.validate().is_err());
        s.position = 0.0; s.version = 2; assert!(s.validate().is_err());
    }

    #[test]
    fn toggle_server_and_bridge_flags() {
        SERVER_ENABLED.store(false, Ordering::SeqCst);
        BRIDGE_ENABLED.store(true, Ordering::SeqCst);
        assert!(!is_server_enabled());
        assert!(is_bridge_enabled());
        SERVER_ENABLED.store(true, Ordering::SeqCst);
        assert!(is_server_enabled());
    }
}
