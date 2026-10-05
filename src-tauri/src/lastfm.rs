use std::collections::BTreeMap;
use std::time::Duration;
use std::sync::atomic::{AtomicU64, Ordering};
use md5::{Digest, Md5};
use serde_json::Value;
use crate::secrets::{save_verified, with_vault, SecretVault};

const API_URL: &str = "https://ws.audioscrobbler.com/2.0/";
static AUTH_GENERATION: AtomicU64 = AtomicU64::new(0);

pub(crate) fn invalidate_authorization() { AUTH_GENERATION.fetch_add(1, Ordering::SeqCst); }

fn signature(params: &BTreeMap<String, String>, secret: &str) -> String {
    let mut hash = Md5::new();
    for (key, value) in params {
        if key != "format" && key != "callback" && key != "api_sig" {
            hash.update(key.as_bytes());
            hash.update(value.as_bytes());
        }
    }
    hash.update(secret.as_bytes());
    format!("{:x}", hash.finalize())
}

fn validate(method: &str, api_key: &str, params: &BTreeMap<String, String>) -> Result<(), String> {
    if api_key.len() != 32 || !api_key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Некорректный API key Last.fm".into());
    }
    let allowed: &[&str] = match method {
        "auth.getToken" | "auth.getSession" => &[],
        "track.updateNowPlaying" => &["artist", "track", "album", "duration"],
        "track.scrobble" => &["artist", "track", "album", "duration", "timestamp"],
        _ => return Err("Этот метод Last.fm не разрешён".into()),
    };
    if params.iter().any(|(key, value)| !allowed.contains(&key.as_str()) || value.len() > 4096) {
        return Err("Некорректные параметры Last.fm".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn lastfm_signed_request(
    app: tauri::AppHandle, window: tauri::WebviewWindow,
    method: String, api_key: String, mut params: BTreeMap<String, String>,
) -> Result<Value, String> {
    if window.label() != "main" { return Err("Доступ к Last.fm запрещён".into()); }
    validate(&method, &api_key, &params)?;
    let pending = method.starts_with("auth.");
    let get_session = method == "auth.getSession";
    let generation = AUTH_GENERATION.load(Ordering::SeqCst);
    let (secret, credential) = with_vault(app.clone(), move |vault| {
        let secret_key = if pending { "lastfm_pending_shared_secret" } else { "lastfm_shared_secret" };
        let secret = vault.read(secret_key)?.ok_or("Сначала подключи Last.fm")?;
        let credential = if get_session { vault.read("lastfm_auth_token")? }
            else if !pending { vault.read("lastfm_session_key")? } else { None };
        Ok((secret, credential))
    }).await?;
    if get_session {
        params.insert("token".into(), credential.clone().ok_or("Подтверждение Last.fm истекло")?);
    } else if !pending {
        params.insert("sk".into(), credential.ok_or("Сначала подключи Last.fm")?);
    }
    params.insert("method".into(), method.clone());
    params.insert("api_key".into(), api_key);
    params.insert("api_sig".into(), signature(&params, &secret));
    params.insert("format".into(), "json".into());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20)).redirect(reqwest::redirect::Policy::none())
        .build().map_err(|_| "Не удалось подготовить запрос Last.fm")?;
    let response = client.post(API_URL).form(&params).send().await
        .map_err(|_| "Нет связи с Last.fm. Проверь подключение, VPN или прокси")?;
    let status = response.status();
    let mut body: Value = response.json().await.map_err(|_| "Last.fm вернул непонятный ответ")?;
    if !status.is_success() || body.get("error").is_some() {
        let message = match body.get("error").and_then(Value::as_u64) {
            Some(4 | 9) => "Last.fm отклонил сессию. Подключи аккаунт заново",
            Some(14) => "Last.fm ещё не получил разрешение. Подтверди доступ в браузере",
            _ => "Last.fm не выполнил запрос. Проверь подключение и повтори позже",
        };
        return Err(message.into());
    }
    if pending {
        let expected_token = params.get("token").cloned();
        let response_token = body.get("token").and_then(Value::as_str).map(String::from);
        let session_key = body.get("session").and_then(|session| session.get("key")).and_then(Value::as_str).map(String::from);
        let session_name = body.get("session").and_then(|session| session.get("name")).and_then(Value::as_str).unwrap_or("").to_string();
        with_vault(app, move |vault| {
            if AUTH_GENERATION.load(Ordering::SeqCst) != generation
                || vault.read("lastfm_pending_shared_secret")?.as_deref() != Some(&secret)
                || (get_session && vault.read("lastfm_auth_token")? != expected_token) {
                return Err("Подключение Last.fm отменено".into());
            }
            if get_session {
                let key = session_key.filter(|key| !key.is_empty()).ok_or("Last.fm не вернул ключ сессии")?;
                if session_name.is_empty() { return Err("Last.fm не вернул имя аккаунта".into()); }
                let old_secret = vault.read("lastfm_shared_secret")?;
                let old_key = vault.read("lastfm_session_key")?;
                let saved = save_verified(vault, "lastfm_shared_secret", &secret)
                    .and_then(|_| save_verified(vault, "lastfm_session_key", &key));
                if saved.is_err() {
                    for (name, old) in [("lastfm_shared_secret", old_secret), ("lastfm_session_key", old_key)] {
                        if let Some(value) = old { let _ = save_verified(vault, name, &value); }
                        else { let _ = vault.remove(name); }
                    }
                }
                saved?;
            } else {
                let token = response_token.filter(|token| !token.is_empty()).ok_or("Last.fm не вернул код подтверждения")?;
                save_verified(vault, "lastfm_auth_token", &token)?;
            }
            Ok(())
        }).await?;
        // Session keys never cross back into the webview.
        if let Some(session) = body.get_mut("session").and_then(Value::as_object_mut) { session.remove("key"); }
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signature_uses_sorted_utf8_fields_and_excludes_transport_fields() {
        let mut params = BTreeMap::from([("method".into(), "auth.getToken".into()), ("api_key".into(), "public".into())]);
        let expected = format!("{:x}", Md5::digest(b"api_keypublicmethodauth.getTokenfake-secret"));
        assert_eq!(signature(&params, "fake-secret"), expected);
        params.insert("format".into(), "json".into());
        params.insert("callback".into(), "ignored".into());
        params.insert("api_sig".into(), "ignored".into());
        assert_eq!(signature(&params, "fake-secret"), expected);
        params.insert("artist".into(), "Артист".into());
        assert_ne!(signature(&params, "fake-secret"), expected);
    }
    #[test]
    fn private_requests_reject_arbitrary_methods_and_credentials_in_parameters() {
        let key = "0123456789abcdef0123456789abcdef";
        assert!(validate("auth.getToken", key, &BTreeMap::new()).is_ok());
        assert!(validate("user.changePassword", key, &BTreeMap::new()).is_err());
        assert!(validate("track.scrobble", key, &BTreeMap::from([("sk".into(), "fake-injected".into())])).is_err());
    }
}
