use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

static CANCEL_FLAG: std::sync::LazyLock<Arc<AtomicBool>> =
    std::sync::LazyLock::new(|| Arc::new(AtomicBool::new(false)));

#[derive(serde::Serialize, Clone)]
pub struct YmImportProgress {
    pub total: usize,
    pub current: usize,
    pub found: usize,
    pub not_found: usize,
    pub current_track: String,
}

#[derive(serde::Serialize, Clone)]
pub struct YmImportMatch {
    pub urn: String,
}

#[derive(serde::Deserialize)]
struct YmLikesResponse {
    result: YmLikesResult,
}

#[derive(serde::Deserialize)]
struct YmLikesResult {
    library: YmLibrary,
}

#[derive(serde::Deserialize)]
struct YmLibrary {
    tracks: Vec<YmLikedTrack>,
}

#[derive(serde::Deserialize)]
struct YmLikedTrack {
    id: serde_json::Value,
}

#[derive(serde::Deserialize)]
struct YmTrackInfo {
    result: Vec<YmTrack>,
}

#[derive(serde::Deserialize)]
struct YmTrack {
    title: Option<String>,
    artists: Option<Vec<YmArtist>>,
}

#[derive(serde::Deserialize)]
struct YmArtist {
    name: Option<String>,
}

#[derive(serde::Deserialize)]
struct ScSearchResult {
    collection: Vec<ScTrackResult>,
}

#[derive(serde::Deserialize)]
struct ScTrackResult {
    urn: Option<String>,
}

fn emit_progress(
    app: &AppHandle,
    total: usize,
    current: usize,
    found: usize,
    not_found: usize,
    current_track: String,
) {
    app.emit(
        "ym_import:progress",
        YmImportProgress {
            total,
            current,
            found,
            not_found,
            current_track,
        },
    )
    .ok();
}

/// Идентификатор клиента. То же значение, что в `src/lib/yandex.ts` (`CLIENT_ID`) — импорт и
/// обычные запросы приложения обязаны ходить одинаково, иначе один путь работает, а другой
/// отвечает 403 на том же самом токене.
const YM_CLIENT_ID: &str = "YandexMusicAndroid/24023621";

/// `User-Agent` официального Android-клиента — он совпадает со строкой клиента.
const YM_ANDROID_UA: &str = YM_CLIENT_ID;

/// Описание устройства официального клиента. Значения фиксированные, см. `DEVICE_INFO` в
/// `src/lib/yandex.ts` — там они те же.
const YM_DEVICE_INFO: &str = "os=Android; os_version=13; manufacturer=Xiaomi; \
     model=Redmi Note 8 Pro; clid=; device_id=lomifynext0000001; uuid=lomifynext0000002";

/// `User-Agent` обычного десктопного браузера.
const YM_BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// `User-Agent` питоновской обвязки. Один из вариантов, см. `ym_send`.
const YM_LIBRARY_UA: &str = "Yandex-Music-API";

/// GET к `api.music.yandex.net` с заголовками клиента и тем же перебором наборов, что во
/// фронтенде (`ymFetch` в `src/lib/yandex.ts`) — значения, порядок и условие повтора там те же.
///
/// Одного `Authorization: OAuth <token>` этому API не хватает: на запрос без опознавательных
/// знаков клиента он отвечает 403 — с любым токеном, включая только что выданный. Здесь это
/// выглядело как «YM auth failed: HTTP 403» на верном токене.
///
/// Наборов три, и они закрывают разные отказы: `android` — непротиворечивый набор
/// официального клиента (UA совпадает со строкой клиента, рядом описание устройства);
/// `browser` — тот же токен с UA обычного Chrome, на случай когда отказ приходит от периметра
/// перед API (403 без JSON-конверта `{"error":{...}}`); `library` — массовая строка
/// питоновской обвязки, последней именно поэтому. Раньше первый набор не ставил `User-Agent`
/// вовсе (`reqwest` своего значения не подставляет), а запрос без него периметр не пропускает.
///
/// Отдельная функция, а не `default_headers` у клиента: тот же `reqwest::Client` ниже ходит
/// на бэкенд за поиском в SoundCloud, и заголовки клиента Яндекса туда отправлять незачем.
async fn ym_send(
    client: &reqwest::Client,
    url: &str,
    token: &str,
) -> reqwest::Result<reqwest::Response> {
    let build = |profile: &str| {
        let req = client
            .get(url)
            .header("Authorization", format!("OAuth {}", token))
            .header("X-Yandex-Music-Client", YM_CLIENT_ID)
            .header("Accept", "*/*")
            .header("Accept-Language", "ru");
        match profile {
            "android" => req
                .header("User-Agent", YM_ANDROID_UA)
                .header("X-Yandex-Music-Device", YM_DEVICE_INFO),
            "browser" => req.header("User-Agent", YM_BROWSER_UA),
            _ => req.header("User-Agent", YM_LIBRARY_UA),
        }
    };

    let mut last: Option<reqwest::Response> = None;
    for profile in ["android", "browser", "library"] {
        let res = build(profile).send().await?;
        // Следующий набор пробуем только на 403: 401 — про токен, 429/5xx — про лимиты и
        // метод, и другой `User-Agent` их не меняет, зато лишний запрос уходит в тот же лимит.
        if res.status() != reqwest::StatusCode::FORBIDDEN {
            return Ok(res);
        }
        last = Some(res);
    }
    // Цикл всегда делает хотя бы один заход, поэтому здесь `last` заполнен.
    Ok(last.expect("ym_send: перебор наборов не сделал ни одного запроса"))
}

#[tauri::command]
pub async fn ym_import_start(
    ym_token: String,
    backend_url: String,
    session_id: String,
    app: AppHandle,
) -> Result<(), String> {
    CANCEL_FLAG.store(false, Ordering::Relaxed);

    let client = reqwest::Client::new();

    let uid_resp = ym_send(
        &client,
        "https://api.music.yandex.net/account/status",
        &ym_token,
    )
    .await
    .map_err(|e| format!("YM auth failed: {}", e))?;

    if !uid_resp.status().is_success() {
        return Err(format!("YM auth failed: HTTP {}", uid_resp.status()));
    }

    let uid_json: serde_json::Value = uid_resp.json().await.map_err(|e| e.to_string())?;
    let uid = uid_json["result"]["account"]["uid"]
        .as_i64()
        .ok_or("Failed to get YM user ID")?;

    let likes_resp = ym_send(
        &client,
        &format!(
            "https://api.music.yandex.net/users/{}/likes/tracks",
            uid
        ),
        &ym_token,
    )
    .await
    .map_err(|e| format!("Failed to fetch YM likes: {}", e))?;

    let likes: YmLikesResponse = likes_resp.json().await.map_err(|e| e.to_string())?;
    let track_ids: Vec<String> = likes
        .result
        .library
        .tracks
        .iter()
        .map(|t| match &t.id {
            serde_json::Value::Number(n) => n.to_string(),
            serde_json::Value::String(s) => s.clone(),
            v => v.to_string(),
        })
        .collect();

    let total = track_ids.len();
    let mut found = 0usize;
    let mut not_found = 0usize;
    let mut processed = 0usize;

    'batches: for chunk in track_ids.chunks(50) {
        if CANCEL_FLAG.load(Ordering::Relaxed) {
            break;
        }

        let ids_param = chunk.join(",");
        let info_resp = ym_send(
            &client,
            &format!(
                "https://api.music.yandex.net/tracks?trackIds={}",
                ids_param
            ),
            &ym_token,
        )
        .await;

        let tracks: Vec<YmTrack> = match info_resp {
            Ok(r) => match r.json::<YmTrackInfo>().await {
                Ok(info) => info.result,
                Err(_) => {
                    let remaining = total.saturating_sub(processed);
                    let missed = chunk.len().min(remaining);
                    for _ in 0..missed {
                        processed += 1;
                        not_found += 1;
                        emit_progress(&app, total, processed, found, not_found, String::new());
                    }
                    continue;
                }
            },
            Err(_) => {
                let remaining = total.saturating_sub(processed);
                let missed = chunk.len().min(remaining);
                for _ in 0..missed {
                    processed += 1;
                    not_found += 1;
                    emit_progress(&app, total, processed, found, not_found, String::new());
                }
                continue;
            }
        };

        for track in tracks.iter() {
            if CANCEL_FLAG.load(Ordering::Relaxed) {
                break 'batches;
            }

            processed += 1;
            let title = track.title.as_deref().unwrap_or("");
            let artist = track
                .artists
                .as_ref()
                .and_then(|a: &Vec<YmArtist>| a.first())
                .and_then(|a| a.name.as_deref())
                .unwrap_or("");

            if title.is_empty() && artist.is_empty() {
                not_found += 1;
                emit_progress(&app, total, processed, found, not_found, String::new());
                continue;
            }

            let current_track = format!("{} - {}", artist, title);

            let query = format!("{} {}", artist, title);
            let search_url = format!(
                "{}/tracks?q={}&limit=3&linked_partitioning=true",
                backend_url,
                urlencoding::encode(&query)
            );

            let search_resp = client
                .get(&search_url)
                .header("x-session-id", &session_id)
                .send()
                .await;

            if let Ok(resp) = search_resp {
                if let Ok(results) = resp.json::<ScSearchResult>().await {
                    if let Some(urn) = results.collection.first().and_then(|t| t.urn.as_deref()) {
                        found += 1;
                        app.emit(
                            "ym_import:match",
                            YmImportMatch {
                                urn: urn.to_string(),
                            },
                        )
                        .ok();
                    } else {
                        not_found += 1;
                    }
                } else {
                    not_found += 1;
                }
            } else {
                not_found += 1;
            }

            emit_progress(
                &app,
                total,
                processed,
                found,
                not_found,
                current_track.clone(),
            );

            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }

        if tracks.len() < chunk.len() {
            let missed = chunk.len() - tracks.len();
            let remaining = total.saturating_sub(processed);
            for _ in 0..missed.min(remaining) {
                processed += 1;
                not_found += 1;
                emit_progress(&app, total, processed, found, not_found, String::new());
            }
        }
    }

    emit_progress(&app, total, processed, found, not_found, String::new());

    Ok(())
}

#[tauri::command]
pub fn ym_import_stop() {
    CANCEL_FLAG.store(true, Ordering::Relaxed);
}
