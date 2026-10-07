//! Public SoundCloud GET fallback after the system-proxy transport fails.
use std::{sync::OnceLock, time::Duration};
use super::direct_fetch::DirectFetchResponse;

const MAX_BODY: usize = 16 * 1024 * 1024;
fn allowed(url: &reqwest::Url) -> bool {
    let host = url.host_str().unwrap_or_default();
    url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && ["soundcloud.com", "sndcdn.com"].iter().any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().no_proxy()
        .connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 3 || !allowed(attempt.url()) { attempt.stop() } else { attempt.follow() }
        })).build().map_err(|_| "Не удалось подготовить соединение SoundCloud.".to_owned()))
        .as_ref().map_err(Clone::clone)
}

#[tauri::command]
pub async fn soundcloud_fetch_text(url: String) -> Result<DirectFetchResponse, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Некорректный адрес SoundCloud.")?;
    if !allowed(&parsed) { return Err("Для этого запроса разрешены только HTTPS-адреса SoundCloud.".into()); }
    let mut response = client()?.get(parsed)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36")
        .header("Referer", "https://soundcloud.com/").header("Origin", "https://soundcloud.com")
        .header("Accept-Language", "ru,en;q=0.8")
        .send().await.map_err(|_| "Прямое соединение SoundCloud не ответило.".to_owned())?;
    let status = response.status().as_u16();
    if response.content_length().is_some_and(|size| size > MAX_BODY as u64) { return Err("Ответ SoundCloud слишком большой.".into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Не удалось дочитать ответ SoundCloud.".to_owned())? {
        if bytes.len() + chunk.len() > MAX_BODY { return Err("Ответ SoundCloud слишком большой.".into()); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(DirectFetchResponse { status, body: String::from_utf8_lossy(&bytes).into_owned() })
}

#[cfg(test)]
mod tests {
    use super::allowed;
    #[test]
    fn only_public_https_service_hosts() {
        for raw in ["https://soundcloud.com/", "https://api-v2.soundcloud.com/tracks", "https://cf-hls-media.sndcdn.com/audio"] {
            assert!(allowed(&reqwest::Url::parse(raw).unwrap()));
        }
        for raw in ["http://soundcloud.com/", "https://soundcloud.com.evil.test/", "https://evilsoundcloud.com/", "https://soundcloud.com:444/", "https://user:pass@soundcloud.com/", "https://127.0.0.1/", "https://evil.test/?soundcloud.com"] {
            assert!(!allowed(&reqwest::Url::parse(raw).unwrap()));
        }
    }

    #[tokio::test]
    #[ignore = "live SoundCloud search and a small audio range; reports only success"]
    async fn live_search_and_audio_range() {
        use super::{soundcloud_fetch_text, client};
        let site = soundcloud_fetch_text("https://soundcloud.com/".into()).await.unwrap();
        assert_eq!(site.status, 200, "SoundCloud website unavailable");
        let scripts = regex::Regex::new(r#"src="(https://a-v2\.sndcdn\.com/[^" ]+\.js)""#).unwrap();
        let ids = regex::Regex::new(r#"client_id\s*:\s*"([a-zA-Z0-9]{32})""#).unwrap();
        let mut client_id = None;
        for capture in scripts.captures_iter(&site.body).collect::<Vec<_>>().into_iter().rev().take(6) {
            let script = soundcloud_fetch_text(capture[1].into()).await.unwrap();
            if let Some(capture) = ids.captures(&script.body) { client_id = Some(capture[1].to_owned()); break; }
        }
        let client_id = client_id.expect("Public client ID not found in current SoundCloud scripts");
        let search = soundcloud_fetch_text(format!("https://api-v2.soundcloud.com/search/tracks?q=Daft%20Punk&limit=10&client_id={client_id}")).await.unwrap();
        assert_eq!(search.status, 200, "SoundCloud search unavailable");
        let data: serde_json::Value = serde_json::from_str(&search.body).unwrap();
        let mut selected = None;
        for track in data["collection"].as_array().expect("Search returned no collection") {
            if track["policy"] == "BLOCK" || track["policy"] == "SNIP" { continue; }
            if let Some(transcodings) = track["media"]["transcodings"].as_array() {
                let transcoding = transcodings.iter().find(|item| item["format"]["protocol"] == "progressive").or_else(|| transcodings.first());
                if let Some(item) = transcoding { selected = Some((item.clone(), track["track_authorization"].as_str().unwrap_or_default().to_owned())); break; }
            }
        }
        let (transcoding, authorization) = selected.expect("No playable public track returned");
        let mut resolve = reqwest::Url::parse(transcoding["url"].as_str().unwrap()).unwrap();
        resolve.query_pairs_mut().append_pair("client_id", &client_id);
        if !authorization.is_empty() { resolve.query_pairs_mut().append_pair("track_authorization", &authorization); }
        let resolved = soundcloud_fetch_text(resolve.to_string()).await.unwrap();
        assert_eq!(resolved.status, 200, "SoundCloud stream resolution unavailable");
        let stream: serde_json::Value = serde_json::from_str(&resolved.body).unwrap();
        let mut audio = reqwest::Url::parse(stream["url"].as_str().expect("No audio URL")).unwrap();
        assert!(super::allowed(&audio));
        if transcoding["format"]["protocol"] == "hls" {
            let manifest = soundcloud_fetch_text(audio.to_string()).await.unwrap();
            assert_eq!(manifest.status, 200);
            let segment = manifest.body.lines().find(|line| !line.trim().is_empty() && !line.starts_with('#')).expect("No HLS segment");
            audio = audio.join(segment).unwrap();
            assert!(super::allowed(&audio));
        }
        let response = client().unwrap().get(audio).header("Range", "bytes=0-4095").send().await.unwrap();
        assert!(response.status().is_success(), "Audio range request failed");
        let mut response = response;
        assert!(!response.chunk().await.unwrap().unwrap_or_default().is_empty(), "Empty audio data");
    }
}
