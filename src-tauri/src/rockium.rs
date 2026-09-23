use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

#[derive(Deserialize, Serialize)]
pub struct Snapshot {
    version: u8,
    title: String,
    artist: String,
    playing: bool,
    position: f64,
    duration: f64,
    lyrics: String,
    #[serde(default)]
    artwork: String,
    #[serde(default)]
    artwork_status: String,
    offset: f64,
    #[serde(default)]
    updated_at: u64,
}

impl Snapshot {
    fn validate(&self) -> Result<(), String> {
        if self.version != 1 || self.title.len() > 2048 || self.artist.len() > 2048
            || self.lyrics.len() > 400_000 || self.artwork.len() > 200_000 || self.artwork_status.len() > 1024 || !self.position.is_finite()
            || !self.duration.is_finite() || !self.offset.is_finite()
            || self.position < 0.0 || self.duration < 0.0 || self.offset.abs() > 60.0 {
            return Err("Invalid Rockium playback snapshot".into());
        }
        Ok(())
    }
}

/// Local playback/lyrics only. This command accepts no file paths or credentials.
#[tauri::command]
pub async fn rockium_publish(mut snapshot: Snapshot) -> Result<(), String> {
    snapshot.validate()?;
    let base = std::env::var_os("LOCALAPPDATA").ok_or("Local playback bridge requires Windows")?;
    let dir = PathBuf::from(base).join("LomifyNEXT").join("integrations");
    snapshot.updated_at = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as u64;
    let data = serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?;
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let temp = dir.join(format!("rockium-{}.tmp", std::process::id()));
    tokio::fs::write(&temp, data).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&temp, dir.join("rockium.json")).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reject_invalid_clock_and_protocol() {
        let mut s = Snapshot { version: 1, title: "Track".into(), artist: "Artist".into(),
            playing: true, position: 20.0, duration: 180.0, lyrics: "[00:20.00]Line".into(), artwork: String::new(), artwork_status: String::new(), offset: -0.4, updated_at: 0 };
        assert!(s.validate().is_ok());
        s.position = f64::NAN; assert!(s.validate().is_err());
        s.position = 0.0; s.version = 2; assert!(s.validate().is_err());
    }
}
