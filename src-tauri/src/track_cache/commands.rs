use tauri::State;

use crate::track_cache::state::{
    CacheCleanupReport, CacheInventoryEntry, CacheRequest, LikeCacheEntry, SmartCleanupRequest,
    TrackCacheEntry, TrackCacheState, TranscodeStatus,
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureCachedRequest {
    pub urn: String,
    #[serde(default)]
    pub cover_url: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub urls: Option<Vec<String>>,
    #[serde(default)]
    pub download_urls: Option<Vec<String>>,
    #[serde(default)]
    pub storage_urls: Option<Vec<String>>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub hq: bool,
    /// API-reported track length (ms) for truncated-download detection.
    #[serde(default)]
    pub duration_ms: Option<u64>,
}

impl EnsureCachedRequest {
    /// Resolve the ordered `/stream` fallback URLs (`urls` preferred, else `url`).
    fn fallback_urls(&self) -> Option<Vec<String>> {
        match (&self.urls, &self.url) {
            (Some(u), _) if !u.is_empty() => Some(u.clone()),
            (_, Some(u)) => Some(vec![u.clone()]),
            _ => None,
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreloadEntry {
    pub urn: String,
    #[serde(default)]
    pub cover_url: Option<String>,
    pub url: Option<String>,
    pub urls: Option<Vec<String>>,
    #[serde(default)]
    pub download_urls: Option<Vec<String>>,
    pub storage_urls: Option<Vec<String>>,
    pub session_id: Option<String>,
    #[serde(default)]
    pub hq: bool,
    #[serde(default)]
    pub duration_ms: Option<u64>,
}

#[tauri::command]
pub async fn track_ensure_cached(
    request: EnsureCachedRequest,
    state: State<'_, TrackCacheState>,
) -> Result<TrackCacheEntry, String> {
    let cover_url = request.cover_url.clone();
    let urn = request.urn.clone();
    let fallback_urls = request
        .fallback_urls()
        .ok_or_else(|| "no stream URL provided".to_string())?;
    let storage_urls = request.storage_urls.unwrap_or_default();
    let download_urls = request.download_urls.unwrap_or_default();
    let entry = state
        .ensure_cached(CacheRequest {
            urn: &request.urn,
            urls: &fallback_urls,
            download_urls: &download_urls,
            storage_urls: &storage_urls,
            session_id: request.session_id.as_deref(),
            hq: request.hq,
            liked: false,
            expected_duration_ms: request.duration_ms,
        })
        .await?;
    if let Some(url) = cover_url.filter(|url| !url.trim().is_empty()) {
        // Artwork must never hold up playback of an audio file that is already
        // available. The local cover endpoint can serve it as soon as this task lands.
        tokio::spawn(async move {
            if let Err(err) =
                crate::network::image_cache::cache_downloaded_cover(&urn, &url).await
            {
                eprintln!("[TrackCache] cover cache failed for {urn}: {err}");
            }
        });
    }
    Ok(entry)
}

/// Download-to-file. Pulls from the clean m4a cache, transcoding raw bytes or
/// fetching from streaming as needed, and embeds `cover_url` when possible.
#[tauri::command]
pub async fn track_export(
    request: EnsureCachedRequest,
    dest_path: String,
    cover_url: Option<String>,
    state: State<'_, TrackCacheState>,
) -> Result<String, String> {
    let fallback_urls = request
        .fallback_urls()
        .ok_or_else(|| "no stream URL provided".to_string())?;
    let storage_urls = request.storage_urls.unwrap_or_default();
    let download_urls = request.download_urls.unwrap_or_default();
    state
        .export_track(
            CacheRequest {
                urn: &request.urn,
                urls: &fallback_urls,
                download_urls: &download_urls,
                storage_urls: &storage_urls,
                session_id: request.session_id.as_deref(),
                hq: request.hq,
                liked: false,
                expected_duration_ms: request.duration_ms,
            },
            dest_path,
            cover_url,
        )
        .await
}

#[tauri::command]
pub fn track_is_cached(urn: String, state: State<'_, TrackCacheState>) -> bool {
    state.is_cached(&urn)
}

#[tauri::command]
pub fn track_transcode_status(state: State<'_, TrackCacheState>) -> TranscodeStatus {
    state.transcode_status()
}

#[tauri::command]
pub fn track_get_cache_path(urn: String, state: State<'_, TrackCacheState>) -> Option<String> {
    state.get_cache_path(&urn)
}

#[tauri::command]
pub fn track_get_cache_info(
    urn: String,
    state: State<'_, TrackCacheState>,
) -> Option<TrackCacheEntry> {
    state.get_cache_entry(&urn)
}

#[tauri::command]
pub async fn track_preload(
    entries: Vec<PreloadEntry>,
    state: State<'_, TrackCacheState>,
) -> Result<(), String> {
    let mut queued = 0u32;
    for entry in entries {
        if state.is_cached(&entry.urn) {
            continue;
        }

        let Some(permit) = state.try_acquire_preload_slot() else {
            continue;
        };

        queued += 1;
        let state = state.inner().clone();
        let urn = entry.urn;
        let cover_url = entry.cover_url;
        let fallback_urls: Vec<String> = match (entry.urls, entry.url) {
            (Some(u), _) if !u.is_empty() => u,
            (_, Some(u)) => vec![u],
            _ => continue,
        };
        let storage_urls = entry.storage_urls.unwrap_or_default();
        let download_urls = entry.download_urls.unwrap_or_default();
        let session_id = entry.session_id;
        let hq = entry.hq;
        let duration_ms = entry.duration_ms;

        tokio::spawn(async move {
            let _permit = permit;
            println!("[TrackCache] preloading {urn}");
            if let Err(err) = state
                .ensure_cached(CacheRequest {
                    urn: &urn,
                    urls: &fallback_urls,
                    download_urls: &download_urls,
                    storage_urls: &storage_urls,
                    session_id: session_id.as_deref(),
                    hq,
                    liked: false,
                    expected_duration_ms: duration_ms,
                })
                .await
            {
                eprintln!("[TrackCache] preload {urn}: {err}");
            } else if let Some(url) = cover_url.filter(|url| !url.trim().is_empty()) {
                if let Err(err) =
                    crate::network::image_cache::cache_downloaded_cover(&urn, &url).await
                {
                    eprintln!("[TrackCache] preload cover {urn}: {err}");
                }
            }
        });
    }
    if queued > 0 {
        println!("[TrackCache] queued {queued} preloads");
    }
    Ok(())
}

#[tauri::command]
pub fn track_cache_size(state: State<'_, TrackCacheState>) -> u64 {
    state.cache_size()
}

#[tauri::command]
pub fn track_liked_cache_size(state: State<'_, TrackCacheState>) -> u64 {
    state.liked_cache_size()
}

#[tauri::command]
pub fn track_clear_cache(state: State<'_, TrackCacheState>) {
    state.clear_cache();
    crate::network::image_cache::prune_downloaded_covers(&state.list_cached_urns());
}

#[tauri::command]
pub fn track_remove_cached(urn: String, state: State<'_, TrackCacheState>) -> bool {
    let removed = state.remove_cached(&urn);
    if !state.is_cached(&urn) {
        crate::network::image_cache::remove_downloaded_cover(&urn);
    }
    removed
}

#[tauri::command]
pub fn track_clear_liked_cache(state: State<'_, TrackCacheState>) {
    state.clear_liked_cache();
    crate::network::image_cache::prune_downloaded_covers(&state.list_cached_urns());
}

#[tauri::command]
pub fn track_list_cached(state: State<'_, TrackCacheState>) -> Vec<String> {
    state.list_cached_urns()
}

#[tauri::command]
pub fn track_cache_inventory(state: State<'_, TrackCacheState>) -> Vec<CacheInventoryEntry> {
    state.cache_inventory()
}

#[tauri::command]
pub fn track_enforce_cache_limit(limit_mb: u64, state: State<'_, TrackCacheState>) {
    state.enforce_limit(limit_mb);
    crate::network::image_cache::prune_downloaded_covers(&state.list_cached_urns());
}

#[tauri::command]
pub async fn track_smart_cleanup(
    request: SmartCleanupRequest,
    state: State<'_, TrackCacheState>,
) -> Result<CacheCleanupReport, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let report = state.smart_cleanup(request);
        crate::network::image_cache::prune_downloaded_covers(&state.list_cached_urns());
        report
    })
        .await
        .map_err(|err| format!("cache cleanup task failed: {err}"))
}

#[tauri::command]
pub async fn track_cache_likes(
    entries: Vec<LikeCacheEntry>,
    state: State<'_, TrackCacheState>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tokio::spawn(async move {
        if let Err(err) = state.cache_likes(entries).await {
            eprintln!("[TrackCache] cache_likes error: {err}");
        }
    });
    Ok(())
}

#[tauri::command]
pub fn track_cache_likes_running(state: State<'_, TrackCacheState>) -> bool {
    state.cache_likes_running()
}

#[tauri::command]
pub fn track_cancel_cache_likes(state: State<'_, TrackCacheState>) {
    state.cancel_cache_likes();
}
