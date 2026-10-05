use std::sync::Mutex;
use std::path::Path;
use tauri::Manager;
use tauri_plugin_keyring_store::{KeyringExt, KeyringStore};

const KEYS: &[&str] = &[
    "yandex_music_token", "spotify_access_token", "spotify_refresh_token",
    "lastfm_shared_secret", "lastfm_session_key", "lastfm_auth_token",
    "lastfm_pending_shared_secret", "legacy_auth_session", "legacy_sc_session",
];
static SECRET_LOCK: Mutex<()> = Mutex::new(());

pub(crate) trait SecretVault {
    fn read(&self, key: &str) -> Result<Option<String>, String>;
    fn write(&self, key: &str, value: &str) -> Result<(), String>;
    fn remove(&self, key: &str) -> Result<(), String>;
}

impl SecretVault for KeyringStore {
    fn read(&self, key: &str) -> Result<Option<String>, String> {
        let value = self.get_password(key).map_err(|_| "Не удалось прочитать системное хранилище".to_string())?;
        if let Some(ref value) = value { crate::shared::log_redaction::remember_secret(value); }
        Ok(value)
    }
    fn write(&self, key: &str, value: &str) -> Result<(), String> {
        crate::shared::log_redaction::remember_secret(value);
        self.set_password(key, value).map_err(|_| "Не удалось записать в системное хранилище".into())
    }
    fn remove(&self, key: &str) -> Result<(), String> {
        self.delete(key).map_err(|_| "Не удалось удалить секрет из системного хранилища".into())
    }
}

pub(crate) fn save_verified(vault: &impl SecretVault, key: &str, value: &str) -> Result<(), String> {
    vault.write(key, value)?;
    if vault.read(key)?.as_deref() != Some(value) {
        return Err("Проверка записи в системное хранилище не прошла".into());
    }
    Ok(())
}

fn check_key(window: &tauri::WebviewWindow, key: &str) -> Result<(), String> {
    if window.label() != "main" || !KEYS.contains(&key) || key.starts_with("legacy_") {
        return Err("Доступ к этому секрету запрещён".into());
    }
    Ok(())
}

pub(crate) async fn with_vault<T: Send + 'static>(
    app: tauri::AppHandle,
    operation: impl FnOnce(&KeyringStore) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let store = app.keyring().store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SECRET_LOCK.lock().map_err(|_| "Системное хранилище занято".to_string())?;
        operation(&store)
    }).await.map_err(|_| "Ошибка системного хранилища".to_string())?
}

#[tauri::command]
pub async fn secret_save(app: tauri::AppHandle, window: tauri::WebviewWindow, key: String, value: String) -> Result<(), String> {
    check_key(&window, &key)?;
    if value.is_empty() || value.len() > 16_384 { return Err("Некорректный секрет".into()); }
    with_vault(app, move |vault| save_verified(vault, &key, &value)).await
}

#[tauri::command]
pub async fn secret_get(app: tauri::AppHandle, window: tauri::WebviewWindow, key: String) -> Result<Option<String>, String> {
    check_key(&window, &key)?;
    with_vault(app, move |vault| vault.read(&key)).await
}

#[tauri::command]
pub async fn secret_delete(app: tauri::AppHandle, window: tauri::WebviewWindow, key: String) -> Result<(), String> {
    check_key(&window, &key)?;
    with_vault(app, move |vault| {
        vault.remove(&key)?;
        if vault.read(&key)?.is_some() { return Err("Удаление секрета не подтверждено".into()); }
        Ok(())
    }).await
}

const LEGACY_FILES: &[(&str, &str)] = &[
    ("auth_session.json", "legacy_auth_session"),
    ("sc-auth.json", "legacy_sc_session"),
];

pub(crate) fn migrate_legacy_file(vault: &impl SecretVault, path: &Path, key: &str) -> Result<(), String> {
    if !path.exists() { return Ok(()); }
    let bytes = std::fs::read(path).map_err(|_| "Не удалось прочитать старый файл аккаунта".to_string())?;
    let data: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Старый файл аккаунта повреждён. Копия сохранена".to_string())?;
    let candidate = data.get("token").or_else(|| data.get("state")?.get("sessionId"));
    match candidate {
        Some(serde_json::Value::String(token)) => {
            if !token.is_empty() && token != "null" && token != "undefined" { save_verified(vault, key, token)?; }
        },
        Some(serde_json::Value::Null) => {},
        _ => return Err("Старый файл аккаунта не распознан. Копия сохранена".into()),
    }
    std::fs::remove_file(path).map_err(|_| "Секрет сохранён, но старый файл удалить не удалось".to_string())
}

#[tauri::command]
pub async fn secret_migrate_legacy(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    check_key(&window, "yandex_music_token")?;
    let dir = app.path().app_data_dir().map_err(|_| "Не удалось найти папку аккаунта".to_string())?;
    with_vault(app, move |vault| {
        // Process each source independently, so one unreadable file cannot hide another.
        let mut failed = false;
        for (file, key) in LEGACY_FILES {
            if migrate_legacy_file(vault, &dir.join(file), key).is_err() { failed = true; }
        }
        if failed { Err("Перенос старых файлов аккаунта не завершён. Неудалённые копии сохранены".into()) }
        else { Ok(()) }
    }).await
}

#[tauri::command]
pub async fn secret_clear_legacy(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    check_key(&window, "yandex_music_token")?;
    let dir = app.path().app_data_dir().map_err(|_| "Не удалось найти папку аккаунта".to_string())?;
    with_vault(app, move |vault| {
        for (_, key) in LEGACY_FILES {
            vault.remove(key)?;
            if vault.read(key)?.is_some() { return Err("Удаление старого секрета не подтверждено".into()); }
        }
        for (file, _) in LEGACY_FILES {
            match std::fs::remove_file(dir.join(file)) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err("Не удалось удалить старый файл аккаунта".into()),
                _ => {},
            }
        }
        Ok(())
    }).await
}
