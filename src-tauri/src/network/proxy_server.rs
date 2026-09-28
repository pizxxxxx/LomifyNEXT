use std::net::SocketAddr;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use warp::hyper::Body;
use warp::Filter;

use crate::network::image_cache;
use crate::network::proxy::{cache_control_for, proxy_request};
use crate::network::server::cors;

pub async fn start() -> u16 {
    let rockium_route = warp::path("rockium")
        .and(warp::path::end())
        .map(|| {
            if !crate::rockium::is_server_enabled() || !crate::rockium::is_bridge_enabled() {
                return warp::http::Response::builder()
                    .status(404)
                    .header("Content-Type", "application/json; charset=utf-8")
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Cache-Control", "no-cache, no-store, must-revalidate")
                    .body(Body::from(r#"{"error":"Rockium HTTP API is disabled in settings"}"#))
                    .unwrap();
            }
            let snapshot = crate::rockium::get_current_snapshot();
            let json = match snapshot {
                Some(mut s) => {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    s.updated_at = now;
                    serde_json::to_string(&s).unwrap_or_else(|_| "{}".into())
                }
                None => {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    serde_json::json!({
                        "version": 1,
                        "title": "",
                        "artist": "",
                        "playing": false,
                        "position": 0.0,
                        "duration": 0.0,
                        "lyrics": "",
                        "artwork": "",
                        "artwork_status": "idle",
                        "offset": 0.0,
                        "updated_at": now
                    }).to_string()
                }
            };
            warp::http::Response::builder()
                .status(200)
                .header("Content-Type", "application/json; charset=utf-8")
                .header("Access-Control-Allow-Origin", "*")
                .header("Cache-Control", "no-cache, no-store, must-revalidate")
                .body(Body::from(json))
                .unwrap()
        });

    let now_playing_route = warp::path("now-playing")
        .and(warp::path::end())
        .map(|| {
            if !crate::rockium::is_server_enabled() || !crate::rockium::is_bridge_enabled() {
                return warp::http::Response::builder()
                    .status(404)
                    .header("Content-Type", "application/json; charset=utf-8")
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Cache-Control", "no-cache, no-store, must-revalidate")
                    .body(Body::from(r#"{"error":"Rockium HTTP API is disabled in settings"}"#))
                    .unwrap();
            }
            let snapshot = crate::rockium::get_current_snapshot();
            let port = crate::rockium::get_api_port();
            let json = match snapshot {
                Some(s) => serde_json::json!({
                    "title": s.title,
                    "artist": s.artist,
                    "playing": s.playing,
                    "position": s.position,
                    "duration": s.duration,
                    "offset": s.offset,
                    "lyrics": s.lyrics,
                    "artwork": s.artwork,
                    "cover_url": if port > 0 && !s.artwork.is_empty() { format!("http://127.0.0.1:{}/cover", port) } else { String::new() },
                    "updated_at": s.updated_at
                }).to_string(),
                None => {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    serde_json::json!({
                        "title": "",
                        "artist": "",
                        "playing": false,
                        "position": 0.0,
                        "duration": 0.0,
                        "offset": 0.0,
                        "lyrics": "",
                        "artwork": "",
                        "cover_url": "",
                        "updated_at": now
                    }).to_string()
                }
            };
            warp::http::Response::builder()
                .status(200)
                .header("Content-Type", "application/json; charset=utf-8")
                .header("Access-Control-Allow-Origin", "*")
                .header("Cache-Control", "no-cache, no-store, must-revalidate")
                .body(Body::from(json))
                .unwrap()
        });

    let cover_route = warp::path("cover")
        .and(warp::path::end())
        .map(|| {
            if !crate::rockium::is_server_enabled() || !crate::rockium::is_bridge_enabled() {
                return warp::http::Response::builder()
                    .status(404)
                    .header("Content-Type", "text/plain; charset=utf-8")
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Cache-Control", "no-cache, no-store, must-revalidate")
                    .body(Body::from("Rockium HTTP API is disabled in settings"))
                    .unwrap();
            }
            let snapshot = crate::rockium::get_current_snapshot();
            if let Some(s) = snapshot {
                if !s.artwork.is_empty() {
                    let encoded = s.artwork.strip_prefix("data:image/png;base64,").unwrap_or(&s.artwork);
                    let clean: String = encoded.chars().filter(|c| !c.is_whitespace()).collect();
                    if let Ok(bytes) = BASE64.decode(&clean) {
                        return warp::http::Response::builder()
                            .status(200)
                            .header("Content-Type", "image/png")
                            .header("Cache-Control", "no-cache, no-store, must-revalidate")
                            .header("Access-Control-Allow-Origin", "*")
                            .body(Body::from(bytes))
                            .unwrap();
                    }
                }
            }
            warp::http::Response::builder()
                .status(404)
                .header("Content-Type", "text/plain")
                .header("Access-Control-Allow-Origin", "*")
                .body(Body::from("No cover"))
                .unwrap()
        });

    let artwork_route = warp::path("artwork")
        .and(warp::path::end())
        .map(|| {
            if !crate::rockium::is_server_enabled() || !crate::rockium::is_bridge_enabled() {
                return warp::http::Response::builder()
                    .status(404)
                    .header("Content-Type", "text/plain; charset=utf-8")
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Cache-Control", "no-cache, no-store, must-revalidate")
                    .body(Body::from("Rockium HTTP API is disabled in settings"))
                    .unwrap();
            }
            let snapshot = crate::rockium::get_current_snapshot();
            if let Some(s) = snapshot {
                if !s.artwork.is_empty() {
                    let encoded = s.artwork.strip_prefix("data:image/png;base64,").unwrap_or(&s.artwork);
                    let clean: String = encoded.chars().filter(|c| !c.is_whitespace()).collect();
                    if let Ok(bytes) = BASE64.decode(&clean) {
                        return warp::http::Response::builder()
                            .status(200)
                            .header("Content-Type", "image/png")
                            .header("Cache-Control", "no-cache, no-store, must-revalidate")
                            .header("Access-Control-Allow-Origin", "*")
                            .body(Body::from(bytes))
                            .unwrap();
                    }
                }
            }
            warp::http::Response::builder()
                .status(404)
                .header("Content-Type", "text/plain")
                .header("Access-Control-Allow-Origin", "*")
                .body(Body::from("No cover"))
                .unwrap()
        });

    let lyrics_route = warp::path("lyrics")
        .and(warp::path::end())
        .and(warp::header::optional::<String>("accept"))
        .and(warp::query::<std::collections::HashMap<String, String>>())
        .map(|accept: Option<String>, query: std::collections::HashMap<String, String>| {
            if !crate::rockium::is_server_enabled() || !crate::rockium::is_bridge_enabled() {
                return warp::http::Response::builder()
                    .status(404)
                    .header("Content-Type", "text/plain; charset=utf-8")
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Cache-Control", "no-cache, no-store, must-revalidate")
                    .body(Body::from("Rockium HTTP API is disabled in settings"))
                    .unwrap();
            }
            let snapshot = crate::rockium::get_current_snapshot();
            let want_json = query.get("format").map(|f| f == "json").unwrap_or(false)
                || accept.as_deref().unwrap_or("").contains("application/json");

            if want_json {
                let json = match snapshot {
                    Some(s) => serde_json::json!({
                        "title": s.title,
                        "artist": s.artist,
                        "playing": s.playing,
                        "position": s.position,
                        "duration": s.duration,
                        "offset": s.offset,
                        "lyrics": s.lyrics,
                        "synced": !s.lyrics.is_empty() && s.lyrics.contains('[')
                    }).to_string(),
                    None => serde_json::json!({
                        "title": "",
                        "artist": "",
                        "playing": false,
                        "position": 0.0,
                        "duration": 0.0,
                        "offset": 0.0,
                        "lyrics": "",
                        "synced": false
                    }).to_string()
                };
                warp::http::Response::builder()
                    .status(200)
                    .header("Content-Type", "application/json; charset=utf-8")
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Cache-Control", "no-cache, no-store, must-revalidate")
                    .body(Body::from(json))
                    .unwrap()
            } else {
                let text = snapshot.map(|s| s.lyrics).unwrap_or_default();
                warp::http::Response::builder()
                    .status(200)
                    .header("Content-Type", "text/plain; charset=utf-8")
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Cache-Control", "no-cache, no-store, must-revalidate")
                    .body(Body::from(text))
                    .unwrap()
            }
        });

    let proxy_route =
        warp::path("p")
            .and(warp::path::tail())
            .and_then(|tail: warp::path::Tail| async move {
                let encoded_url = tail.as_str();
                let result = proxy_request(encoded_url).await;
                Ok::<_, warp::Rejection>(
                    warp::http::Response::builder()
                        .status(result.status)
                        .header("Content-Type", &result.content_type)
                        .header("Cache-Control", cache_control_for(result.status))
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Body::from(result.data))
                        .unwrap(),
                )
            });

    let image_route =
        warp::path("img")
            .and(warp::path::tail())
            .and_then(|tail: warp::path::Tail| async move {
                let encoded = tail.as_str();
                let result = image_cache::handle(encoded).await;
                Ok::<_, warp::Rejection>(
                    warp::http::Response::builder()
                        .status(result.status)
                        .header("Content-Type", &result.content_type)
                        .header("Cache-Control", cache_control_for(result.status))
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Body::from(result.data))
                        .unwrap(),
                )
            });

    let downloaded_cover_route =
        warp::path("downloaded-cover")
            .and(warp::path::tail())
            .and_then(|tail: warp::path::Tail| async move {
                let result = image_cache::handle_downloaded(tail.as_str()).await;
                Ok::<_, warp::Rejection>(
                    warp::http::Response::builder()
                        .status(result.status)
                        .header("Content-Type", &result.content_type)
                        .header("Cache-Control", cache_control_for(result.status))
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Body::from(result.data))
                        .unwrap(),
                )
            });

    let routes = rockium_route
        .or(lyrics_route)
        .or(now_playing_route)
        .or(cover_route)
        .or(artwork_route)
        .or(downloaded_cover_route)
        .or(image_route)
        .or(proxy_route)
        .with(cors());

    let preferred_port: u16 = 52289;
    let port = match std::net::TcpListener::bind(("127.0.0.1", preferred_port)) {
        Ok(listener) => {
            drop(listener);
            preferred_port
        }
        Err(_) => 0,
    };

    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let (addr, server) = warp::serve(routes).bind_ephemeral(addr);
    tokio::spawn(server);

    let actual_port = addr.port();
    crate::rockium::set_api_port(actual_port);
    println!("[ProxyServer] http://127.0.0.1:{}", actual_port);
    actual_port
}
