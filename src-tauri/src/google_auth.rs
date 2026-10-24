use std::{io::Read, net::TcpListener, time::{Duration, Instant}};
use crate::auth_browser::{self, AuthProvider, AuthResult};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn google_sign_in_available() -> bool {
    option_env!("LOMIFY_GOOGLE_DESKTOP_CLIENT_ID").is_some() && option_env!("LOMIFY_GOOGLE_DESKTOP_CLIENT_SECRET").is_some()
}

fn callback(target: &str, expected_state: &str) -> Result<String, &'static str> {
    if !target.starts_with("/google-callback?") { return Err("wrong-path"); }
    let url = url::Url::parse(&format!("http://127.0.0.1{target}")).map_err(|_| "bad-request")?;
    let values: Vec<_> = url.query_pairs().collect();
    if values.iter().filter(|(key, _)| key == "state").count() != 1 || values.iter().find(|(key, _)| key == "state").map(|(_, value)| value.as_ref()) != Some(expected_state) { return Err("wrong-state"); }
    if values.iter().any(|(key, _)| key == "error") { return Err("denied"); }
    let codes: Vec<_> = values.iter().filter(|(key, _)| key == "code").collect();
    if codes.len() != 1 || codes[0].1.is_empty() || codes[0].1.len() > 4096 { return Err("bad-code"); }
    Ok(codes[0].1.to_string())
}

#[tauri::command]
pub async fn google_sign_in(app: tauri::AppHandle, window: tauri::WebviewWindow, client_id: String, state: String, verifier: String) -> Result<String, String> {
    if window.label() != "main" { return Err("Вход доступен только в главном окне.".into()); }
    let secret = option_env!("LOMIFY_GOOGLE_DESKTOP_CLIENT_SECRET").ok_or("Вход Google ещё не подключён в этой сборке. Войди по почте и паролю.")?;
    if option_env!("LOMIFY_GOOGLE_DESKTOP_CLIENT_ID") != Some(client_id.as_str()) { return Err("Не совпадает настройка входа Google. Войди по почте и паролю.".into()); }
    crate::shared::log_redaction::remember_secret(secret);
    if client_id.len() > 200 || !client_id.ends_with(".apps.googleusercontent.com") || !client_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
        || !(43..=128).contains(&verifier.len()) || !verifier.chars().all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c))
        || !(32..=128).contains(&state.len()) || !state.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Подключение входа Google ещё не настроено.".into());
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|_| "Не удалось открыть окно входа Google.".to_string())?;
    listener.set_nonblocking(true).map_err(|_| "Не удалось подготовить вход Google.")?;
    let port = listener.local_addr().map_err(|_| "Не удалось подготовить вход Google.")?.port();
    let redirect = format!("http://127.0.0.1:{port}/google-callback");
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut authorize = url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
    authorize.query_pairs_mut().extend_pairs([
        ("client_id", client_id.as_str()), ("redirect_uri", redirect.as_str()), ("response_type", "code"),
        ("scope", "openid email"), ("state", state.as_str()), ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"), ("prompt", "select_account"),
    ]);
    app.opener().open_url(authorize.as_str(), None::<&str>).map_err(|_| "Не удалось открыть браузер. Повтори вход Google.".to_string())?;
    let code = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let deadline = Instant::now() + Duration::from_secs(180);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                    let mut bytes = [0u8; 8192];
                    let Ok(size) = stream.read(&mut bytes) else { continue; };
                    let request = String::from_utf8_lossy(&bytes[..size]);
                    let Some(line) = request.lines().next() else { continue; };
                    let mut segments = line.split_whitespace();
                    if segments.next() != Some("GET") { continue; }
                    let result = callback(segments.next().unwrap_or(""), &state);
                    let page = match &result { Ok(_) => AuthResult::Received, Err(reason) if *reason == "denied" => AuthResult::Cancelled, _ => AuthResult::Invalid };
                    let _ = auth_browser::write_response(&mut stream, AuthProvider::Google, page);
                    match result {
                        Ok(code) => return Ok(code),
                        Err("denied") => return Err("Вход Google отменён. Данные не изменены.".into()),
                        _ => continue, // Invalid unrelated traffic cannot consume the valid attempt.
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(80)),
                Err(_) => return Err("Не удалось получить ответ Google. Повтори вход.".into()),
            }
        }
        Err("Время входа Google истекло. Нажми Войти через Google ещё раз.".into())
    }).await.map_err(|_| "Вход Google прерван.".to_string())??;
    crate::shared::log_redaction::remember_secret(&code);
    let client = reqwest::Client::builder().timeout(Duration::from_secs(25)).build().map_err(|_| "Не удалось подготовить вход Google.")?;
    let response = client.post("https://oauth2.googleapis.com/token").form(&[
        ("client_id", client_id.as_str()), ("client_secret", secret), ("code", code.as_str()), ("code_verifier", verifier.as_str()),
        ("redirect_uri", redirect.as_str()), ("grant_type", "authorization_code"),
    ]).send().await.map_err(|_| "Нет связи с Google. Проверь интернет и повтори вход.".to_string())?;
    if !response.status().is_success() { return Err("Google не подтвердил вход. Проверь настройку Desktop app в проекте и повтори попытку.".into()); }
    let result: serde_json::Value = response.json().await.map_err(|_| "Не удалось прочитать ответ Google.".to_string())?;
    let token = result["id_token"].as_str().filter(|value| value.len() <= 16384).ok_or("Google не вернул подтверждение входа.")?;
    crate::shared::log_redaction::remember_secret(token);
    Ok(token.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn google_callback_rejects_forgery_duplicate_parameters_and_wrong_paths() {
        assert_eq!(callback("/google-callback?state=expected&code=ok%2Bcode", "expected"), Ok("ok+code".into()));
        for target in ["/wrong?state=expected&code=x", "/google-callback?state=other&code=x", "/google-callback?state=expected&state=other&code=x", "/google-callback?state=expected&code=x&code=y", "/google-callback?state=expected"] { assert!(callback(target, "expected").is_err()); }
        assert_eq!(callback("/google-callback?state=expected&error=access_denied", "expected"), Err("denied"));
    }
}
