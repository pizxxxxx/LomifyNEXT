//! Optional Windows-only Zapret runner for SoundCloud. The elevated helper
//! starts only the bundled winws binary and stops it when Lomify exits.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
static LAST_AUTO_START: AtomicU64 = AtomicU64::new(0);
const PLAYBACK_ISSUE_TTL_MS: u64 = 180_000;
static PLAYBACK_REPORT_GENERATION: AtomicU64 = AtomicU64::new(0);
static PLAYBACK_REPORT_LOCK: Mutex<()> = Mutex::new(());

fn playback_issue_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|dir| dir.join("soundcloud-bypass-playback.json"))
        .map_err(|_| "Не удалось найти папку диагностики SoundCloud".into())
}

pub fn clear_playback_issue(app: &AppHandle) -> Result<(), String> {
    let _guard = PLAYBACK_REPORT_LOCK.lock().map_err(|_| "Диагностика SoundCloud занята".to_string())?;
    PLAYBACK_REPORT_GENERATION.fetch_add(1, Ordering::SeqCst);
    remove_playback_file(&playback_issue_path(app)?)
}

fn remove_playback_file(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err("Не удалось удалить диагностику SoundCloud".into()),
        _ => Ok(()),
    }
}

fn read_recent_playback_issue(path: &Path, now: u64) -> Option<PlaybackIssue> {
    let _guard = PLAYBACK_REPORT_LOCK.lock().ok()?;
    let bytes = std::fs::read(path).ok()?;
    let issue = serde_json::from_slice::<PlaybackIssue>(&bytes).ok();
    if let Some(issue) = issue {
        if issue.reported_at <= now && now - issue.reported_at < PLAYBACK_ISSUE_TTL_MS { return Some(issue); }
    }
    let _ = remove_playback_file(path);
    None
}

pub fn start_playback_issue_cleanup(app: &AppHandle) {
    let _ = clear_playback_issue(app);
    if let Ok(path) = playback_issue_path(app) {
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let _ = read_recent_playback_issue(&path, now_millis());
            }
        });
    }
}

#[tauri::command]
pub fn soundcloud_clear_playback_issue(app: AppHandle) -> Result<(), String> { clear_playback_issue(&app) }

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
    /// Пошаговый отчёт подбора от PowerShell: что пробовали и чем это кончилось. Короткое
    /// `message` отвечает на вопрос «что сейчас», а отчёт — на «почему так вышло»; без него
    /// неудачный подбор выглядел как одна строка «стратегия не найдена» без причин.
    #[serde(default)]
    pub report: String,
    /// `auto` или `force` — режим последнего запуска. Нужен интерфейсу, чтобы не выдавать
    /// результат принудительного подбора за доказанный.
    #[serde(default)]
    pub mode: String,
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
            report: String::new(),
            mode: String::new(),
        }
    }
}

/// Встроенные стратегии описаны одним файлом и вшиты в приложение на сборке. Раньше тот же
/// список лежал ещё и в PowerShell, и любое расхождение между ними означало бы, что человек
/// выбирает в списке одно, а запускается другое. Скрипт получает этот список от приложения
/// отдельным аргументом: файла на диске нет, значит и подменять нечего.
const BUILTIN_STRATEGIES_JSON: &str = include_str!("builtin_strategies.json");

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BuiltinStrategy {
    pub name: String,
    pub scope: String,
    pub desc: String,
    pub args: Vec<String>,
}

fn builtin_strategies() -> Vec<BuiltinStrategy> {
    serde_json::from_str(BUILTIN_STRATEGIES_JSON).unwrap_or_default()
}

/// Пункт списка «выбрать стратегию вручную». Аргументы наружу не отдаются: человеку нужно
/// название и понятное описание, а не строка запуска winws.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyOption {
    pub name: String,
    pub description: String,
    pub origin: String,
}

/// Имя стратегии из интерфейса. Проверяется здесь, а не только в скрипте: имя уходит в
/// командную строку запуска с правами администратора, и всё, что не похоже на имя из
/// собственного списка, до неё доходить не должно.
fn valid_strategy_name(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= 80
        && value
            .chars()
            .all(|symbol| symbol.is_ascii_alphanumeric() || " +()_.-".contains(symbol))
}

#[tauri::command]
pub fn soundcloud_bypass_strategy_options(app: AppHandle) -> Result<Vec<StrategyOption>, String> {
    let (_, status_path, _) = paths(&app)?;
    let mut options: Vec<StrategyOption> = builtin_strategies()
        .into_iter()
        .map(|strategy| StrategyOption {
            name: strategy.name,
            description: strategy.desc,
            origin: "Встроенная".into(),
        })
        .collect();
    if let Ok(bytes) = std::fs::read(status_path.with_file_name("soundcloud-bypass-strategies.json"))
    {
        if let Ok(catalog) =
            serde_json::from_slice::<super::zapret_catalog::StrategyCatalog>(&bytes)
        {
            for strategy in catalog.strategies {
                if !valid_strategy_name(&strategy.name) {
                    continue;
                }
                let origin = strategy
                    .name
                    .split_whitespace()
                    .next()
                    .unwrap_or("Каталог")
                    .to_string();
                options.push(StrategyOption {
                    name: strategy.name,
                    description: "готовый набор из каталога стратегий".into(),
                    origin,
                });
            }
        }
    }
    Ok(options)
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
    let generation = PLAYBACK_REPORT_GENERATION.load(Ordering::SeqCst);
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
    {
        let _guard = PLAYBACK_REPORT_LOCK.lock().map_err(|_| "Диагностика SoundCloud занята".to_string())?;
        if PLAYBACK_REPORT_GENERATION.load(Ordering::SeqCst) != generation { return Ok(()); }
        std::fs::write(&issue_path, serde_json::to_vec(&issue).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    }
    #[cfg(windows)]
    if needs_bypass && status_path.with_file_name("soundcloud-bypass-enabled").exists() {
        let status = read_status(&status_path);
        let active = status.owner_pid == std::process::id()
            && matches!(
                status.state.as_str(),
                "elevating" | "testing" | "running" | "watching" | "waiting"
            );
        let now = now_millis();
        if !active && now.saturating_sub(LAST_AUTO_START.load(Ordering::Relaxed)) > 600_000 {
            LAST_AUTO_START.store(now, Ordering::Relaxed);
            let _ = soundcloud_bypass_start(app, Some(false), None).await;
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
        // «Ожидаю подтверждения Windows» пишет само приложение и больше не трогает, пока
        // человек не ответит системному окну. Само окно Windows снимает примерно через две
        // минуты, после чего запуск возвращает отказ и состояние перепишется настоящей
        // ошибкой; четыре минуты здесь - только страховка на случай, если и этого не
        // случилось, чтобы «жду подтверждения» не висело вечно.
        "elevating" => Some(std::time::Duration::from_secs(240)),
        "testing" => Some(std::time::Duration::from_secs(120)),
        "running" | "watching" | "waiting" => Some(std::time::Duration::from_secs(90)),
        // «Останавливаю» — единственное состояние, которое пишет не скрипт, а само
        // приложение, чтобы отмена отвечала сразу, а не через тридцать секунд. Скрипт
        // подтверждает её собственным `stopped` за секунду-две. Если подтверждения нет,
        // значит останавливать было уже нечего — и «останавливаю» навсегда висеть не должно.
        "stopping" => Some(std::time::Duration::from_secs(20)),
        _ => None,
    };
    if let Some(max_age) = max_age {
        let stale = std::fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > max_age);
        if stale {
            if status.state == "stopping" {
                status.state = "stopped".into();
                status.message = "Обход и автоматическая проверка выключены".into();
            } else if status.state == "elevating" {
                status.state = "failed".into();
                status.message = "Запуск с правами администратора так и не начался. Нажмите кнопку ещё раз, а если Windows покажет окно с вопросом - ответьте «Да»."
                    .into();
            } else {
                status.state = "failed".into();
                status.message = "Проверка обхода прервалась. Запустите её снова.".into();
            }
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

/// Команда, которая выполняется уже с правами администратора.
///
/// Раньше здесь была одна строка без обработки ошибок, и это оказалось главной причиной
/// жалобы «нажимаю - и ничего». Всё, что ломалось до `try` внутри самого сценария
/// (запрет на выполнение сценариев в политике Windows, несошедшийся хеш, непринятый
/// параметр), падало в скрытом окне и не оставляло следа: файл состояния так и оставался
/// в «готовлю запуск», пока его через четыре минуты не признавали просроченным. Теперь
/// любой такой отказ сам пишет состояние и строку в журнал запуска, поэтому вместо тишины
/// человек видит причину.
#[cfg(windows)]
const CHILD_TEMPLATE: &str = r#"$ErrorActionPreference = 'Stop'
$statusPath = @STATUS@
$logPath = @LOG@
function Write-Fail([string]$text) {
  try { [IO.File]::WriteAllText($logPath, ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $text), [Text.Encoding]::UTF8) } catch { }
  try {
    $payload = @{ state = 'failed'; message = $text; strategy = ''; index = 0; total = 0; ownerPid = @PID@; mode = @MODE@; report = $text } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($statusPath, $payload, [Text.Encoding]::UTF8)
  } catch { }
  exit 1
}
try {
  if (-not (Test-Path -LiteralPath @SCRIPT@)) { Write-Fail 'Файл сценария обхода не найден. Переустановите Lomify.' }
  if ((Get-FileHash -LiteralPath @SCRIPT@ -Algorithm SHA256).Hash -ne @HASH@) { Write-Fail 'Файл сценария обхода отличается от встроенного в приложение. Переустановите Lomify.' }
  & @SCRIPT@ -Root @ROOT@ -StatusPath $statusPath -StopPath @STOP@ -AppPid @PID@ -Mode @MODE@ -StrategiesPath @INPUT@ -Pick @PICK@
} catch {
  Write-Fail ('Сценарий обхода не запустился: ' + $_.Exception.Message)
}
"#;

/// Запрос прав администратора. Выполняется от обычного пользователя, поэтому единственное,
/// что здесь может случиться, - отказ в повышении прав. Он тоже обязан оставить сообщение:
/// `Start-Process -Verb RunAs` при отказе пишет обычную ошибку, а сам powershell.exe при
/// этом возвращает ноль, и приложение считало такой запуск удавшимся.
#[cfg(windows)]
const LAUNCHER_TEMPLATE: &str = r#"$ErrorActionPreference = 'Stop'
try {
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', @ENC@) | Out-Null
} catch {
  $inAdmins = $false
  try { $inAdmins = @([Security.Principal.WindowsIdentity]::GetCurrent().Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' }).Count -gt 0 } catch { }
  $text = if ($inAdmins) { 'Windows не выдала права администратора: ' + $_.Exception.Message } else { 'Для обхода нужны права администратора, а эта учётная запись не входит в администраторов компьютера. Войдите под учётной записью администратора или попросите владельца компьютера выдать права.' }
  try { [IO.File]::WriteAllText(@LOG@, ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $text), [Text.Encoding]::UTF8) } catch { }
  try {
    $payload = @{ state = 'failed'; message = $text; strategy = ''; index = 0; total = 0; ownerPid = @PID@; mode = @MODE@; report = $text } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText(@STATUS@, $payload, [Text.Encoding]::UTF8)
  } catch { }
  exit 1
}
"#;

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
    if let Some(issue) = read_recent_playback_issue(&status_path.with_file_name("soundcloud-bypass-playback.json"), now_millis()) {
        status.diagnosis_state = issue.kind;
        status.diagnosis_message = issue.message;
        status.diagnosis_at = issue.reported_at;
    }
    Ok(status)
}

/// Отмена подбора.
///
/// Раньше команда только создавала файл-флаг и молчала: скрипт читал его редко, статус
/// оставался прежним, и человек видел неизменное «проверяю стратегию» - то есть отмена с
/// виду не работала. Теперь состояние переписывается здесь же, до всякого ожидания, а флаг
/// скрипт читает пять раз в секунду и подтверждает остановку своим `stopped`.
#[tauri::command]
pub fn soundcloud_bypass_stop(app: AppHandle) -> Result<(), String> {
    let (_, status_path, stop_path) = paths(&app)?;
    let _ = std::fs::remove_file(stop_path.with_file_name("soundcloud-bypass-enabled"));
    std::fs::write(&stop_path, b"stop").map_err(|error| error.to_string())?;
    let previous = read_status(&status_path);
    let running = matches!(
        previous.state.as_str(),
        "elevating" | "testing" | "running" | "watching" | "waiting" | "stopping"
    );
    let _ = write_status(
        &status_path,
        &BypassStatus {
            state: if running { "stopping".into() } else { "stopped".into() },
            message: if running {
                "Останавливаю подбор".into()
            } else {
                "Обход и автоматическая проверка выключены".into()
            },
            owner_pid: std::process::id(),
            report: previous.report,
            mode: previous.mode,
            ..BypassStatus::idle()
        },
    );
    Ok(())
}

#[cfg(windows)]
#[tauri::command]
pub async fn soundcloud_bypass_start(
    app: AppHandle,
    force: Option<bool>,
    strategy: Option<String>,
) -> Result<(), String> {
    let force = force.unwrap_or(false);
    // Ручной выбор старше принудительного перебора: если человек назвал стратегию, перебирать
    // нечего - её и надо включить.
    let pick = strategy
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(ref name) = pick {
        if !valid_strategy_name(name) {
            return Err("Такой стратегии нет в списке".into());
        }
    }
    let mode = if pick.is_some() {
        "manual"
    } else if force {
        "force"
    } else {
        "auto"
    };
    let (root, status_path, stop_path) = paths(&app)?;
    let previous = read_status(&status_path);
    // Повторное нажатие не должно проваливаться в пустоту. Раньше любое «готовлю запуск»
    // считалось выполняющимся запуском, а просроченным оно признавалось только через четыре
    // минуты: если первая попытка умирала молча, следующие четыре минуты кнопка просто ничего
    // не делала. Запрос прав столько не живёт - тридцати секунд на него достаточно.
    let elevating_age = std::fs::metadata(&status_path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .unwrap_or_default();
    let busy = match previous.state.as_str() {
        "elevating" => elevating_age < Duration::from_secs(30),
        "testing" | "running" | "watching" | "waiting" => true,
        _ => false,
    };
    if previous.owner_pid == std::process::id() && busy {
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
    let log_path = status_path.with_file_name("soundcloud-bypass-launch.log");
    let input_path = status_path.with_file_name("soundcloud-bypass-input.json");
    let _ = std::fs::remove_file(&log_path);
    // Список стратегий уходит отдельным файлом, а не аргументом командной строки. Аргументом
    // он раздувал команду запуска до двадцати с лишним тысяч символов: строка проходила через
    // два слоя base64 и два вложенных powershell, и этот путь оказался самым хрупким звеном.
    // На безопасность это не влияет: каждый параметр стратегии всё равно проверяется в скрипте
    // по белому списку, и каталог стратегий уже лежит файлом в той же папке.
    std::fs::write(&input_path, BUILTIN_STRATEGIES_JSON.as_bytes())
        .map_err(|error| format!("Не удалось подготовить список стратегий: {error}"))?;
    // Отдельное состояние, а не «подбираю стратегию»: пока идёт запрос прав, ничего не
    // подбирается, и подписью про подбор это ожидание выглядело как зависшая проверка.
    // Формулировка условная: на части систем Windows выдаёт права молча, без всякого окна,
    // и обещать человеку окно, которого он никогда не увидит, нельзя.
    const WAITING_FOR_UAC: &str =
        "Запускаю обход с правами администратора. Если Windows спросит разрешение, нажмите «Да» - её окно может открыться позади Lomify.";
    write_status(
        &status_path,
        &BypassStatus {
            state: "elevating".into(),
            message: WAITING_FOR_UAC.into(),
            strategy: pick.clone().unwrap_or_default(),
            owner_pid: std::process::id(),
            mode: mode.into(),
            ..BypassStatus::idle()
        },
    )?;

    let script = root.join("soundcloud-bypass.ps1");
    let child_command = CHILD_TEMPLATE
        .replace("@SCRIPT@", &ps_literal(&script.to_string_lossy()))
        .replace("@HASH@", &ps_literal(&bundled_script_hash()))
        .replace("@STATUS@", &ps_literal(&status_path.to_string_lossy()))
        .replace("@LOG@", &ps_literal(&log_path.to_string_lossy()))
        .replace("@ROOT@", &ps_literal(&root.to_string_lossy()))
        .replace("@STOP@", &ps_literal(&stop_path.to_string_lossy()))
        .replace("@INPUT@", &ps_literal(&input_path.to_string_lossy()))
        .replace("@MODE@", &ps_literal(mode))
        .replace("@PICK@", &ps_literal(pick.as_deref().unwrap_or("")))
        .replace("@PID@", &std::process::id().to_string());
    let launcher_command = LAUNCHER_TEMPLATE
        .replace("@ENC@", &ps_literal(&encode_powershell(&child_command)))
        .replace("@STATUS@", &ps_literal(&status_path.to_string_lossy()))
        .replace("@LOG@", &ps_literal(&log_path.to_string_lossy()))
        .replace("@MODE@", &ps_literal(mode))
        .replace("@PID@", &std::process::id().to_string());
    let encoded_launcher = encode_powershell(&launcher_command);

    // Запрос прав администратора показывает системное окно и держит вызов до тех пор, пока
    // человек на него не ответит. Пока команда этого ждала, интерфейс считал подбор
    // выполняющимся и не давал нажать «Отменить»: отменять было нечего и нечем. Ожидание
    // ушло в отдельную задачу - команда возвращается сразу, а всё, что нужно знать
    // интерфейсу, приходит из файла состояния, который он и так опрашивает.
    tauri::async_runtime::spawn(async move {
        let launched = tokio::task::spawn_blocking(move || {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-EncodedCommand",
                    &encoded_launcher,
                ])
                .creation_flags(0x0800_0000)
                .output()
        })
        .await;
        let started = matches!(&launched, Ok(Ok(output)) if output.status.success());
        if started {
            let _ = std::fs::write(
                status_path.with_file_name("soundcloud-bypass-enabled"),
                b"enabled",
            );
        }
        // Запуск удался только тогда, когда сценарий действительно взял работу на себя и
        // переписал состояние своим. Раньше приложение верило нулевому коду возврата
        // powershell.exe и на этом успокаивалось: отказ в правах и упавший сценарий
        // выглядели как успешный старт, а «готовлю запуск» висело минутами без объяснений.
        let deadline = std::time::Instant::now() + Duration::from_secs(25);
        loop {
            tokio::time::sleep(Duration::from_millis(400)).await;
            let current = read_status(&status_path);
            if current.owner_pid != std::process::id() || current.state != "elevating" {
                return;
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
        }
        let current = read_status(&status_path);
        if current.owner_pid != std::process::id() || current.state != "elevating" {
            return;
        }
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        let log = log.trim();
        let message = if !started {
            "Windows не дала прав администратора, без них обход не запустить. Нажмите «Подобрать и включить» ещё раз, а если появится окно Windows с вопросом - выберите «Да»."
                .to_string()
        } else if log.is_empty() {
            "Обход не запустился: окно с правами администратора не ответило. Проверьте, что ваша учётная запись входит в администраторов компьютера, и что обход не блокирует антивирус. Потом нажмите «Подобрать и включить» ещё раз."
                .to_string()
        } else {
            format!("Обход не запустился. {log}")
        };
        let _ = write_status(
            &status_path,
            &BypassStatus {
                state: "failed".into(),
                message,
                owner_pid: std::process::id(),
                mode: current.mode,
                report: if log.is_empty() { String::new() } else { log.to_string() },
                ..BypassStatus::idle()
            },
        );
    });
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn soundcloud_bypass_start(
    _app: AppHandle,
    _force: Option<bool>,
    _strategy: Option<String>,
) -> Result<(), String> {
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
