//! Локальный OAuth callback для Spotify.
//!
//! Desktop-приложение не может безопасно хранить Client Secret, поэтому фронтенд использует
//! Authorization Code + PKCE. Spotify возвращает одноразовый `code` на loopback-адрес, а
//! этот модуль на несколько минут поднимает узкий HTTP-listener только на `127.0.0.1` и
//! передаёт результат главному окну событием. Токены здесь не проходят и не сохраняются.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const CALLBACK_PATH: &str = "/callback";
const CALLBACK_PORT: u16 = 43_827;
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyOauthStart {
    pub redirect_uri: String,
}

#[derive(Clone, Debug, Default, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyOauthCallback {
    pub code: Option<String>,
    pub error: Option<String>,
    pub state: Option<String>,
}

fn parse_callback_target(target: &str) -> Result<SpotifyOauthCallback, String> {
    let url = url::Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|e| format!("не удалось разобрать callback: {e}"))?;
    if url.path() != CALLBACK_PATH {
        return Err("неизвестный путь callback".into());
    }

    let mut result = SpotifyOauthCallback::default();
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => result.code = Some(value.into_owned()),
            "error" => result.error = Some(value.into_owned()),
            "state" => result.state = Some(value.into_owned()),
            _ => {}
        }
    }

    if result.code.is_none() && result.error.is_none() {
        return Err("Spotify не вернул ни code, ни error".into());
    }
    Ok(result)
}

fn write_browser_response(stream: &mut TcpStream, ok: bool) {
    let (status, title, message) = if ok {
        (
            "200 OK",
            "Spotify подключён",
            "Можно закрыть эту вкладку и вернуться в LomifyNEXT.",
        )
    } else {
        (
            "400 Bad Request",
            "Подключение не завершено",
            "Вернитесь в LomifyNEXT и попробуйте ещё раз.",
        )
    };
    let body = format!(
        "<!doctype html><html lang=\"ru\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{title}</title><style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#121212;color:#fff;font:16px system-ui,sans-serif}}main{{max-width:32rem;padding:2rem;text-align:center}}i{{display:grid;place-items:center;width:4rem;height:4rem;margin:0 auto 1rem;border-radius:1.25rem;background:#1ed760;color:#101010;font-style:normal;font-size:2rem}}h1{{font-size:1.45rem}}p{{color:#b3b3b3;line-height:1.55}}</style><main><i>✓</i><h1>{title}</h1><p>{message}</p></main><script>setTimeout(()=>window.close(),1200)</script></html>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn handle_connection(stream: &mut TcpStream) -> Result<SpotifyOauthCallback, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    let mut bytes = [0_u8; 8192];
    let read = stream.read(&mut bytes).map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&bytes[..read]);
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "пустой HTTP callback".to_string())?;
    parse_callback_target(target)
}

/// Начинает один OAuth-сеанс на фиксированном loopback URI. Dashboard должен содержать
/// ровно `http://127.0.0.1:43827/callback` — без совпадающего порта он помечает URI как
/// небезопасный ещё до сохранения настроек приложения.
#[tauri::command]
pub fn spotify_oauth_start(app: AppHandle) -> Result<SpotifyOauthStart, String> {
    let listener = TcpListener::bind(("127.0.0.1", CALLBACK_PORT)).map_err(|e| {
        format!(
            "порт Spotify callback {CALLBACK_PORT} занят; закрой другое окно LomifyNEXT и повтори: {e}"
        )
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("не удалось настроить callback: {e}"))?;
    let redirect_uri = format!("http://127.0.0.1:{CALLBACK_PORT}{CALLBACK_PATH}");

    std::thread::spawn(move || {
        let deadline = Instant::now() + CALLBACK_TIMEOUT;
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => match handle_connection(&mut stream) {
                    Ok(payload) => {
                        write_browser_response(&mut stream, payload.error.is_none());
                        let _ = app.emit("spotify:oauth-callback", payload);
                        return;
                    }
                    Err(error) => {
                        write_browser_response(&mut stream, false);
                        let _ = app.emit(
                            "spotify:oauth-callback",
                            SpotifyOauthCallback {
                                error: Some(error),
                                ..Default::default()
                            },
                        );
                        return;
                    }
                },
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(80));
                }
                Err(error) => {
                    let _ = app.emit(
                        "spotify:oauth-callback",
                        SpotifyOauthCallback {
                            error: Some(format!("локальный callback остановлен: {error}")),
                            ..Default::default()
                        },
                    );
                    return;
                }
            }
        }

        let _ = app.emit(
            "spotify:oauth-callback",
            SpotifyOauthCallback {
                error: Some("Время входа в Spotify истекло".into()),
                ..Default::default()
            },
        );
    });

    Ok(SpotifyOauthStart { redirect_uri })
}

#[cfg(test)]
mod tests {
    use super::{parse_callback_target, SpotifyOauthCallback};

    #[test]
    fn parses_success_callback_and_decodes_values() {
        assert_eq!(
            parse_callback_target("/callback?code=abc%2B123&state=state-1").unwrap(),
            SpotifyOauthCallback {
                code: Some("abc+123".into()),
                error: None,
                state: Some("state-1".into()),
            }
        );
    }

    #[test]
    fn parses_denied_callback() {
        assert_eq!(
            parse_callback_target("/callback?error=access_denied&state=x").unwrap(),
            SpotifyOauthCallback {
                code: None,
                error: Some("access_denied".into()),
                state: Some("x".into()),
            }
        );
    }

    #[test]
    fn rejects_wrong_path_or_empty_result() {
        assert!(parse_callback_target("/favicon.ico").is_err());
        assert!(parse_callback_target("/callback?state=x").is_err());
    }
}
