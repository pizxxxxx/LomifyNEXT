//! Optional Windows-only Zapret runner for SoundCloud. The elevated helper
//! starts only the bundled winws binary and stops it when Lomify exits.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
static LAST_AUTO_START: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BypassStatus {
    pub state: String,
    pub message: String,
    pub strategy: String,
    pub index: u32,
    pub total: u32,
    #[serde(default, rename = "ownerPid")]
    pub owner_pid: u32,
    #[serde(default, rename = "catalogCount")]
    pub catalog_count: u32,
    #[serde(default, rename = "catalogUpdatedAt")]
    pub catalog_updated_at: u64,
    #[serde(default, rename = "diagnosisState")]
    pub diagnosis_state: String,
    #[serde(default, rename = "diagnosisMessage")]
    pub diagnosis_message: String,
    #[serde(default, rename = "diagnosisAt")]
    pub diagnosis_at: u64,
    #[serde(default, rename = "autoEnabled")]
    pub auto_enabled: bool,
}

impl BypassStatus {
    fn idle() -> Self {
        Self {
            state: "idle".into(),
            message: String::new(),
            strategy: String::new(),
            index: 0,
            total: 0,
            owner_pid: 0,
            catalog_count: 0,
            catalog_updated_at: 0,
            diagnosis_state: String::new(),
            diagnosis_message: String::new(),
            diagnosis_at: 0,
            auto_enabled: false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackIssue {
    reported_at: u64,
    kind: String,
    message: String,
    needs_bypass: bool,
    probe_url: Option<String>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn soundcloud_url(value: &str) -> Option<reqwest::Url> {
    if value.len() > 4096 { return None; }
    let url = reqwest::Url::parse(value).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let allowed = host == "soundcloud.com"
        || host.ends_with(".soundcloud.com")
        || host.ends_with(".sndcdn.com");
    (url.scheme() == "https"
        && allowed
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none())
        .then_some(url)
}

async fn probe_audio_url(url: &reqwest::Url) -> Result<u16, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(9))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() < 3 && soundcloud_url(attempt.url().as_str()).is_some() {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|error| error.to_string())?;
    let mut response = client
        .get(url.clone())
        .header(reqwest::header::RANGE, "bytes=0-4095")
        .send()
        .await
        .map_err(|error| if error.is_timeout() { "Превышено время ожидания".to_string() } else { "Нет соединения с аудиосервером".to_string() })?;
    let status = response.status().as_u16();
    if response.status().is_success() && response.chunk().await.map_err(|_| "Аудиосервер прервал передачу".to_string())?.is_none_or(|bytes| bytes.is_empty()) {
        return Err("Аудиосервер не передал данные".into());
    }
    Ok(status)
}

#[tauri::command]
pub async fn soundcloud_bypass_report_playback_failure(
    app: AppHandle,
    phase: String,
    url: Option<String>,
    detail: String,
) -> Result<(), String> {
    if phase != "resolve" && phase != "stream" { return Err("Некорректный этап проверки".into()); }
    let (_, status_path, _) = paths(&app)?;
    let issue_path = status_path.with_file_name("soundcloud-bypass-playback.json");
    let detail = detail.trim().chars().take(180).collect::<String>().to_lowercase();
    let parsed_url = url.as_deref().and_then(soundcloud_url);
    if phase == "stream" && parsed_url.is_none() {
        return Err("Некорректный адрес аудиопотока SoundCloud".into());
    }
    let (kind, message, needs_bypass) = if detail.contains("drm") || detail.contains("защищён") || detail.contains("нет ни одного потока") {
        ("source", "Этот трек не отдаёт воспроизводимый поток. Смена сетевой стратегии не поможет.".to_string(), false)
    } else if let Some(ref audio_url) = parsed_url {
        let host = audio_url.host_str().unwrap_or("SoundCloud");
        match probe_audio_url(audio_url).await {
            Ok(200..=299) => ("audio", "Аудиоданные доступны по сети. Причина сбоя, вероятно, в формате или декодировании трека.".to_string(), false),
            Ok(status @ (401 | 403 | 404 | 410)) => ("source", format!("SoundCloud отклонил ссылку на трек (HTTP {status}). Проверьте доступность записи или обновите ссылку."), false),
            Ok(429) => ("source", "SoundCloud ограничил число запросов (HTTP 429). Подождите перед повтором.".to_string(), false),
            Ok(status) => ("source", format!("Аудиосервер ответил HTTP {status}. Сетевой обход пока не меняю."), false),
            Err(reason) => ("network", format!("Не удалось получить аудиоданные с {host}: {reason}. Подбираю сетевой обход."), true),
        }
    } else {
        let check = soundcloud_bypass_test_connection().await?;
        if check.reachable {
            ("source", "Сайт и API SoundCloud доступны, но ссылка на этот трек не получена. Проверьте доступность записи.".to_string(), false)
        } else {
            ("network", "Часть серверов SoundCloud не отвечает. Подбираю сетевой обход.".to_string(), true)
        }
    };
    let issue = PlaybackIssue {
        reported_at: now_millis(),
        kind: kind.into(),
        message,
        needs_bypass,
        probe_url: if needs_bypass { parsed_url.map(|url| url.to_string()) } else { None },
    };
    std::fs::write(&issue_path, serde_json::to_vec(&issue).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    #[cfg(windows)]
    if needs_bypass && status_path.with_file_name("soundcloud-bypass-enabled").exists() {
        let status = read_status(&status_path);
        let active = status.owner_pid == std::process::id()
            && matches!(status.state.as_str(), "testing" | "running" | "watching" | "waiting");
        let now = now_millis();
        if !active && now.saturating_sub(LAST_AUTO_START.load(Ordering::Relaxed)) > 600_000 {
            LAST_AUTO_START.store(now, Ordering::Relaxed);
            let _ = soundcloud_bypass_start(app).await;
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionCheck {
    pub service: &'static str,
    pub reachable: bool,
    pub status: Option<u16>,
    pub detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub reachable: bool,
    pub checks: Vec<ConnectionCheck>,
}

async fn check_connection(
    client: &reqwest::Client,
    service: &'static str,
    url: &'static str,
) -> ConnectionCheck {
    match client.get(url).send().await {
        Ok(response) => ConnectionCheck {
            service,
            reachable: true,
            status: Some(response.status().as_u16()),
            detail: format!("HTTP {}", response.status().as_u16()),
        },
        Err(error) => ConnectionCheck {
            service,
            reachable: false,
            status: None,
            detail: if error.is_timeout() {
                "Превышено время ожидания".into()
            } else if error.is_connect() {
                "Нет соединения".into()
            } else {
                "Ошибка запроса".into()
            },
        },
    }
}

#[tauri::command]
pub async fn soundcloud_bypass_test_connection() -> Result<ConnectionTestResult, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(7))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    let (site, api, audio) = tokio::join!(
        check_connection(&client, "Сайт", "https://soundcloud.com/"),
        check_connection(&client, "API", "https://api-v2.soundcloud.com/"),
        check_connection(&client, "Аудио", "https://cf-media.sndcdn.com/"),
    );
    let checks = vec![site, api, audio];
    let reachable = checks.iter().all(|check| check.reachable);
    Ok(ConnectionTestResult { reachable, checks })
}

fn paths(app: &AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let root = app
        .path()
        .resolve("resources/zapret", tauri::path::BaseDirectory::Resource)
        .map_err(|error| error.to_string())?;
    let data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&data).map_err(|error| error.to_string())?;
    Ok((
        root,
        data.join("soundcloud-bypass-status.json"),
        data.join("soundcloud-bypass-stop"),
    ))
}

fn read_status(path: &Path) -> BypassStatus {
    let mut status: BypassStatus = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(BypassStatus::idle);
    let max_age = match status.state.as_str() {
        "testing" => Some(std::time::Duration::from_secs(120)),
        "running" | "watching" | "waiting" => Some(std::time::Duration::from_secs(90)),
        _ => None,
    };
    if let Some(max_age) = max_age {
        let stale = std::fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > max_age);
        if stale {
            status.state = "failed".into();
            status.message = "Проверка обхода прервалась. Запустите её снова.".into();
            status.strategy.clear();
        }
    }
    status
}

fn write_status(path: &Path, status: &BypassStatus) -> Result<(), String> {
    let bytes = serde_json::to_vec(status).map_err(|error| error.to_string())?;
    std::fs::write(path, bytes).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn ps_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(windows)]
fn encode_powershell(command: &str) -> String {
    use base64::Engine;
    let bytes = command
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(windows)]
fn bundled_script_hash() -> String {
    use sha2::Digest;
    let bytes = include_bytes!("../../resources/zapret/soundcloud-bypass.ps1");
    hex::encode(sha2::Sha256::digest(bytes)).to_uppercase()
}

#[tauri::command]
pub fn soundcloud_bypass_status(app: AppHandle) -> Result<BypassStatus, String> {
    let (_, status_path, _) = paths(&app)?;
    let mut status = read_status(&status_path);
    let catalog_path = status_path.with_file_name("soundcloud-bypass-strategies.json");
    if let Ok(bytes) = std::fs::read(catalog_path) {
        if let Ok(catalog) =
            serde_json::from_slice::<super::zapret_catalog::StrategyCatalog>(&bytes)
        {
            status.catalog_count = catalog.strategies.len() as u32;
            status.catalog_updated_at = catalog.updated_at;
        }
    }
    status.auto_enabled = status_path.with_file_name("soundcloud-bypass-enabled").is_file();
    if let Ok(bytes) = std::fs::read(status_path.with_file_name("soundcloud-bypass-playback.json")) {
        if let Ok(issue) = serde_json::from_slice::<PlaybackIssue>(&bytes) {
            if now_millis().saturating_sub(issue.reported_at) < 3_600_000 {
                status.diagnosis_state = issue.kind;
                status.diagnosis_message = issue.message;
                status.diagnosis_at = issue.reported_at;
            }
        }
    }
    Ok(status)
}

#[tauri::command]
pub fn soundcloud_bypass_stop(app: AppHandle) -> Result<(), String> {
    let (_, _, stop_path) = paths(&app)?;
    let _ = std::fs::remove_file(stop_path.with_file_name("soundcloud-bypass-enabled"));
    std::fs::write(stop_path, b"stop").map_err(|error| error.to_string())
}

#[cfg(windows)]
#[tauri::command]
pub async fn soundcloud_bypass_start(app: AppHandle) -> Result<(), String> {
    let (root, status_path, stop_path) = paths(&app)?;
    let previous = read_status(&status_path);
    if previous.owner_pid == std::process::id()
        && matches!(
            previous.state.as_str(),
            "testing" | "running" | "watching" | "waiting"
        )
    {
        return Ok(());
    }
    for name in [
        "winws.exe",
        "WinDivert.dll",
        "WinDivert64.sys",
        "cygwin1.dll",
        "soundcloud-bypass.ps1",
    ] {
        if !root.join(name).is_file() {
            return Err(format!("Не найден компонент обхода: {name}"));
        }
    }
    let _ = std::fs::remove_file(&stop_path);
    write_status(
        &status_path,
        &BypassStatus {
            state: "testing".into(),
            message: "Ожидаю подтверждения Windows".into(),
            strategy: String::new(),
            index: 0,
            total: 0,
            owner_pid: std::process::id(),
            catalog_count: 0,
            catalog_updated_at: 0,
            diagnosis_state: String::new(),
            diagnosis_message: String::new(),
            diagnosis_at: 0,
            auto_enabled: false,
        },
    )?;

    let script = root.join("soundcloud-bypass.ps1");
    let child_command = format!(
        "if ((Get-FileHash -LiteralPath {} -Algorithm SHA256).Hash -ne '{}') {{ [IO.File]::WriteAllText({}, '{{\"state\":\"failed\",\"message\":\"Не прошла проверка скрипта обхода\",\"strategy\":\"\",\"index\":0,\"total\":0}}'); exit 1 }}; & {} -Root {} -StatusPath {} -StopPath {} -AppPid {}",
        ps_literal(&script.to_string_lossy()),
        bundled_script_hash(),
        ps_literal(&status_path.to_string_lossy()),
        ps_literal(&script.to_string_lossy()),
        ps_literal(&root.to_string_lossy()),
        ps_literal(&status_path.to_string_lossy()),
        ps_literal(&stop_path.to_string_lossy()),
        std::process::id(),
    );
    let encoded_child = encode_powershell(&child_command);
    let launcher_command = format!(
        "Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile -EncodedCommand {}'",
        encoded_child
    );
    let encoded_launcher = encode_powershell(&launcher_command);
    let result = tokio::task::spawn_blocking(move || {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-EncodedCommand", &encoded_launcher])
            .creation_flags(0x0800_0000)
            .output()
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    if !result.status.success() {
        let message = "Windows не запустила проверку с правами администратора.";
        let _ = write_status(
            &status_path,
            &BypassStatus {
                state: "failed".into(),
                message: message.into(),
                strategy: String::new(),
                index: 0,
                total: 0,
                owner_pid: std::process::id(),
                catalog_count: 0,
                catalog_updated_at: 0,
                diagnosis_state: String::new(),
                diagnosis_message: String::new(),
                diagnosis_at: 0,
                auto_enabled: false,
            },
        );
        return Err(message.into());
    }
    std::fs::write(status_path.with_file_name("soundcloud-bypass-enabled"), b"enabled")
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn soundcloud_bypass_start(_app: AppHandle) -> Result<(), String> {
    Err("Встроенный Zapret доступен только в Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::soundcloud_url;

    #[test]
    fn probe_urls_stay_on_soundcloud_https_hosts() {
        assert!(soundcloud_url("https://cf-media.sndcdn.com/media/example.mp3").is_some());
        assert!(soundcloud_url("https://api-v2.soundcloud.com/tracks/1").is_some());
        for value in [
            "http://cf-media.sndcdn.com/media/example.mp3",
            "https://sndcdn.com.evil.example/media/example.mp3",
            "https://evil.example/?next=cf-media.sndcdn.com",
            "https://user:pass@cf-media.sndcdn.com/media/example.mp3",
            "https://cf-media.sndcdn.com:444/media/example.mp3",
        ] {
            assert!(soundcloud_url(value).is_none(), "accepted {value}");
        }
    }
}
