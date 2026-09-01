use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use sha2::{Digest, Sha256};
use tokio::fs::{self, File};
use tokio::io::AsyncWriteExt;

use crate::shared::constants::is_domain_whitelisted;

/// Permanent on-disk image cache.
///
/// Lives in `app_data_dir/images/` (NOT cache_dir) so the OS never reclaims
/// the files. The directory is sharded by the first two hex chars of the
/// SHA256 key so we never end up with hundreds of thousands of entries in
/// a single directory.
pub struct ImageCache {
    pub dir: PathBuf,
    /// Covers that belong to downloaded audio. Unlike the ordinary image cache,
    /// these live as long as the matching track and are not touched by image LRU.
    pub downloaded_dir: PathBuf,
    pub http_client: reqwest::Client,
}

pub static STATE: OnceLock<ImageCache> = OnceLock::new();
static WRITE_NONCE: AtomicU64 = AtomicU64::new(0);

pub struct ImageResult {
    pub status: u16,
    pub content_type: String,
    pub data: Vec<u8>,
}

fn cache_key(url: &str) -> String {
    hex::encode(Sha256::digest(url.as_bytes()))
}

fn cache_path(dir: &Path, key: &str) -> PathBuf {
    dir.join(&key[..2]).join(key)
}

fn downloaded_cover_path(state: &ImageCache, urn: &str) -> PathBuf {
    let key = cache_key(urn);
    cache_path(&state.downloaded_dir, &key)
}

fn sniff_content_type(data: &[u8]) -> &'static str {
    if data.len() >= 3 && data[..3] == [0xFF, 0xD8, 0xFF] {
        "image/jpeg"
    } else if data.len() >= 8 && data[..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
        "image/png"
    } else if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        "image/webp"
    } else if data.len() >= 6 && (&data[..6] == b"GIF87a" || &data[..6] == b"GIF89a") {
        "image/gif"
    } else if data.len() >= 12
        && &data[4..8] == b"ftyp"
        && (&data[8..12] == b"avif" || &data[8..12] == b"avis")
    {
        "image/avif"
    } else if data.len() >= 5 && (&data[..5] == b"<?xml" || &data[..4] == b"<svg") {
        "image/svg+xml"
    } else if data.len() >= 4 && data[..4] == [0x00, 0x00, 0x01, 0x00] {
        "image/x-icon"
    } else {
        "application/octet-stream"
    }
}

/// Atomic write: tmp -> fsync -> rename. Survives crashes — we either have
/// the old file or the fully-written new one, never a partial blob.
async fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let tmp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        WRITE_NONCE.fetch_add(1, Ordering::Relaxed)
    ));
    {
        let mut f = File::create(&tmp).await?;
        f.write_all(data).await?;
        f.sync_all().await?;
    }
    if let Err(e) = fs::rename(&tmp, path).await {
        let _ = fs::remove_file(&tmp).await;
        return Err(e);
    }
    Ok(())
}

fn valid_remote_cover_url(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if matches!(host.as_str(), "localhost" | "0.0.0.0" | "::" | "::1") {
        return false;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(ip) => {
                !(ip.is_private()
                    || ip.is_loopback()
                    || ip.is_link_local()
                    || ip.is_unspecified())
            }
            std::net::IpAddr::V6(ip) => {
                !(ip.is_loopback() || ip.is_unspecified() || ip.is_unique_local())
            }
        };
    }
    true
}

/// Persist the cover next to downloaded-track data. A cover failure must never
/// invalidate audio that has already been downloaded, so callers treat errors as
/// best effort and retry when that track is shown or played again.
pub async fn cache_downloaded_cover(urn: &str, url: &str) -> Result<(), String> {
    let Some(state) = STATE.get() else {
        return Err("image cache not ready".into());
    };
    if urn.trim().is_empty() || !valid_remote_cover_url(url) {
        return Err("invalid downloaded cover request".into());
    }

    let path = downloaded_cover_path(state, urn);
    if let Ok(data) = fs::read(&path).await {
        if !data.is_empty() && sniff_content_type(&data).starts_with("image/") {
            return Ok(());
        }
        let _ = fs::remove_file(&path).await;
    }

    const MAX_COVER_BYTES: u64 = 12 * 1024 * 1024;
    let response = state
        .http_client
        .get(url)
        .header("User-Agent", crate::network::wallpapers::BROWSER_UA)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!("cover HTTP {}", response.status().as_u16()));
    }
    if response.content_length().is_some_and(|size| size > MAX_COVER_BYTES) {
        return Err("cover is too large".into());
    }
    let data = response.bytes().await.map_err(|err| err.to_string())?;
    if data.is_empty() || data.len() as u64 > MAX_COVER_BYTES {
        return Err("cover is empty or too large".into());
    }
    if !sniff_content_type(&data).starts_with("image/") {
        return Err("cover response is not an image".into());
    }
    write_atomic(&path, &data)
        .await
        .map_err(|err| err.to_string())
}

pub fn remove_downloaded_cover(urn: &str) {
    let Some(state) = STATE.get() else { return };
    let _ = std::fs::remove_file(downloaded_cover_path(state, urn));
}

/// Remove covers whose audio no longer exists. Ordinary image cleanup never
/// enters `downloaded_dir`; lifecycle is tied only to the downloaded tracks.
pub fn prune_downloaded_covers(active_urns: &[String]) {
    let Some(state) = STATE.get() else { return };
    let active = active_urns
        .iter()
        .map(|urn| cache_key(urn))
        .collect::<std::collections::HashSet<_>>();
    let Ok(shards) = std::fs::read_dir(&state.downloaded_dir) else {
        return;
    };
    for shard in shards.flatten() {
        if !shard.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(shard.path()) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !active.contains(&name) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        let _ = std::fs::remove_dir(shard.path());
    }
}

/// Serve a downloaded track's cover by URN. The optional original URL is used
/// only to backfill covers for tracks downloaded by older Lomify versions.
pub async fn handle_downloaded(encoded: &str) -> ImageResult {
    let payload = match decode_payload(encoded) {
        Ok(payload) => payload,
        Err(result) => return result,
    };
    let Some(urn) = payload.first().filter(|value| !value.trim().is_empty()) else {
        return ImageResult {
            status: 400,
            content_type: "text/plain".into(),
            data: b"missing urn".to_vec(),
        };
    };
    let Some(state) = STATE.get() else {
        return ImageResult {
            status: 503,
            content_type: "text/plain".into(),
            data: b"not ready".to_vec(),
        };
    };
    let path = downloaded_cover_path(state, urn);
    if let Ok(data) = fs::read(&path).await {
        if !data.is_empty() {
            return ImageResult {
                status: 200,
                content_type: sniff_content_type(&data).to_string(),
                data,
            };
        }
    }

    if let Some(url) = payload.get(1).filter(|value| !value.is_empty()) {
        if cache_downloaded_cover(urn, url).await.is_ok() {
            if let Ok(data) = fs::read(&path).await {
                return ImageResult {
                    status: 200,
                    content_type: sniff_content_type(&data).to_string(),
                    data,
                };
            }
        }
    }

    ImageResult {
        status: 404,
        content_type: "text/plain".into(),
        data: b"downloaded cover not found".to_vec(),
    }
}

fn decode_payload(encoded: &str) -> Result<Vec<String>, ImageResult> {
    let decoded = urlencoding::decode(encoded).unwrap_or_default();
    let bytes = BASE64.decode(decoded.as_bytes()).map_err(|_| ImageResult {
        status: 400,
        content_type: "text/plain".into(),
        data: b"invalid base64".to_vec(),
    })?;
    serde_json::from_slice(&bytes).map_err(|_| ImageResult {
        status: 400,
        content_type: "text/plain".into(),
        data: b"invalid payload".to_vec(),
    })
}

pub async fn handle(encoded: &str) -> ImageResult {
    let state = match STATE.get() {
        Some(s) => s,
        None => {
            return ImageResult {
                status: 503,
                content_type: "text/plain".into(),
                data: b"not ready".to_vec(),
            }
        }
    };

    let payload = match decode_payload(encoded) {
        Ok(p) => p,
        Err(r) => return r,
    };

    let target_url = match payload.first() {
        Some(s) if !s.is_empty() => s.clone(),
        _ => {
            return ImageResult {
                status: 400,
                content_type: "text/plain".into(),
                data: b"missing target".to_vec(),
            }
        }
    };
    let upstreams = &payload[1..];
    if upstreams.is_empty() {
        return ImageResult {
            status: 400,
            content_type: "text/plain".into(),
            data: b"missing upstream".to_vec(),
        };
    }

    let host = target_url
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .and_then(|authority| authority.split(':').next())
        .unwrap_or("");
    if is_domain_whitelisted(host) {
        return ImageResult {
            status: 403,
            content_type: "text/plain".into(),
            data: b"whitelisted domain".to_vec(),
        };
    }

    let key = cache_key(&target_url);
    let path = cache_path(&state.dir, &key);

    if let Ok(data) = fs::read(&path).await {
        if !data.is_empty() {
            #[cfg(debug_assertions)]
            println!("[ImageCache] HIT  {}", target_url);
            let ct = sniff_content_type(&data).to_string();
            return ImageResult {
                status: 200,
                content_type: ct,
                data,
            };
        }
        let _ = fs::remove_file(&path).await;
    }

    #[cfg(debug_assertions)]
    println!("[ImageCache] MISS {}", target_url);

    let encoded_for_header = BASE64.encode(target_url.as_bytes());
    let mut status = 502u16;
    let mut data: Vec<u8> = Vec::new();

    for upstream in upstreams {
        let resp = match state
            .http_client
            .get(upstream)
            .header("X-Target", &encoded_for_header)
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => continue,
        };

        status = resp.status().as_u16();
        match resp.bytes().await {
            Ok(b) => data = b.to_vec(),
            Err(_) => continue,
        }

        if status < 500 {
            break;
        }
    }

    let content_type = if status == 200 && !data.is_empty() {
        sniff_content_type(&data).to_string()
    } else {
        String::new()
    };

    if status == 200 && !data.is_empty() && content_type.starts_with("image/") {
        let path_clone = path.clone();
        let data_clone = data.clone();
        tokio::spawn(async move {
            if let Err(e) = write_atomic(&path_clone, &data_clone).await {
                #[cfg(debug_assertions)]
                eprintln!("[ImageCache] write failed: {}", e);
                let _ = e;
            }
        });
    }

    ImageResult {
        status,
        content_type,
        data,
    }
}

/* ── Maintenance commands (size / clear) ─────────────────── */

async fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(p) = stack.pop() {
        let mut entries = match fs::read_dir(&p).await {
            Ok(e) => e,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(ft) = entry.file_type().await else {
                continue;
            };
            if ft.is_dir() {
                stack.push(entry.path());
            } else if ft.is_file() {
                if let Ok(meta) = entry.metadata().await {
                    total = total.saturating_add(meta.len());
                }
            }
        }
    }
    total
}

#[tauri::command]
pub async fn image_cache_size() -> u64 {
    let Some(state) = STATE.get() else { return 0 };
    dir_size(&state.dir).await
}

#[tauri::command]
pub async fn image_cache_clear() -> Result<(), String> {
    let Some(state) = STATE.get() else {
        return Err("image cache not ready".into());
    };
    let dir = state.dir.clone();
    if let Err(e) = fs::remove_dir_all(&dir).await {
        if e.kind() != std::io::ErrorKind::NotFound {
            return Err(e.to_string());
        }
    }
    fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePruneRequest {
    #[serde(default)]
    protected_urls: Vec<String>,
    max_age_days: u64,
    limit_mb: u64,
}

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePruneReport {
    removed_files: u32,
    freed_bytes: u64,
}

/// Remove old cover images without touching covers used by likes, the current
/// track, or recently played tracks. Afterwards apply an LRU-ish size quota to
/// the remaining unprotected files.
#[tauri::command]
pub async fn image_cache_prune(request: ImagePruneRequest) -> Result<ImagePruneReport, String> {
    let Some(state) = STATE.get() else {
        return Err("image cache not ready".into());
    };
    let protected = request
        .protected_urls
        .iter()
        .map(|url| cache_key(url))
        .collect::<std::collections::HashSet<_>>();
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(
            request.max_age_days.saturating_mul(24 * 60 * 60),
        ))
        .unwrap_or(UNIX_EPOCH);
    let limit_bytes = request.limit_mb.saturating_mul(1024 * 1024);
    let mut report = ImagePruneReport::default();
    let mut total = 0u64;
    let mut candidates: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    let mut stack = vec![state.dir.clone()];

    while let Some(dir) = stack.pop() {
        let mut entries = match fs::read_dir(&dir).await {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(file_type) = entry.file_type().await else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(entry.path());
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

            let path = entry.path();
            let Ok(metadata) = entry.metadata().await else {
                continue;
            };
            let size = metadata.len();
            let last_used = metadata
                .accessed()
                .or_else(|_| metadata.modified())
                .unwrap_or(UNIX_EPOCH);
            let key = entry.file_name().to_string_lossy().into_owned();
            let is_protected = protected.contains(&key);
            let stale = request.max_age_days > 0 && last_used < cutoff;

            if stale && !is_protected {
                if fs::remove_file(&path).await.is_ok() {
                    report.removed_files = report.removed_files.saturating_add(1);
                    report.freed_bytes = report.freed_bytes.saturating_add(size);
                }
                continue;
            }

            total = total.saturating_add(size);
            if !is_protected {
                candidates.push((path, size, last_used));
            }
        }
    }

    if limit_bytes > 0 && total > limit_bytes {
        candidates.sort_by_key(|entry| entry.2);
        for (path, size, _) in candidates {
            if total <= limit_bytes {
                break;
            }
            if fs::remove_file(&path).await.is_ok() {
                total = total.saturating_sub(size);
                report.removed_files = report.removed_files.saturating_add(1);
                report.freed_bytes = report.freed_bytes.saturating_add(size);
            }
        }
    }

    Ok(report)
}
